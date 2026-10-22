// Decides which queued jobs need a new runner.
//
// GitHub gives a queued job to any idle runner whose labels include all of the
// job's labels. It does not know which job a runner was launched for, so a
// runner launched for a [ec2, cpu=8] job can be taken by a job that asked for
// [ec2]. This module therefore treats the stack's runners as one pool: a job
// needs a launch only when the available runners cannot cover it together
// with every other queued job.

import type { RunnerInstance } from "./ec2.ts";

// The fields this module reads from a GitHub self-hosted runner registration.
export interface Registration {
  id: number;
  name: string;
  busy: boolean;
  labels: { name: string }[];
}

// A runner registration with no instance counts as a launch in progress for
// this long. The reconciler's 5 minute timeout bounds a real launch.
export const LAUNCH_GRACE_MS = 10 * 60_000;

// Runner names are <prefix>-<job id>-<launch time>, where the launch time is
// milliseconds since the epoch in base 36. The job ID records which job the
// launch was for. The launch time makes every name unique and tells the
// janitor how old a registration is.
export function runnerName(prefix: string, jobId: number, now = Date.now()): string {
  return `${prefix}-${jobId}-${now.toString(36)}`;
}

export function parseRunnerName(prefix: string, name: string): { jobId: number; launchedAt: number } | undefined {
  if (!name.startsWith(`${prefix}-`)) return undefined;
  const match = /^(\d+)-([0-9a-z]+)$/.exec(name.slice(prefix.length + 1));
  if (!match?.[1] || !match[2]) return undefined;
  return { jobId: Number(match[1]), launchedAt: Number.parseInt(match[2], 36) };
}

// GitHub's rule: a runner can take a job when the runner has every label the
// job asked for. Labels compare case-insensitively.
export function canRun(runnerLabels: readonly string[], jobLabels: readonly string[]): boolean {
  const have = new Set(runnerLabels.map((l) => l.toLowerCase()));
  return jobLabels.every((l) => have.has(l.toLowerCase()));
}

// Where a runner registration stands:
// - busy: running a job.
// - live: idle, with a pending or running instance.
// - launching: idle, with no instance yet, registered less than graceMs ago
//   because the reconciler is launching it right now.
// - stale: idle, with an instance that has ended, or with no instance after
//   the grace period because the reconciler stopped partway through a launch.
export type RunnerState = "busy" | "live" | "launching" | "stale";

// The stack's runner registrations and instances at one moment.
export interface PoolSnapshot<R extends Registration = Registration> {
  prefix: string;
  registrations: readonly R[];
  instances: readonly Pick<RunnerInstance, "instanceId" | "runnerName" | "state">[];
  now: number;
  graceMs: number;
}

// Classifies the stack's registrations. Registrations whose names this stack
// did not create are left out.
export function classifyRunners<R extends Registration>({
  prefix,
  registrations,
  instances,
  now,
  graceMs,
}: PoolSnapshot<R>): { registration: R; state: RunnerState; instanceId: string | undefined }[] {
  const instanceByRunner = new Map(instances.map((i) => [i.runnerName, i]));
  return registrations.flatMap((registration) => {
    const parsed = parseRunnerName(prefix, registration.name);
    if (!parsed) return [];
    const instance = instanceByRunner.get(registration.name);
    let state: RunnerState;
    if (registration.busy) state = "busy";
    else if (instance === undefined) state = now - parsed.launchedAt < graceMs ? "launching" : "stale";
    else state = instance.state === "pending" || instance.state === "running" ? "live" : "stale";
    return [{ registration, state, instanceId: instance?.instanceId }];
  });
}

// A runner that can still take a queued job.
export interface AvailableRunner {
  // The GitHub registration's ID.
  id: number;
  name: string;
  labels: string[];
  state: "live" | "launching";
  // Undefined while the runner is launching.
  instanceId: string | undefined;
}

export function availableRunners(snapshot: PoolSnapshot): AvailableRunner[] {
  return classifyRunners(snapshot).flatMap(({ registration: r, state, instanceId }) =>
    state === "live" || state === "launching" ? [{ id: r.id, name: r.name, labels: r.labels.map((l) => l.name), state, instanceId }] : [],
  );
}

// Pairs queued jobs with available runners so that as many jobs as possible
// have a runner they can run on. Returns the jobs left without one, which need
// a launch, and the runners left without a job. Uses Kuhn's augmenting-path
// algorithm for maximum bipartite matching, which is fast for the tens of jobs
// and runners involved here.
export function matchJobs<J extends { labels: string[] }, R extends { labels: string[] }>(
  jobs: readonly J[],
  runners: readonly R[],
): { uncovered: J[]; spare: R[] } {
  const fits = jobs.map((job) => runners.flatMap((runner, i) => (canRun(runner.labels, job.labels) ? [i] : [])));
  // jobForRunner[i] is the index of the job runner i is assigned to.
  const jobForRunner: (number | undefined)[] = runners.map(() => undefined);

  // Tries to give job j a runner, moving already-assigned jobs to other
  // runners they fit when that frees one up.
  const assign = (j: number, visited: Set<number>): boolean => {
    for (const r of fits[j] ?? []) {
      if (visited.has(r)) continue;
      visited.add(r);
      const current = jobForRunner[r];
      if (current === undefined || assign(current, visited)) {
        jobForRunner[r] = j;
        return true;
      }
    }
    return false;
  };

  const uncovered = jobs.filter((_, j) => !assign(j, new Set()));
  return { uncovered, spare: runners.filter((_, r) => jobForRunner[r] === undefined) };
}

// The spare runners worth terminating now: running, and launched for a job
// that no longer waits (it started on another runner, finished, or was
// cancelled before it started). A spare runner is in no maximum matching's
// way, so terminating it leaves every queued job as covered as before.
// Launching runners are left for the janitor, since their instance may not
// exist yet, and a spare runner whose own job still waits is kept for it.
export function retirableRunners(
  spare: readonly AvailableRunner[],
  queuedJobIds: ReadonlySet<number>,
  prefix: string,
): (AvailableRunner & { instanceId: string })[] {
  return spare.filter((r): r is AvailableRunner & { instanceId: string } => {
    const launchedFor = parseRunnerName(prefix, r.name)?.jobId;
    return r.state === "live" && r.instanceId !== undefined && launchedFor !== undefined && !queuedJobIds.has(launchedFor);
  });
}
