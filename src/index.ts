import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from "aws-lambda";
import * as z from "zod";
import { GitHubClient, verifySignature, type RunnerDownload, type WorkflowJobEvent } from "./github.ts";
import { JobStore } from "./jobs.ts";
import { JobConfigError, hasTriggerLabel, parseLabels } from "./labels.ts";
import {
  ALL_STATES,
  TAG_JOB,
  TAG_REPO,
  TAG_RUN,
  TAG_RUNNER,
  TAG_STACK,
  assertInstanceTypesExist,
  deleteStaleLaunchTemplateVersions,
  launchRunner,
  listRunnerInstances,
  resolveAmi,
  terminateInstances,
  type Ami,
} from "./ec2.ts";
import { availableRunners, parseRunnerName, runnerName, unmatchedJobs, type QueuedJob } from "./pool.ts";
import { buildUserData } from "./userdata.ts";

// The template sets these on all three functions. AWS_REGION comes from the
// Lambda runtime. Parsed at cold start, so a missing value fails every
// invocation with the variable's name.
const env = z
  .object({
    AWS_REGION: z.string().min(1),
    SECRET_ARN: z.string().min(1),
    GITHUB_ORG: z.string().min(1),
    TRIGGER_LABEL: z.string().min(1),
    RUNNER_GROUP_ID: z.coerce.number().int().positive(),
    // The stack name. Prefixes runner names and tags the stack's instances.
    RUNNER_PREFIX: z.string().min(1),
    RECONCILER_FUNCTION: z.string().min(1),
    JOBS_TABLE: z.string().min(1),
    ALERT_TOPIC_ARN: z.string().min(1),
    LAUNCH_TEMPLATE_ID: z.string().min(1),
    LAUNCH_TEMPLATE_VERSION: z.string().min(1),
    SUBNET_IDS: z.string().min(1).transform((s) => s.split(",")),
    CACHE_BUCKET: z.string().min(1),
    IDLE_MINUTES: z.coerce.number().positive(),
    MAX_MINUTES: z.coerce.number().positive(),
    AMI_OWNER: z.string().min(1),
    AMI_NAME_PREFIX: z.string().min(1),
    RUNNER_VERSION: z.string().min(1),
    ALLOW_PUBLIC_REPOS: z.stringbool(),
  })
  .parse(process.env);

// A runner registration with no instance counts as a launch in progress for
// this long. The reconciler's 5 minute timeout bounds a real launch.
const LAUNCH_GRACE_MS = 10 * 60_000;
// Launches the reconciler runs at once.
const LAUNCH_CONCURRENCY = 8;
// A job that fails to launch this many times, for example for lack of
// capacity, triggers one alert. Later reconciles keep retrying it.
const ALERT_AFTER_FAILURES = 3;

const ec2 = new EC2Client({});
const lambda = new LambdaClient({});
const secrets = new SecretsManagerClient({});
const sns = new SNSClient({});
const jobs = new JobStore(new DynamoDBClient({}), env.JOBS_TABLE);

const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...fields }));

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function alert(subject: string, message: string): Promise<void> {
  // SNS limits subjects to 100 characters.
  await sns.send(new PublishCommand({ TopicArn: env.ALERT_TOPIC_ARN, Subject: subject.slice(0, 100), Message: message }));
}

// A value the deploy left as the template's "REPLACE_ME" placeholder.
const filledIn = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("REPLACE"), "still the REPLACE_ME placeholder");

// The JSON stored in the GitHub App secret. See README, step 3.
const AppSecret = z.object({
  appId: z.union([z.string(), z.int()]).transform(String).pipe(filledIn),
  privateKey: filledIn,
  webhookSecret: filledIn,
});
type AppSecret = z.infer<typeof AppSecret>;

let cachedSecret: AppSecret | undefined;
async function loadSecret(): Promise<AppSecret> {
  if (cachedSecret) return cachedSecret;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: env.SECRET_ARN }));
  const parsed = AppSecret.safeParse(JSON.parse(res.SecretString ?? "{}"));
  if (!parsed.success) {
    throw new Error(`Secret ${env.SECRET_ARN} is incomplete. See README, step 3.\n${z.prettifyError(parsed.error)}`);
  }
  cachedSecret = parsed.data;
  return cachedSecret;
}

