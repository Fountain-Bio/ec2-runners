// Launches runners for queued jobs that the available runners cannot cover.
//
// Invoked asynchronously by the webhook and every 5 minutes by a schedule.
// Invocations can run at the same time, so each pass runs under the
// ReconcileLock (lock.ts): passes never overlap, and each one sees the runners
// the previous one registered. The scheduled invocation first asks GitHub for
// queued jobs whose "queued" webhook never arrived (backfillQueuedJobs).

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import type { Context } from "aws-lambda";
import { alert } from "./alerts.ts";
import { github } from "./app-secret.ts";
import { reconcilerConfig, type ReconcilerConfig } from "./config.ts";
import { assertInstanceTypesExist, launchRunner, listRunnerInstances, resolveAmi, terminateInstances, type Ami } from "./ec2.ts";
import { isGitHubError, type GitHubClient, type ReleaseDownload } from "./github.ts";
import { jobStore, type JobStore, type QueuedJob } from "./jobs.ts";
import { JobConfigError, isStackJob, jobKind, parseLabels } from "./labels.ts";
import { ReconcileLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { MICROVM_ID_LABEL, describeMicrovmRunners, isMicrovmId, launchMicrovm, terminateMicrovms } from "./microvm.ts";
import { LAUNCH_GRACE_MS, availableRunners, matchJobs, retirableRunners, runnerName, type AvailableRunner } from "./pool.ts";
import { RUNNER_WORK_DIR, buildUserData } from "./userdata.ts";

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
// GitHub fails a job that has waited this long for a runner, so the backfill
// looks only at workflow runs created within it.
const QUEUE_LIMIT_MS = 24 * 60 * 60_000;
// Repositories the backfill queries at once.
const BACKFILL_CONCURRENCY = 4;

const ec2 = new EC2Client({});
// The account's RunMicrovm rate quota starts at one request per second.
// Adaptive retry spaces out requests on the client after a throttle, so a
// burst of MicroVM jobs launches one after another instead of failing over to
// EC2.
const microvms = new LambdaMicrovmsClient({ retryMode: "adaptive", maxAttempts: 6 });
let cachedLock: ReconcileLock | undefined;

type LaunchOutcome = "launched" | "already started" | "gone" | "failed" | "will retry" | "error" | "deferred";

type PassResult = { queued: number; available: number; outcomes: Record<string, LaunchOutcome>; retired: string[] };

// The schedule passes an EventBridge event, and the webhook passes none. The
// context is absent in tests. Returns undefined when another invocation is
// reconciling; that invocation runs another pass for this one.
export async function reconciler(event?: unknown, context?: Pick<Context, "getRemainingTimeInMillis">): Promise<PassResult | undefined> {
  const config = reconcilerConfig();
  const lock = (cachedLock ??= new ReconcileLock(new DynamoDBClient({}), config.JOBS_TABLE));
  const remaining = () => context?.getRemainingTimeInMillis() ?? DEFAULT_HOLD_MS;

  // Only the schedule backfills, so a burst of webhook invocations does not
  // query every repository once per job. A failed backfill still lets the
  // reconcile launch for the jobs already recorded, and is rethrown after it
  // so Lambda retries the invocation. The reconciler-errors alarm fires only
  // when every 5-minute period for 15 minutes has a failure, so a one-off
  // GitHub error that the retry or the next schedule gets past stays quiet.
  let backfillError: Error | undefined;
  if (isScheduledEvent(event)) {
    await backfillQueuedJobs(config).catch((err) => {
      log("backfill of queued jobs failed", { error: errorMessage(err) });
      backfillError = err instanceof Error ? err : new Error(errorMessage(err));
    });
  }

  const result = await lock.runExclusive({
    holder: randomUUID(),
    holdUntil: Date.now() + remaining() + LOCK_MARGIN_MS,
    pass: () => reconcileUntilLaunched(config, context, remaining),
    canRunAgain: () => remaining() > LAUNCH_TIME_BUDGET_MS,
  });
  if (!result) log("another reconcile holds the lock; it will run a pass for this request");
  if (backfillError) throw backfillError;
  return result;
}

// EventBridge rules send events with source "aws.events".
function isScheduledEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "source" in event && event.source === "aws.events";
}

