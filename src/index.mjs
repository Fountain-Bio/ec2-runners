import { EC2Client } from "@aws-sdk/client-ec2";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GitHubApiError, GitHubClient, verifySignature } from "./github.mjs";
import { parseLabels } from "./labels.mjs";
import { TAG_RUNNER, TAG_STACK, launchRunner, listRunnerInstances, resolveAmi, terminateInstances } from "./ec2.mjs";
import { buildUserData } from "./userdata.mjs";

const env = process.env;
const ec2 = new EC2Client({});
const lambda = new LambdaClient({});
const secrets = new SecretsManagerClient({});

const log = (msg, fields = {}) => console.log(JSON.stringify({ msg, ...fields }));

let cachedSecret;
async function loadSecret() {
  if (cachedSecret) return cachedSecret;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: env.SECRET_ARN }));
  const parsed = JSON.parse(res.SecretString);
  for (const key of ["appId", "privateKey", "webhookSecret"]) {
    if (!parsed[key] || String(parsed[key]).startsWith("REPLACE")) {
      throw new Error(`Secret ${env.SECRET_ARN} is missing "${key}". See README, step 3.`);
    }
  }
  cachedSecret = parsed;
  return parsed;
}

let cachedGitHub;
async function github() {
  if (cachedGitHub) return cachedGitHub;
  const s = await loadSecret();
  cachedGitHub = new GitHubClient({ appId: s.appId, privateKey: s.privateKey, org: env.GITHUB_ORG });
  return cachedGitHub;
}

const runnerName = (jobId) => `${env.RUNNER_PREFIX}-${jobId}`;

// Lambda function URL handler. Verifies the delivery, filters to queued jobs
// that asked for an EC2 runner, and hands off to the launcher asynchronously so
// GitHub gets a response well inside its 10 second delivery timeout.
export async function webhook(event) {
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "", "utf8");

  const { webhookSecret } = await loadSecret();
  if (!verifySignature(webhookSecret, rawBody, headers["x-hub-signature-256"])) {
    log("rejected delivery with invalid signature", { delivery: headers["x-github-delivery"] });
    return { statusCode: 401, body: "invalid signature" };
  }

  const eventName = headers["x-github-event"];
  if (eventName !== "workflow_job") return { statusCode: 200, body: `ignored ${eventName}` };

  const payload = JSON.parse(rawBody.toString("utf8"));
  const job = payload.workflow_job;
  if (payload.action !== "queued") return { statusCode: 200, body: `ignored ${payload.action}` };
  if (payload.organization?.login?.toLowerCase() !== env.GITHUB_ORG.toLowerCase()) {
    return { statusCode: 200, body: "ignored: other org" };
  }

  let spec;
  try {
    spec = parseLabels(job.labels, env.TRIGGER_LABEL);
  } catch (err) {
    log("invalid job labels", { jobId: job.id, labels: job.labels, error: err.message });
    return { statusCode: 200, body: `invalid labels: ${err.message}` };
  }
  if (!spec) return { statusCode: 200, body: "ignored: no trigger label" };

  const request = { jobId: job.id, runId: job.run_id, repo: payload.repository.full_name, labels: job.labels };
  await lambda.send(
    new InvokeCommand({
      FunctionName: env.LAUNCHER_FUNCTION,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(request)),
    }),
  );
  log("queued launch", request);
  return { statusCode: 202, body: "launching" };
}

// Async-invoked by the webhook. Lambda retries async failures twice.
export async function launcher(request) {
  const spec = parseLabels(request.labels, env.TRIGGER_LABEL);
  const name = runnerName(request.jobId);
  const gh = await github();

  let jit;
  try {
    jit = await gh.generateJitConfig({ name, labels: request.labels, runnerGroupId: Number(env.RUNNER_GROUP_ID) });
  } catch (err) {
    // The runner name is unique per job, so 409 means this job already has a
    // runner (a redelivered webhook or a retried invocation).
    if (err instanceof GitHubApiError && err.status === 409) {
      log("runner already registered for job, skipping", { name });
      return { skipped: true };
    }
    throw err;
  }

  try {
    const ami = await resolveAmi(ec2, spec.image, { owner: env.AMI_OWNER, namePrefix: env.AMI_NAME_PREFIX });
    const userData = buildUserData({
      jitConfig: jit.encoded_jit_config,
      cacheBucket: env.CACHE_BUCKET,
      region: env.AWS_REGION,
      maxMinutes: Number(env.MAX_MINUTES),
      runnerVersion: env.RUNNER_VERSION,
    });
    const result = await launchRunner(ec2, {
      launchTemplateId: env.LAUNCH_TEMPLATE_ID,
      sourceVersion: env.LAUNCH_TEMPLATE_VERSION,
      subnetIds: env.SUBNET_IDS.split(","),
      spec,
      ami,
      userData,
      tags: {
        Name: name,
        [TAG_STACK]: env.RUNNER_PREFIX,
        [TAG_RUNNER]: name,
        "ec2-runners:repo": request.repo,
        "ec2-runners:run-id": request.runId,
        "ec2-runners:job-id": request.jobId,
      },
      log: (m) => console.log(m),
    });
    log("launched runner", { name, repo: request.repo, ...result, spec });
    return result;
  } catch (err) {
    // Remove the registration so a retry can register the same name again.
    await gh.deleteRunner(jit.runner.id).catch((e) => log("failed to delete runner after launch error", { error: e.message }));
    throw err;
  }
}

// Runs on a schedule. Terminates instances that outlived the max lifetime or
// never picked up a job, and removes stale runner registrations.
export async function janitor() {
  const now = Date.now();
  const idleMs = Number(env.IDLE_MINUTES) * 60_000;
  const maxMs = (Number(env.MAX_MINUTES) + 5) * 60_000;
  const gh = await github();

  const [allInstances, runners] = await Promise.all([
    listRunnerInstances(ec2, env.RUNNER_PREFIX, ["pending", "running", "shutting-down", "stopping", "stopped", "terminated"]),
    gh.listRunners(`${env.RUNNER_PREFIX}-`),
  ]);
  const runnersByName = new Map(runners.map((r) => [r.name, r]));
  const instances = allInstances.filter((i) => i.state === "pending" || i.state === "running");

  const toTerminate = [];
  for (const inst of instances) {
    const age = now - inst.launchTime.getTime();
    const runner = runnersByName.get(inst.runnerName);
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
  // terminated. Registrations with no instance at all are left alone: the
  // launcher registers the runner a few seconds before the instance exists,
  // and GitHub removes never-connected JIT runners on its own.
  const ended = new Set(
    allInstances
      .filter((i) => toTerminate.includes(i.instanceId) || !(i.state === "pending" || i.state === "running"))
      .map((i) => i.runnerName),
  );
  const live = new Set(instances.filter((i) => !toTerminate.includes(i.instanceId)).map((i) => i.runnerName));
  const stale = runners.filter((r) => ended.has(r.name) && !live.has(r.name) && !r.busy);
  for (const r of stale) {
    await gh.deleteRunner(r.id).catch((e) => log("failed to delete stale runner", { name: r.name, error: e.message }));
  }
  log("janitor done", { instances: instances.length, terminated: toTerminate.length, staleRunnersRemoved: stale.length });
  return { terminated: toTerminate, removedRunners: stale.map((r) => r.name) };
}