let cachedGitHub: GitHubClient | undefined;
async function github(): Promise<GitHubClient> {
  if (cachedGitHub) return cachedGitHub;
  const s = await loadSecret();
  cachedGitHub = new GitHubClient({ appId: s.appId, privateKey: s.privateKey, org: env.GITHUB_ORG });
  return cachedGitHub;
}

// The reconciler always looks at the whole queue, so its invocation carries no payload.
async function invokeReconciler(reason: string): Promise<void> {
  await lambda.send(new InvokeCommand({ FunctionName: env.RECONCILER_FUNCTION, InvocationType: "Event" }));
  log("invoked reconciler", { reason });
}

// Lambda function URL handler. Verifies the delivery, records the job's state
// in the jobs table, and invokes the reconciler asynchronously, so GitHub gets
// a response well inside its 10 second delivery timeout. Function URLs use the
// API Gateway HTTP API (v2) event and response format.
export async function webhook(event: LambdaFunctionURLEvent): Promise<APIGatewayProxyStructuredResultV2> {
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");

  const { webhookSecret } = await loadSecret();
  if (!(await verifySignature(webhookSecret, rawBody, headers["x-hub-signature-256"]))) {
    log("rejected delivery with invalid signature", { delivery: headers["x-github-delivery"] });
    return { statusCode: 401, body: "invalid signature" };
  }

  const eventName = headers["x-github-event"];
  if (eventName !== "workflow_job") return { statusCode: 200, body: `ignored ${eventName}` };

  // The signature proves GitHub sent this body, so it has the documented shape.
  const payload = JSON.parse(rawBody) as WorkflowJobEvent;
  const job = payload.workflow_job;
  if (payload.organization?.login.toLowerCase() !== env.GITHUB_ORG.toLowerCase()) {
    return { statusCode: 200, body: "ignored: other org" };
  }
  if (!hasTriggerLabel(job.labels, env.TRIGGER_LABEL)) return { statusCode: 200, body: "ignored: no trigger label" };

  switch (payload.action) {
    case "queued": {
      // Public repositories accept pull requests from forks, whose code would
      // get write access to the cache bucket that every repository's jobs read.
      if (!payload.repository.private && !env.ALLOW_PUBLIC_REPOS) {
        log("ignored job from public repository", { repo: payload.repository.full_name, jobId: job.id });
        return { statusCode: 200, body: "ignored: public repository" };
      }
      try {
        parseLabels(job.labels, env.TRIGGER_LABEL);
      } catch (err) {
        if (!(err instanceof JobConfigError)) throw err;
        log("invalid job labels", { jobId: job.id, labels: job.labels, error: err.message });
        await alert(`Invalid runner labels in ${payload.repository.full_name}`, `${job.html_url}\n\n${err.message}`);
        return { statusCode: 200, body: `invalid labels: ${err.message}` };
      }
      await jobs.markQueued({ jobId: job.id, repo: payload.repository.full_name, runId: job.run_id, labels: job.labels });
      await invokeReconciler(`job ${job.id} queued`);
      return { statusCode: 202, body: "queued" };
    }
    case "in_progress": {
      await jobs.markDone(job.id);
      // A job that starts on a runner launched for a different job can leave
      // that other job without a runner it fits.
      const launchedFor = parseRunnerName(env.RUNNER_PREFIX, job.runner_name ?? "")?.jobId;
      if (launchedFor !== undefined && launchedFor !== job.id) {
        await invokeReconciler(`job ${job.id} started on a runner launched for job ${launchedFor}`);
        return { statusCode: 202, body: "reconciling" };
      }
      return { statusCode: 200, body: "recorded start" };
    }
    case "completed":
      await jobs.markDone(job.id);
      return { statusCode: 200, body: "recorded completion" };
    default:
      return { statusCode: 200, body: `ignored ${payload.action}` };
  }
}

type LaunchOutcome = "launched" | "already started" | "failed" | "will retry";