// GitHub sometimes never sends a job's "queued" webhook, and the jobs table
// then has no row for the job, so no reconcile launches for it. This asks
// GitHub for the jobs waiting in the installation's repositories and records
// those with the trigger label. markQueued leaves existing rows alone, so
// jobs the webhook recorded, and jobs already done or failed, are unchanged.
//
// Each repository's errors stay with that repository, so one failed request
// never keeps the other repositories' jobs from being recorded. A repository
// that answers 404 was deleted, transferred, or removed from the installation
// since the list was read, and is skipped. Any other failure is thrown once
// every repository has been tried.
async function backfillQueuedJobs(config: ReconcilerConfig): Promise<void> {
  const jobs = jobStore(config.JOBS_TABLE);
  const gh = await github(config);
  const since = new Date(Date.now() - QUEUE_LIMIT_MS);
  // The webhook ignores public repositories' jobs for the same reason (see webhook.ts).
  const repos = (await gh.listRepositories()).filter((r) => !r.archived && !r.disabled && (r.private || config.ALLOW_PUBLIC_REPOS));
  const recorded: { repo: string; jobId: number }[] = [];
  const failed: { repo: string; error: string }[] = [];
  await forEachLimit(repos, BACKFILL_CONCURRENCY, async (repo) => {
    try {
      for (const job of await gh.listQueuedJobs(repo.full_name, since)) {
        if (!isStackJob(job.labels, kindLabels(config))) continue;
        if (await jobs.markQueued({ jobId: job.id, repo: repo.full_name, runId: job.run_id, labels: job.labels })) {
          recorded.push({ repo: repo.full_name, jobId: job.id });
        }
      }
    } catch (err) {
      if (isGitHubError(err, 404)) {
        log("backfill skipped a repository the app can no longer read", { repo: repo.full_name });
        return;
      }
      failed.push({ repo: repo.full_name, error: errorMessage(err) });
    }
  });
  if (recorded.length > 0) log("recorded queued jobs whose webhook never arrived", { jobs: recorded });
  if (failed.length > 0) {
    log("backfill failed for some repositories", { failed, repositories: repos.length });
    throw new Error(`Backfill failed for ${failed.length} of ${repos.length} repositories: ${failed.map((f) => `${f.repo}: ${f.error}`).join("; ")}`);
  }
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
  // MicroVM runners join the pool in the shape of EC2 instances.
  const vms = await describeMicrovmRunners(microvms, registrations);
  const available = availableRunners({
    prefix: config.RUNNER_PREFIX,
    registrations,
    instances: [...instances, ...vms],
    now,
    graceMs: LAUNCH_GRACE_MS,
  });
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
// its instance or MicroVM terminates. Returns the names of the runners removed.
async function retireRunners(gh: GitHubClient, runners: readonly (AvailableRunner & { instanceId: string })[]): Promise<string[]> {
  const retired: string[] = [];
  for (const runner of runners) {
    try {
      await gh.deleteRunner(runner.id);
      if (isMicrovmId(runner.instanceId)) await terminateMicrovms(microvms, [runner.instanceId]);
      else await terminateInstances(ec2, [runner.instanceId]);
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

const kindLabels = (config: ReconcilerConfig) => ({ ec2Label: config.TRIGGER_LABEL, microvmLabel: config.MICROVM_LABEL });

// Registers a just-in-time runner for one job and launches it: a MicroVM for a
// MicroVM job, and an EC2 instance for an EC2 job or for a MicroVM job whose
// MicroVM did not launch (the account's MicroVM memory quota is full, the
// image is still building, or the MicroVM service failed). Any job whose
// labels the runner has can end up on it, and an EC2 runner registered with a
// MicroVM job's labels takes MicroVM jobs like a MicroVM runner does. Throws
// JobConfigError when the job's labels can never launch, and other errors for
// failures a retry may get past, such as a lack of capacity.
async function launchForJob(config: ReconcilerConfig, gh: GitHubClient, job: QueuedJob): Promise<void> {
  if (jobKind(job.labels, kindLabels(config)) === "microvm") {
    try {
      await launchMicrovmForJob(config, gh, job);
      return;
    } catch (err) {
      log("MicroVM launch failed, launching an EC2 runner instead", { jobId: job.jobId, repo: job.repo, error: errorMessage(err) });
    }
  }
  await launchEc2ForJob(config, gh, job);
}

// Registers a just-in-time runner and starts a MicroVM for it, then labels
// the registration with the MicroVM's ID (see microvm.ts). A failure leaves
// neither a registration nor a MicroVM behind.
async function launchMicrovmForJob(config: ReconcilerConfig, gh: GitHubClient, job: QueuedJob): Promise<void> {
  const name = runnerName(config.RUNNER_PREFIX, job.jobId);
  const jit = await gh.generateJitConfig({ name, labels: job.labels, runnerGroupId: config.RUNNER_GROUP_ID, workFolder: RUNNER_WORK_DIR });
  let microvmId: string | undefined;
  try {
    microvmId = await launchMicrovm(microvms, {
      imageArn: config.MICROVM_IMAGE_ARN,
      executionRoleArn: config.MICROVM_EXECUTION_ROLE_ARN,
      region: config.AWS_REGION,
      encodedJitConfig: jit.encoded_jit_config,
      maxMinutes: config.MAX_MINUTES,
    });
    await gh.addRunnerLabels(jit.runner.id, [`${MICROVM_ID_LABEL}=${microvmId}`]);
  } catch (err) {
    if (microvmId) {
      await terminateMicrovms(microvms, [microvmId]).catch((e) =>
        log("failed to terminate MicroVM after launch error", { microvmId, error: errorMessage(e) }),
      );
    }
    await gh.deleteRunner(jit.runner.id).catch((e) => log("failed to delete runner after launch error", { name, error: errorMessage(e) }));
    throw err;
  }
  log("launched MicroVM runner", { name, repo: job.repo, jobId: job.jobId, microvmId });
}

// Registers a just-in-time runner for one job and launches its EC2 instance.
async function launchEc2ForJob(config: ReconcilerConfig, gh: GitHubClient, job: QueuedJob): Promise<void> {
  const spec = { ...parseLabels(job.labels), cpuBaselineFamily: config.CPU_BASELINE_FAMILY || undefined };
  // Everything that can reject the job's labels runs before the runner is
  // registered, so a bad label leaves no registration behind.
  const ami = await resolveAmi(ec2, spec.image, { owner: config.AMI_OWNER, namePrefix: config.AMI_NAME_PREFIX });
  await assertInstanceTypesExist(ec2, spec, ami);
  const runner = await runnerDownload(config, gh, ami);

  const name = runnerName(config.RUNNER_PREFIX, job.jobId);
  const jit = await gh.generateJitConfig({ name, labels: job.labels, runnerGroupId: config.RUNNER_GROUP_ID, workFolder: RUNNER_WORK_DIR });
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
const downloads = new Map<string, { download: ReleaseDownload; at: number }>();
async function runnerDownload(config: ReconcilerConfig, gh: GitHubClient, ami: Ami): Promise<ReleaseDownload> {
  const arch = ami.architecture === "arm64" ? "arm64" : "x64";
  const cached = downloads.get(arch);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.download;
  const download = await gh.runnerDownload(config.RUNNER_VERSION, arch);
  downloads.set(arch, { download, at: Date.now() });
  return download;
}
