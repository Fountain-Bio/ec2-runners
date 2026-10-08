// Launches runners for queued jobs that the available runners cannot cover.
//
// Invoked asynchronously by the webhook and every 5 minutes by a schedule.
// Invocations can run at the same time, so each pass runs under the
// ReconcileLock (lock.ts): passes never overlap, and each one sees the runners
// the previous one registered.

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import type { Context } from "aws-lambda";
import { alert } from "./alerts.ts";
import { github } from "./app-secret.ts";
import { reconcilerConfig, type ReconcilerConfig } from "./config.ts";
import {
  assertInstanceTypesExist,
  launchRunner,
  listRunnerInstances,
  resolveAmi,
  terminateInstances,
  type Ami,
} from "./ec2.ts";
import { isGitHubError, type GitHubClient, type RunnerDownload } from "./github.ts";
import { jobStore, type JobStore, type QueuedJob } from "./jobs.ts";
import { JobConfigError, parseLabels } from "./labels.ts";
import { ReconcileLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { LAUNCH_GRACE_MS, availableRunners, matchJobs, retirableRunners, runnerName, type AvailableRunner } from "./pool.ts";
import { buildUserData } from "./userdata.ts";

// Launches the reconciler runs at once.
const LAUNCH_CONCURRENCY = 8;
// A job that fails to launch this many times, for example for lack of
// capacity, triggers one alert. Later reconciles keep retrying it. With
// retries 30 seconds apart, 10 failures take about 5 minutes.
const ALERT_AFTER_FAILURES = 10;
// Passes one invocation runs when launches keep failing. Together with the
// retry delay this bounds how long an invocation retries before leaving the
// job to the next scheduled reconcile.
const MAX_PASSES = 6;
// A job that still waits after this many of its runners sat idle until the
// janitor terminated them is failed, since another runner would idle too.
const MAX_IDLE_RUNNERS = 2;
// A launch takes up to about a minute when EC2 Fleet tries every subnet. The
// reconciler starts no launch with less than this much time left before its
// Lambda timeout, so a timeout never cuts a launch off partway.
const LAUNCH_TIME_BUDGET_MS = 2 * 60_000;
// The lock outlasts the holder's Lambda timeout by this much, so a holder that
// crashes blocks other reconciles only briefly. Without a Lambda context, as in
// tests, the hold lasts the reconciler's 5 minute timeout.
const LOCK_MARGIN_MS = 30_000;
const DEFAULT_HOLD_MS = 5 * 60_000;
// How long the reconciler caches the runner group's public-repository
// setting and the runner tarball lookup.
const CACHE_MS = 60 * 60_000;

const ec2 = new EC2Client({});
let cachedLock: ReconcileLock | undefined;

type LaunchOutcome = "launched" | "already started" | "gone" | "failed" | "will retry" | "error" | "deferred";

// The schedule passes an EventBridge event and the webhook passes none; the
// reconciler reads neither. The context is absent in tests.
type PassResult = { queued: number; available: number; outcomes: Record<string, LaunchOutcome>; retired: string[] };

// Returns undefined when another invocation is reconciling; that invocation
// runs another pass for this one.
export async function reconciler(_event?: unknown, context?: Pick<Context, "getRemainingTimeInMillis">): Promise<PassResult | undefined> {
  const config = reconcilerConfig();
  const lock = (cachedLock ??= new ReconcileLock(new DynamoDBClient({}), config.JOBS_TABLE));
  const remaining = () => context?.getRemainingTimeInMillis() ?? DEFAULT_HOLD_MS;
  const result = await lock.runExclusive({
    holder: randomUUID(),
    holdUntil: Date.now() + remaining() + LOCK_MARGIN_MS,
    pass: () => reconcileUntilLaunched(config, context, remaining),
    canRunAgain: () => remaining() > LAUNCH_TIME_BUDGET_MS,
  });
  if (!result) log("another reconcile holds the lock; it will run a pass for this request");
  return result;
}

// Runs passes until no launch failed for a reason a retry may get past, such
// as Spot capacity or a vCPU quota that a finishing job frees up. Retrying here,
// RECONCILE_RETRY_SECONDS apart, gets such a job its runner well before the
// next scheduled reconcile, which can be 5 minutes away.
async function reconcileUntilLaunched(
  config: ReconcilerConfig,
  context: Pick<Context, "getRemainingTimeInMillis"> | undefined,
  remaining: () => number,
): Promise<PassResult> {
  const retryMs = config.RECONCILE_RETRY_SECONDS * 1000;
  let result = await reconcilePass(config, context);
  for (let pass = 1; pass < MAX_PASSES && launchFailed(result) && remaining() > LAUNCH_TIME_BUDGET_MS + retryMs; pass++) {
    log("retrying failed launches", { inSeconds: config.RECONCILE_RETRY_SECONDS, outcomes: result.outcomes });
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    result = await reconcilePass(config, context);
  }
  return result;
}

const launchFailed = (result: PassResult) => Object.values(result.outcomes).some((o) => o === "will retry" || o === "error");

// One look at the queue: launches a runner for each queued job that the
// available runners cannot cover.
async function reconcilePass(config: ReconcilerConfig, context?: Pick<Context, "getRemainingTimeInMillis">): Promise<PassResult> {
  const jobs = jobStore(config.JOBS_TABLE);
  const now = Date.now();
  const gh = await github(config);
  if (!(await runnerGroupIsPrivate(config, gh, now))) return { queued: 0, available: 0, outcomes: {}, retired: [] };
  const [queued, registrations, instances] = await Promise.all([
    jobs.listQueued(),
    gh.listRunners(`${config.RUNNER_PREFIX}-`),
    listRunnerInstances(ec2, config.RUNNER_PREFIX),
  ]);
  const available = availableRunners({ prefix: config.RUNNER_PREFIX, registrations, instances, now, graceMs: LAUNCH_GRACE_MS });
  const { uncovered, spare } = matchJobs(queued, available);

  const outcomes: Record<string, LaunchOutcome> = {};
  // Each job's errors stay with that job, so one failure never ends the
  // reconcile while other launches are still running.
  await forEachLimit(uncovered, LAUNCH_CONCURRENCY, async (job) => {
    // A deferred job is still queued, so the next reconcile takes it up.
    if (context && context.getRemainingTimeInMillis() < LAUNCH_TIME_BUDGET_MS) {
      outcomes[job.jobId] = "deferred";
      return;
    }
    outcomes[job.jobId] = await reconcileJob(config, jobs, gh, job).catch((err) => {
      log("job reconcile failed, will retry", { jobId: job.jobId, repo: job.repo, error: errorMessage(err) });
      return "error" as const;
    });
  });

  const retired = await retireRunners(gh, retirableRunners(spare, new Set(queued.map((j) => j.jobId)), config.RUNNER_PREFIX));
  log("reconciled", { queued: queued.length, available: available.length, outcomes, retired });
  return { queued: queued.length, available: available.length, outcomes, retired };
}

// Removes runners that no queued job needs, so a job cancelled before it
// started does not leave its runner idling until the janitor's IdleMinutes.
// The registration goes first, so GitHub cannot assign the runner a job while
// its instance terminates. Returns the names of the runners removed.
async function retireRunners(gh: GitHubClient, runners: readonly (AvailableRunner & { instanceId: string })[]): Promise<string[]> {
  const retired: string[] = [];
  for (const runner of runners) {
    try {
      await gh.deleteRunner(runner.id);
      await terminateInstances(ec2, [runner.instanceId]);
      retired.push(runner.name);
    } catch (err) {
      log("failed to retire spare runner; the janitor will terminate it", { name: runner.name, error: errorMessage(err) });
    }
  }
  return retired;
}

// The webhook ignores public repositories' jobs unless ALLOW_PUBLIC_REPOS is
// set, but GitHub hands runners to any job the runner group allows. If the
// group allows public repositories, a fork pull request could take a runner
// launched for a private job, so the reconciler launches nothing and alerts.
// A private result is cached for an hour. A public one is rechecked on every
// reconcile, so launches resume as soon as the setting is fixed.
let privateGroupCheckedAt: number | undefined;
let alertedPublicGroup = false;
async function runnerGroupIsPrivate(config: ReconcilerConfig, gh: GitHubClient, now: number): Promise<boolean> {
  if (config.ALLOW_PUBLIC_REPOS) return true;
  if (privateGroupCheckedAt !== undefined && now - privateGroupCheckedAt < CACHE_MS) return true;
  const allowsPublic = await gh.runnerGroupAllowsPublicRepos(config.RUNNER_GROUP_ID);
  if (allowsPublic !== true) {
    privateGroupCheckedAt = now;
    alertedPublicGroup = false;
    return true;
  }
  privateGroupCheckedAt = undefined;
  log("runner group allows public repositories, launching nothing", { runnerGroupId: config.RUNNER_GROUP_ID });
  if (!alertedPublicGroup) {
    alertedPublicGroup = true;
    await alert(
      config.ALERT_TOPIC_ARN,
      "Runner group allows public repositories",
      `Runner group ${config.RUNNER_GROUP_ID} allows public repositories, but the stack's AllowPublicRepos parameter is false. ` +
        `Jobs from forks could take runners launched for private jobs. No runners launch until one of the two settings changes.`,
    );
  }
  return false;
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
  if (job.idleRunners >= MAX_IDLE_RUNNERS) {
    const reason =
      `${job.idleRunners} runners launched for this job sat idle until they were terminated, and GitHub never assigned the job to them. ` +
      `Either runner group ${config.RUNNER_GROUP_ID} does not allow ${job.repo} (or public repositories), ` +
      `or the runners failed to connect (see their boot logs in ${config.BOOT_LOG_GROUP}).`;
    log("job never assigned to its runners", { jobId: job.jobId, repo: job.repo, idleRunners: job.idleRunners });
    if (await jobs.markFailed(job.jobId, reason)) {
      await alert(config.ALERT_TOPIC_ARN, `Runners for a job in ${job.repo} keep going unused`, `${current.html_url}\n\n${reason}`);
    }
    return "failed";
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
        `${current.html_url}\n\nFailed ${failures} times. The reconciler keeps retrying.\n\n${errorMessage(err)}`,
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
  const spec = parseLabels(job.labels);
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
        runnerName: name,
        bootLogGroup: config.BOOT_LOG_GROUP,
      }),
      runnerName: name,
      stackName: config.RUNNER_PREFIX,
      repo: job.repo,
      runId: job.runId,
    });
    log("launched runner", { name, repo: job.repo, jobId: job.jobId, ...result, spec });
  } catch (err) {
    // An unlaunched registration would count as an available runner.
    await gh.deleteRunner(jit.runner.id).catch((e) => log("failed to delete runner after launch error", { name, error: errorMessage(e) }));
    throw err;
  }
}

// The runner tarball for each AMI architecture.
const downloads = new Map<string, { download: RunnerDownload; at: number }>();
async function runnerDownload(config: ReconcilerConfig, gh: GitHubClient, ami: Ami): Promise<RunnerDownload> {
  const arch = ami.architecture === "arm64" ? "arm64" : "x64";
  const cached = downloads.get(arch);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.download;
  const download = await gh.runnerDownload(config.RUNNER_VERSION, arch);
  downloads.set(arch, { download, at: Date.now() });
  return download;
}