// Invoked asynchronously by the webhook and every 5 minutes by a schedule.
// The function's reserved concurrency is 1, so reconciles never overlap and
// each one sees the runners the previous one registered.
//
// Compares the queued jobs with the runners that could still take them and
// launches a runner for each job that the available runners cannot cover.
export async function reconciler(): Promise<{ queued: number; available: number; outcomes: Record<string, LaunchOutcome> }> {
  const now = Date.now();
  const gh = await github();
  const [queued, registrations, instances] = await Promise.all([
    jobs.listQueued(),
    gh.listRunners(`${env.RUNNER_PREFIX}-`),
    listRunnerInstances(ec2, env.RUNNER_PREFIX, ALL_STATES),
  ]);
  const available = availableRunners({ prefix: env.RUNNER_PREFIX, registrations, instances, now, graceMs: LAUNCH_GRACE_MS });
  const uncovered = unmatchedJobs(queued, available);

  const outcomes: Record<string, LaunchOutcome> = {};
  await forEachLimit(uncovered, LAUNCH_CONCURRENCY, async (job) => {
    outcomes[job.jobId] = await launchForJob(gh, job);
  });
  log("reconciled", { queued: queued.length, available: available.length, outcomes });
  return { queued: queued.length, available: available.length, outcomes };
}

// Runs fn over items with at most `limit` calls in flight.
async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Registers a just-in-time runner for one queued job and launches its
// instance. Any job whose labels the runner has can end up on it.
async function launchForJob(gh: GitHubClient, job: QueuedJob): Promise<LaunchOutcome> {
  // The jobs table can miss an "in_progress" or "completed" event, so GitHub
  // decides whether the job still needs a runner.
  const current = await gh.getJob(job.repo, job.jobId);
  if (current.status === "in_progress" || current.status === "completed") {
    await jobs.markDone(job.jobId);
    return "already started";
  }

  try {
    const spec = parseLabels(job.labels, env.TRIGGER_LABEL);
    if (!spec) throw new JobConfigError(`labels lack the trigger label: ${job.labels.join(", ")}`);
    // Everything that can reject the job's labels runs before the runner is
    // registered, so a bad label leaves no registration behind.
    const ami = await resolveAmi(ec2, spec.image, { owner: env.AMI_OWNER, namePrefix: env.AMI_NAME_PREFIX });
    await assertInstanceTypesExist(ec2, spec, ami);
    const runner = await runnerDownload(gh, ami);

    const name = runnerName(env.RUNNER_PREFIX, job.jobId);
    const jit = await gh.generateJitConfig({ name, labels: job.labels, runnerGroupId: env.RUNNER_GROUP_ID });
    try {
      const result = await launchRunner(ec2, {
        launchTemplateId: env.LAUNCH_TEMPLATE_ID,
        sourceVersion: env.LAUNCH_TEMPLATE_VERSION,
        subnetIds: env.SUBNET_IDS,
        spec,
        ami,
        userData: buildUserData({
          jitConfig: jit.encoded_jit_config,
          cacheBucket: env.CACHE_BUCKET,
          region: env.AWS_REGION,
          maxMinutes: env.MAX_MINUTES,
          runner,
        }),
        tags: {
          Name: name,
          [TAG_STACK]: env.RUNNER_PREFIX,
          [TAG_RUNNER]: name,
          [TAG_REPO]: job.repo,
          [TAG_RUN]: job.runId,
          [TAG_JOB]: job.jobId,
        },
        log: (m) => console.log(m),
      });
      log("launched runner", { name, repo: job.repo, jobId: job.jobId, ...result, spec });
      return "launched";
    } catch (err) {
      // An unlaunched registration would count as an available runner.
      await gh.deleteRunner(jit.runner.id).catch((e) => log("failed to delete runner after launch error", { name, error: errorMessage(e) }));
      throw err;
    }
  } catch (err) {
    if (err instanceof JobConfigError) {
      log("job cannot launch", { jobId: job.jobId, repo: job.repo, error: err.message });
      if (await jobs.markFailed(job.jobId, err.message)) {
        await alert(`Runner labels cannot launch in ${job.repo}`, `${current.html_url}\n\n${err.message}`);
      }
      return "failed";
    }
    const failures = await jobs.recordLaunchFailure(job.jobId);
    log("launch failed, will retry", { jobId: job.jobId, repo: job.repo, failures, error: errorMessage(err) });
    if (failures === ALERT_AFTER_FAILURES) {
      await alert(
        `Runner launch keeps failing in ${job.repo}`,
        `${current.html_url}\n\nFailed ${failures} times. The reconciler keeps retrying every 5 minutes.\n\n${errorMessage(err)}`,
      );
    }
    return "will retry";
  }
}

