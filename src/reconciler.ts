// Launches runners for queued jobs that the available runners cannot cover.
//
// Invoked asynchronously by the webhook and every 5 minutes by a schedule.
// The function's reserved concurrency is 1, so reconciles never overlap and
// each one sees the runners the previous one registered.

import { EC2Client } from "@aws-sdk/client-ec2";
import { alert } from "./alerts.ts";
import { github } from "./app-secret.ts";
import { reconcilerConfig, type ReconcilerConfig } from "./config.ts";
import {
  ALL_STATES,
  TAG_JOB,
  TAG_REPO,
  TAG_RUN,
  TAG_RUNNER,
  TAG_STACK,
  assertInstanceTypesExist,
  launchRunner,
  listRunnerInstances,
  resolveAmi,
  type Ami,
} from "./ec2.ts";
import { isGitHubError, type GitHubClient, type RunnerDownload } from "./github.ts";
import { jobStore, type JobStore } from "./jobs.ts";
import { JobConfigError, parseLabels } from "./labels.ts";
import { errorMessage, log } from "./log.ts";
import { LAUNCH_GRACE_MS, availableRunners, runnerName, unmatchedJobs, type QueuedJob } from "./pool.ts";
import { buildUserData } from "./userdata.ts";

// Launches the reconciler runs at once.
const LAUNCH_CONCURRENCY = 8;
// A job that fails to launch this many times, for example for lack of
// capacity, triggers one alert. Later reconciles keep retrying it.
const ALERT_AFTER_FAILURES = 3;

const ec2 = new EC2Client({});

type LaunchOutcome = "launched" | "already started" | "gone" | "failed" | "will retry" | "error";

export async function reconciler(): Promise<{ queued: number; available: number; outcomes: Record<string, LaunchOutcome> }> {
  const config = reconcilerConfig();
  const jobs = jobStore(config.JOBS_TABLE);
  const now = Date.now();
  const gh = await github(config);
  const [queued, registrations, instances] = await Promise.all([
    jobs.listQueued(),
    gh.listRunners(`${config.RUNNER_PREFIX}-`),
    listRunnerInstances(ec2, config.RUNNER_PREFIX, ALL_STATES),
  ]);
  const available = availableRunners({ prefix: config.RUNNER_PREFIX, registrations, instances, now, graceMs: LAUNCH_GRACE_MS });
  const uncovered = unmatchedJobs(queued, available);

  const outcomes: Record<string, LaunchOutcome> = {};
  // Each job's errors stay with that job, so one failure never ends the
  // reconcile while other launches are still running.
  await forEachLimit(uncovered, LAUNCH_CONCURRENCY, async (job) => {
    outcomes[job.jobId] = await reconcileJob(config, jobs, gh, job).catch((err) => {
      log("job reconcile failed, will retry", { jobId: job.jobId, repo: job.repo, error: errorMessage(err) });
      return "error" as const;
    });
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

// Decides what an uncovered queued job needs and records the result: a
// launch, or a failure that is either permanent (bad labels) or retried.
async function reconcileJob(config: ReconcilerConfig, jobs: JobStore, gh: GitHubClient, job: QueuedJob): Promise<LaunchOutcome> {
  // The jobs table can miss an "in_progress" or "completed" event, so GitHub
  // decides whether the job still needs a runner. A 404 means the job's
  // repository was deleted or the app lost access to it.
  const current = await gh.getJob(job.repo, job.jobId).catch((err) => {
    if (isGitHubError(err, 404)) return undefined;
    throw err;
  });
  if (!current) {
    await jobs.markDone(job.jobId);
    return "gone";
  }
  if (current.status === "in_progress" || current.status === "completed") {
    await jobs.markDone(job.jobId);
    return "already started";
  }

  try {
    await launchForJob(config, gh, job);
    return "launched";
  } catch (err) {
    if (err instanceof JobConfigError) {
      log("job cannot launch", { jobId: job.jobId, repo: job.repo, error: err.message });
      if (await jobs.markFailed(job.jobId, err.message)) {
        await alert(config.ALERT_TOPIC_ARN, `Runner labels cannot launch in ${job.repo}`, `${current.html_url}\n\n${err.message}`);
      }
      return "failed";
    }
    const failures = await jobs.recordLaunchFailure(job.jobId);
    log("launch failed, will retry", { jobId: job.jobId, repo: job.repo, failures, error: errorMessage(err) });
    if (failures === ALERT_AFTER_FAILURES) {
      await alert(
        config.ALERT_TOPIC_ARN,
        `Runner launch keeps failing in ${job.repo}`,
        `${current.html_url}\n\nFailed ${failures} times. The reconciler keeps retrying every 5 minutes.\n\n${errorMessage(err)}`,
      );
    }
    return "will retry";
  }
}

// Registers a just-in-time runner for one job and launches its instance. Any
// job whose labels the runner has can end up on it. Throws JobConfigError
// when the job's labels can never launch, and other errors for failures a
// retry may get past, such as a lack of capacity.
async function launchForJob(config: ReconcilerConfig, gh: GitHubClient, job: QueuedJob): Promise<void> {
  const spec = parseLabels(job.labels, config.TRIGGER_LABEL);
  if (!spec) throw new JobConfigError(`labels lack the trigger label: ${job.labels.join(", ")}`);
  // Everything that can reject the job's labels runs before the runner is
  // registered, so a bad label leaves no registration behind.
  const ami = await resolveAmi(ec2, spec.image, { owner: config.AMI_OWNER, namePrefix: config.AMI_NAME_PREFIX });
  await assertInstanceTypesExist(ec2, spec, ami);
  const runner = await runnerDownload(config, gh, ami);

  const name = runnerName(config.RUNNER_PREFIX, job.jobId);
  const jit = await gh.generateJitConfig({ name, labels: job.labels, runnerGroupId: config.RUNNER_GROUP_ID });
  try {
    const result = await launchRunner(ec2, {
      launchTemplateId: config.LAUNCH_TEMPLATE_ID,
      sourceVersion: config.LAUNCH_TEMPLATE_VERSION,
      subnetIds: config.SUBNET_IDS,
      spec,
      ami,
      userData: buildUserData({
        jitConfig: jit.encoded_jit_config,
        cacheBucket: config.CACHE_BUCKET,
        region: config.AWS_REGION,
        maxMinutes: config.MAX_MINUTES,
        runner,
      }),
      tags: {
        Name: name,
        [TAG_STACK]: config.RUNNER_PREFIX,
        [TAG_RUNNER]: name,
        [TAG_REPO]: job.repo,
        [TAG_RUN]: job.runId,
        [TAG_JOB]: job.jobId,
      },
    });
    log("launched runner", { name, repo: job.repo, jobId: job.jobId, ...result, spec });
  } catch (err) {
    // An unlaunched registration would count as an available runner.
    await gh.deleteRunner(jit.runner.id).catch((e) => log("failed to delete runner after launch error", { name, error: errorMessage(e) }));
    throw err;
  }
}

// The runner tarball for each AMI architecture, looked up at most hourly.
const downloads = new Map<string, { download: RunnerDownload; at: number }>();
async function runnerDownload(config: ReconcilerConfig, gh: GitHubClient, ami: Ami): Promise<RunnerDownload> {
  const arch = ami.architecture === "arm64" ? "arm64" : "x64";
  const cached = downloads.get(arch);
  if (cached && Date.now() - cached.at < 60 * 60_000) return cached.download;
  const download = await gh.runnerDownload(config.RUNNER_VERSION, arch);
  downloads.set(arch, { download, at: Date.now() });
  return download;
}
