// Runs every 5 minutes. Terminates instances that outlived the max lifetime
// or never picked up a job, removes stale runner registrations, and deletes
// launch template versions that a stopped reconciler left behind.

import { EC2Client } from "@aws-sdk/client-ec2";
import { github } from "./app-secret.ts";
import { janitorConfig } from "./config.ts";
import { ALL_STATES, deleteStaleLaunchTemplateVersions, listRunnerInstances, terminateInstances } from "./ec2.ts";
import { errorMessage, log } from "./log.ts";
import { LAUNCH_GRACE_MS, parseRunnerName } from "./pool.ts";

const ec2 = new EC2Client({});

export async function janitor(): Promise<{ terminated: string[]; removedRunners: string[]; deletedVersions: string[] }> {
  const config = janitorConfig();
  const now = Date.now();
  const idleMs = config.IDLE_MINUTES * 60_000;
  const maxMs = (config.MAX_MINUTES + 5) * 60_000;
  const gh = await github(config);

  const [allInstances, runners] = await Promise.all([
    listRunnerInstances(ec2, config.RUNNER_PREFIX, ALL_STATES),
    gh.listRunners(`${config.RUNNER_PREFIX}-`),
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
    const parsed = parseRunnerName(config.RUNNER_PREFIX, r.name);
    return parsed !== undefined && now - parsed.launchedAt > LAUNCH_GRACE_MS;
  });
  for (const r of stale) {
    await gh.deleteRunner(r.id).catch((e) => log("failed to delete stale runner", { name: r.name, error: errorMessage(e) }));
  }

  // A launch finishes within the reconciler's 5 minute timeout, so an
  // hour-old version is unused.
  const deletedVersions = await deleteStaleLaunchTemplateVersions(ec2, {
    launchTemplateId: config.LAUNCH_TEMPLATE_ID,
    runnerPrefix: config.RUNNER_PREFIX,
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