// The runner tarball for each AMI architecture, looked up at most hourly.
const downloads = new Map<string, { download: RunnerDownload; at: number }>();
async function runnerDownload(gh: GitHubClient, ami: Ami): Promise<RunnerDownload> {
  const arch = ami.architecture === "arm64" ? "arm64" : "x64";
  const cached = downloads.get(arch);
  if (cached && Date.now() - cached.at < 60 * 60_000) return cached.download;
  const download = await gh.runnerDownload(env.RUNNER_VERSION, arch);
  downloads.set(arch, { download, at: Date.now() });
  return download;
}

// Runs on a schedule. Terminates instances that outlived the max lifetime or
// never picked up a job, removes stale runner registrations, and deletes
// launch template versions that a stopped reconciler left behind.
export async function janitor(): Promise<{ terminated: string[]; removedRunners: string[]; deletedVersions: string[] }> {
  const now = Date.now();
  const idleMs = env.IDLE_MINUTES * 60_000;
  const maxMs = (env.MAX_MINUTES + 5) * 60_000;
  const gh = await github();

  const [allInstances, runners] = await Promise.all([
    listRunnerInstances(ec2, env.RUNNER_PREFIX, ALL_STATES),
    gh.listRunners(`${env.RUNNER_PREFIX}-`),
  ]);
  const runnersByName = new Map(runners.map((r) => [r.name, r]));
  const instances = allInstances.filter((i) => i.state === "pending" || i.state === "running");

  const toTerminate: string[] = [];
  for (const inst of instances) {
    const age = now - inst.launchTime.getTime();
    const runner = inst.runnerName === undefined ? undefined : runnersByName.get(inst.runnerName);
    if (age > maxMs) {
      toTerminate.push(inst.instanceId);
      log("terminating instance past max lifetime", { ...inst, ageMinutes: Math.round(age / 60_000) });
    } else if (age > idleMs && !runner?.busy) {
      toTerminate.push(inst.instanceId);
      log("terminating idle instance", { ...inst, ageMinutes: Math.round(age / 60_000), runnerStatus: runner?.status ?? "missing" });
    }
  }
  await terminateInstances(ec2, toTerminate);

  // A registration is stale when its instance has ended or was just
  // terminated, or when it never got an instance within the launch grace
  // period because the reconciler stopped partway through a launch.
  const withInstance = new Set(allInstances.map((i) => i.runnerName));
  const live = new Set(instances.filter((i) => !toTerminate.includes(i.instanceId)).map((i) => i.runnerName));
  const stale = runners.filter((r) => {
    if (r.busy || live.has(r.name)) return false;
    if (withInstance.has(r.name)) return true;
    const parsed = parseRunnerName(env.RUNNER_PREFIX, r.name);
    return parsed !== undefined && now - parsed.launchedAt > LAUNCH_GRACE_MS;
  });
  for (const r of stale) {
    await gh.deleteRunner(r.id).catch((e) => log("failed to delete stale runner", { name: r.name, error: errorMessage(e) }));
  }

  // A launch finishes within the reconciler's 5 minute timeout, so an
  // hour-old version is unused.
  const deletedVersions = await deleteStaleLaunchTemplateVersions(ec2, {
    launchTemplateId: env.LAUNCH_TEMPLATE_ID,
    runnerPrefix: env.RUNNER_PREFIX,
    maxAgeMs: 60 * 60_000,
    now,
  }).catch((e) => {
    log("failed to delete stale launch template versions", { error: errorMessage(e) });
    return [];
  });

  log("janitor done", {
    instances: instances.length,
    terminated: toTerminate.length,
    staleRunnersRemoved: stale.length,
    launchTemplateVersionsDeleted: deletedVersions.length,
  });
  return { terminated: toTerminate, removedRunners: stale.map((r) => r.name), deletedVersions };
}
