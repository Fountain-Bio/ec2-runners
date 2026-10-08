// Decides which queued jobs need a new runner.
//
// GitHub gives a queued job to any idle runner whose labels include all of the
// job's labels. It does not know which job a runner was launched for, so a
// runner launched for a [ec2, cpu=8] job can be taken by a job that asked for
// [ec2]. This module therefore treats the stack's runners as one pool: a job
// needs a launch only when the available runners cannot cover it together
// with every other queued job.

import type { RunnerInstance } from "./ec2.ts";

// A job that GitHub reported as queued and that has not started yet.
export interface QueuedJob {
  jobId: number;
  // "owner/name".
  repo: string;
  runId: number;
  labels: string[];
}

// The fields this module reads from a GitHub self-hosted runner registration.
export interface Registration {
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

// The registrations that can still take a queued job: not busy, and either
// backed by a pending or running instance, or registered less than graceMs ago
// with no instance yet because the reconciler is launching it right now.
export function availableRunners({
  prefix,
  registrations,
  instances,
  now,
  graceMs,
}: {
  prefix: string;
  registrations: readonly Registration[];
  instances: readonly RunnerInstance[];
  now: number;
  graceMs: number;
}): { name: string; labels: string[] }[] {
  const stateByRunner = new Map(instances.map((i) => [i.runnerName, i.state]));
  return registrations
    .filter((r) => {
      if (r.busy) return false;
      const parsed = parseRunnerName(prefix, r.name);
      if (!parsed) return false;
      const state = stateByRunner.get(r.name);
      if (state === undefined) return now - parsed.launchedAt < graceMs;
      return state === "pending" || state === "running";
    })
    .map((r) => ({ name: r.name, labels: r.labels.map((l) => l.name) }));
}

// Pairs queued jobs with available runners so that as many jobs as possible
// have a runner they can run on, and returns the jobs left over. Uses Kuhn's
// augmenting-path algorithm for maximum bipartite matching, which is fast for
// the tens of jobs and runners involved here.
export function unmatchedJobs<J extends { labels: string[] }>(jobs: readonly J[], runners: readonly { labels: string[] }[]): J[] {
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

  return jobs.filter((_, j) => !assign(j, new Set()));
}
