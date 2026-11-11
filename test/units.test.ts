import { afterEach, expect, test, vi } from "vite-plus/test";
import { createHmac } from "node:crypto";
import { ResourceNotFoundException } from "@aws-sdk/client-lambda-microvms";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobConfigError, hasTriggerLabel, instanceRequirements, isStackJob, jobKind, parseLabels, type LaunchSpec } from "../src/labels.ts";
import { ensureMicrovmImage, imageSource, zipFiles, type ImageSettings } from "../src/microvm-image.ts";
import { microvmIdOf, runHookPayload } from "../src/microvm.ts";
import { nodeDownload } from "../src/node-release.ts";
import { alertMessage } from "../src/alerts.ts";
import { verifySignature } from "../src/github.ts";
import { availableRunners, canRun, classifyRunners, matchJobs, parseRunnerName, retirableRunners, runnerName } from "../src/pool.ts";
import { buildUserData } from "../src/userdata.ts";
import {
  assertInstanceTypesExist,
  resolveAmi,
  deleteStaleLaunchTemplateVersions,
  launchRunner,
  shuffled,
  type Ami,
  type Ec2,
  type LaunchOptions,
} from "../src/ec2.ts";

test("parseLabels applies defaults", () => {
  expect(parseLabels(["ec2"])).toMatchObject({ cpu: 2, ram: 4, image: "ubuntu24-full-x64", disk: 40, spot: true });
});

test("parseLabels reads array and slash forms the same way", () => {
  const a = parseLabels(["ec2", "cpu=8", "ram=32", "family=c7i+m7i", "image=ubuntu24-full-arm64", "disk=100", "spot=false", "run=123"]);
  const b = parseLabels(["ec2/cpu=8/ram=32/family=c7i+m7i/image=ubuntu24-full-arm64/disk=100/spot=false/run=123"]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ cpu: 8, ram: 32, families: ["c7i", "m7i"], spot: false });
});

test("hasTriggerLabel matches the trigger label case-insensitively, in either label form", () => {
  expect(hasTriggerLabel(["ubuntu-latest"])).toBe(false);
  expect(hasTriggerLabel(["self-hosted", "cpu=4"])).toBe(false);
  expect(hasTriggerLabel(["EC2", "cpu=4"])).toBe(true);
  expect(hasTriggerLabel(["ec2/cpu=4"])).toBe(true);
  expect(hasTriggerLabel(["linux", "cpu=4"], "linux")).toBe(true);
  expect(hasTriggerLabel(["ec2"], "linux")).toBe(false);
});

test("parseLabels rejects bad numbers", () => {
  expect(() => parseLabels(["ec2", "cpu=abc"])).toThrow(/positive integer/);
  expect(() => parseLabels(["ec2", "cpu=0"])).toThrow(/positive integer/);
  expect(() => parseLabels(["ec2", "cpu=4.5"])).toThrow(/positive integer/);
  expect(() => parseLabels(["ec2", "disk=100GB"])).toThrow(/positive integer/);
  expect(() => parseLabels(["ec2", "cpu=500"])).toThrow(/192/);
});

test("instanceRequirements pins vCPUs and maps families to wildcards", () => {
  const req = instanceRequirements(parseLabels(["ec2", "cpu=16", "family=c7i+m7i.4xlarge"]));
  expect(req.VCpuCount).toEqual({ Min: 16, Max: 16 });
  expect(req.MemoryMiB).toEqual({ Min: 32 * 1024 });
  expect(req.AllowedInstanceTypes).toEqual(["c7i.*", "m7i.4xlarge"]);
  expect(req.BurstablePerformance).toBe("excluded");
  expect(instanceRequirements(parseLabels(["ec2"])).AllowedInstanceTypes).toBeUndefined();
});

test("instanceRequirements applies the stack's CPU floor", () => {
  const req = instanceRequirements({ ...parseLabels(["ec2"]), cpuBaselineFamily: "m6i" });
  expect(req.BaselinePerformanceFactors).toEqual({ Cpu: { References: [{ InstanceFamily: "m6i" }] } });
  expect(instanceRequirements(parseLabels(["ec2"])).BaselinePerformanceFactors).toBeUndefined();
});

test("nvme=true requires local SSD storage", () => {
  const nvme = parseLabels(["ec2", "nvme=true", "cpu=8"]);
  expect(nvme.nvme).toBe(true);
  const req = instanceRequirements(nvme);
  expect(req.LocalStorage).toBe("required");
  expect(req.LocalStorageTypes).toEqual(["ssd"]);
  expect(instanceRequirements(parseLabels(["ec2"])).LocalStorage).toBeUndefined();
  expect(parseLabels(["ec2", "nvme=false"]).nvme).toBe(false);
});

test("verifySignature accepts GitHub's format and rejects tampering", async () => {
  const body = '{"action":"queued"}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  expect(await verifySignature("s3cret", body, sig)).toBe(true);
  expect(await verifySignature("wrong", body, sig)).toBe(false);
  expect(await verifySignature("s3cret", "{}", sig)).toBe(false);
  expect(await verifySignature("s3cret", body, undefined)).toBe(false);
  expect(await verifySignature("s3cret", "", sig)).toBe(false);
  expect(await verifySignature("s3cret", body, "sha256=short")).toBe(false);
});

const runner = {
  url: "https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-x64-2.338.0.tar.gz",
  sha256: "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32",
};

test("buildUserData produces valid bash with the JIT config and cache settings", () => {
  const b64 = buildUserData({
    jitConfig: "eyJhYmMiOiAxfQ==",
    cacheBucket: "my-cache",
    region: "us-west-2",
    maxMinutes: 360,
    runner,
    runnerName: "ec2-runners-555-mabc",
    bootLogGroup: "/ec2-runners/ec2-runners/boot",
  });
  const script = Buffer.from(b64, "base64").toString("utf8");
  expect(script.startsWith("#!/bin/bash\n")).toBe(true);
  expect(script).toMatch(/JIT_CONFIG='eyJhYmMiOiAxfQ=='/);
  expect(script).toMatch(/RUNS_ON_S3_BUCKET_CACHE=\$CACHE_BUCKET/);
  expect(script).toMatch(/shutdown -h \+360/);
  expect(script).toMatch(/run\.sh --jitconfig/);
  expect(script).toMatch(/ACTIONS_RUNNER_HOOK_JOB_STARTED=\$HOOK_DIR\/job-started\.sh/);
  expect(script).toMatch(/mount --bind \/mnt\/nvme\/docker \/var\/lib\/docker/);
  // Jobs run in GitHub-hosted runners' workspace layout, on NVMe when there is one.
  expect(script).toContain("WORK_DIR='/home/runner/work'");
  expect(script).toContain('mount --bind /mnt/nvme/work "$WORK_DIR"');
  expect(script).not.toMatch(/ecr/i);
  expect(script).toContain(`RUNNER_SHA256='${runner.sha256}'`);
  expect(script).toContain(`RUNNER_URL='${runner.url}'`);
  expect(script).toContain("sha256sum -c -");
  expect(script).toContain("RUNNER_NAME='ec2-runners-555-mabc'");
  expect(script).toContain("BOOT_LOG_GROUP='/ec2-runners/ec2-runners/boot'");
  expect(script).toContain("trap 'exit 143' TERM");
  expect(script).toMatch(/finish\(\) \{\n(?:  #.*\n)*  exec >>\/var\/log\/ec2-runner-boot\.log 2>&1\n/);
  // The boot log timestamps each step, starting before anything slow runs.
  expect(script).toMatch(/^stage\(\) \{ echo "\$\(date -u \+%Y-%m-%dT%H:%M:%S\.%3NZ\) \$\*"; \}\nstage "boot script started; /m);
  expect(script.indexOf('stage "starting runner"')).toBeLessThan(script.indexOf("run.sh --jitconfig"));
  // Docker starts after its directories are mounted and before the runner
  // install, and the script waits for it before starting the runner.
  const dockerStart = script.indexOf("systemctl start --no-block containerd.service docker.service");
  expect(dockerStart).toBeGreaterThan(script.indexOf("mount --bind /mnt/nvme/containerd /var/lib/containerd"));
  expect(dockerStart).toBeLessThan(script.indexOf("curl -fsSL -o /tmp/actions-runner.tar.gz"));
  expect(script.indexOf("docker info")).toBeGreaterThan(script.indexOf("tar -xzf"));
  expect(script.indexOf("docker info")).toBeLessThan(script.indexOf("run.sh --jitconfig"));
  const dir = mkdtempSync(join(tmpdir(), "userdata-"));
  const file = join(dir, "boot.sh");
  writeFileSync(file, script);
  execFileSync("bash", ["-n", file]); // throws on a syntax error
});

test("buildUserData quotes values containing single quotes", () => {
  const script = Buffer.from(
    buildUserData({ jitConfig: "a'b", cacheBucket: "c", region: "r", maxMinutes: 10, runner, runnerName: "n", bootLogGroup: "g" }),
    "base64",
  ).toString();
  expect(script).toMatch(/JIT_CONFIG='a'\\''b'/);
});

interface Call {
  name: string;
  // Each command's input has a different shape; the assertions know which one they read.
  input: any;
}

// Records every command. CreateFleet answers come from fleetResponses in
// order; other commands answer from `responses` by command name.
function fakeEc2(fleetResponses: object[], responses: Record<string, object> = {}): { ec2: Ec2; calls: Call[] } {
  const calls: Call[] = [];
  const send = async (cmd: { constructor: { name: string }; input: unknown }) => {
    const name = cmd.constructor.name;
    calls.push({ name, input: cmd.input });
    if (name in responses) return responses[name];
    if (name === "CreateLaunchTemplateVersionCommand") return { LaunchTemplateVersion: { VersionNumber: 7 } };
    if (name === "CreateFleetCommand") return fleetResponses.shift();
    if (name === "DeleteLaunchTemplateVersionsCommand") return {};
    throw new Error(`unexpected ${name}`);
  };
  return { ec2: { send } as unknown as Ec2, calls };
}

const ami: Ami = { imageId: "ami-abc", architecture: "x86_64", rootDeviceName: "/dev/sda1", snapshotSizeGiB: 30 };

const launchOpts = (launchSpec: LaunchSpec): LaunchOptions => ({
  launchTemplateId: "lt-123",
  sourceVersion: "1",
  random: () => 0.999, // keeps subnet order unchanged
  subnetIds: ["subnet-a", "subnet-b"],
  spec: launchSpec,
  ami,
  userData: "dXNlcmRhdGE=",
  runnerName: "r-1",
  stackName: "r",
  repo: "example-org/app",
  runId: 777,
});

test("launchRunner tries spot in each subnet, then on-demand, one subnet per call", async () => {
  const noCapacity = { Instances: [], Errors: [{ ErrorCode: "InsufficientInstanceCapacity", ErrorMessage: "none" }] };
  const { ec2, calls } = fakeEc2([
    noCapacity,
    noCapacity,
    { Instances: [{ InstanceIds: ["i-1"], InstanceType: "c7i.xlarge", Lifecycle: "on-demand" }] },
  ]);
  const result = await launchRunner(ec2, launchOpts(parseLabels(["ec2", "cpu=4", "disk=80"])));
  expect(result).toEqual({ instanceId: "i-1", instanceType: "c7i.xlarge", lifecycle: "on-demand", subnetId: "subnet-a" });

  expect(calls.map((c) => c.name)).toEqual([
    "CreateLaunchTemplateVersionCommand",
    "CreateFleetCommand",
    "CreateFleetCommand",
    "CreateFleetCommand",
    "DeleteLaunchTemplateVersionsCommand",
  ]);

  const version = calls[0]!.input;
  expect(version.SourceVersion).toBe("1");
  expect(version.LaunchTemplateData.ImageId).toBe("ami-abc");
  expect(version.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(80);
  expect(version.LaunchTemplateData.BlockDeviceMappings[0].DeviceName).toBe("/dev/sda1");

  const fleets = calls.filter((c) => c.name === "CreateFleetCommand").map((c) => c.input);
  for (const f of fleets) {
    expect(f.Type).toBe("instant");
    expect(f.LaunchTemplateConfigs[0].LaunchTemplateSpecification.Version).toBe("7");
    expect(f.LaunchTemplateConfigs[0].Overrides).toHaveLength(1);
    expect(f.LaunchTemplateConfigs[0].Overrides[0].InstanceRequirements.VCpuCount).toEqual({ Min: 4, Max: 4 });
  }
  expect(fleets.map((f) => [f.TargetCapacitySpecification.DefaultTargetCapacityType, f.LaunchTemplateConfigs[0].Overrides[0].SubnetId])).toEqual([
    ["spot", "subnet-a"],
    ["spot", "subnet-b"],
    ["on-demand", "subnet-a"],
  ]);
  expect(fleets[0].SpotOptions.AllocationStrategy).toBe("price-capacity-optimized");
  expect(fleets[2].OnDemandOptions.AllocationStrategy).toBe("lowest-price");
  expect(calls.at(-1)!.input).toEqual({ LaunchTemplateId: "lt-123", Versions: ["7"] });
});

test("launchRunner raises the disk to the AMI snapshot size", async () => {
  const { ec2, calls } = fakeEc2([{ Instances: [{ InstanceIds: ["i-2"] }] }]);
  await launchRunner(ec2, launchOpts(parseLabels(["ec2", "disk=10"])));
  expect(calls[0]!.input.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(30);
});

test("launchRunner with spot=false skips spot and reports every failure", async () => {
  const fail = { Instances: [], Errors: [{ ErrorCode: "X", ErrorMessage: "nope" }] };
  const { ec2, calls } = fakeEc2([fail, fail]);
  await expect(launchRunner(ec2, launchOpts(parseLabels(["ec2", "spot=false"])))).rejects.toThrow(
    /on-demand subnet-a: X: nope \| on-demand subnet-b: X: nope/,
  );
  const fleets = calls.filter((c) => c.name === "CreateFleetCommand");
  expect(fleets).toHaveLength(2);
  expect(fleets.every((f) => f.input.TargetCapacitySpecification.DefaultTargetCapacityType === "on-demand")).toBe(true);
  expect(calls.at(-1)!.name).toBe("DeleteLaunchTemplateVersionsCommand");
});

test("shuffled keeps every item", () => {
  expect(shuffled(["a", "b", "c"], () => 0).sort()).toEqual(["a", "b", "c"]);
});

test("resolveAmi reports an unknown AMI ID as a label error", async () => {
  const send = async () => {
    throw Object.assign(new Error("The image id '[ami-0000000000000dead]' does not exist"), { name: "InvalidAMIID.NotFound" });
  };
  const ec2 = { send } as unknown as Ec2;
  await expect(resolveAmi(ec2, "ami-0000000000000dead", { owner: "1", namePrefix: "x-" })).rejects.toBeInstanceOf(JobConfigError);
});

test("assertInstanceTypesExist rejects a spec that no instance type matches", async () => {
  const none = fakeEc2([], { GetInstanceTypesFromInstanceRequirementsCommand: { InstanceTypes: [] } });
  await expect(assertInstanceTypesExist(none.ec2, parseLabels(["ec2", "cpu=3"]), ami)).rejects.toThrow(/No x86_64 instance type has cpu=3/);
  expect(none.calls[0]!.input).toMatchObject({
    ArchitectureTypes: ["x86_64"],
    VirtualizationTypes: ["hvm"],
    InstanceRequirements: { VCpuCount: { Min: 3, Max: 3 } },
  });

  const some = fakeEc2([], { GetInstanceTypesFromInstanceRequirementsCommand: { InstanceTypes: [{ InstanceType: "c7i.xlarge" }] } });
  await assertInstanceTypesExist(some.ec2, parseLabels(["ec2", "cpu=4"]), ami);
});

test("deleteStaleLaunchTemplateVersions deletes only old per-launch versions", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3600_000);
  const { ec2, calls } = fakeEc2([], {
    DescribeLaunchTemplateVersionsCommand: {
      LaunchTemplateVersions: [
        // the stack's base version
        { VersionNumber: 1, DefaultVersion: true, CreateTime: hoursAgo(100) },
        // left behind by a reconciler that stopped
        { VersionNumber: 5, VersionDescription: runnerName("ec2-runners", 555, now - 3 * 3600_000), CreateTime: hoursAgo(3) },
        // in use by a launch happening now
        { VersionNumber: 6, VersionDescription: runnerName("ec2-runners", 556, now - 36_000), CreateTime: hoursAgo(0.01) },
        // created outside this stack's reconciler
        { VersionNumber: 7, VersionDescription: "manual", CreateTime: hoursAgo(5) },
      ],
    },
  });
  const deleted = await deleteStaleLaunchTemplateVersions(ec2, {
    launchTemplateId: "lt-1",
    runnerPrefix: "ec2-runners",
    maxAgeMs: 3600_000,
    now,
  });
  expect(deleted).toEqual(["5"]);
  expect(calls.at(-1)).toEqual({ name: "DeleteLaunchTemplateVersionsCommand", input: { LaunchTemplateId: "lt-1", Versions: ["5"] } });
});

test("alertMessage sends Chatbot's custom format to Slack and plain text to email", () => {
  const { Subject, Message } = alertMessage("Runner launch keeps failing in example-org/app", "Failed 3 times.");
  expect(Subject).toBe("Runner launch keeps failing in example-org/app");
  const byProtocol = JSON.parse(Message);
  expect(byProtocol.email).toBe("Runner launch keeps failing in example-org/app\n\nFailed 3 times.");
  expect(JSON.parse(byProtocol.default)).toEqual({
    version: "1.0",
    source: "custom",
    content: {
      textType: "client-markdown",
      title: ":warning: Runner launch keeps failing in example-org/app",
      description: "Failed 3 times.",
    },
  });
  expect(alertMessage("x".repeat(300), "y").Subject).toHaveLength(100);
});

test("runner names carry the job ID and launch time", () => {
  const launchedAt = Date.parse("2026-10-08T12:00:00Z");
  const name = runnerName("ec2-runners", 555, launchedAt);
  expect(name).toMatch(/^ec2-runners-555-[0-9a-z]+$/);
  expect(parseRunnerName("ec2-runners", name)).toEqual({ jobId: 555, launchedAt });
  // Another stack whose name starts with this one's.
  expect(parseRunnerName("ec2-runners", `ec2-runners-dev-555-${launchedAt.toString(36)}`)).toBeUndefined();
  expect(parseRunnerName("ec2-runners", "GitHub Actions 3")).toBeUndefined();
});

test("canRun follows GitHub's label subset rule", () => {
  expect(canRun(["ec2", "cpu=8", "self-hosted"], ["ec2"])).toBe(true);
  expect(canRun(["ec2", "cpu=8"], ["EC2", "cpu=8"])).toBe(true);
  expect(canRun(["ec2"], ["ec2", "cpu=8"])).toBe(false);
});

test("availableRunners keeps idle runners that are running or still launching", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const reg = (jobId: number, minutesAgo: number, busy = false) => ({
    id: jobId,
    name: runnerName("ec2-runners", jobId, now - minutesAgo * 60_000),
    busy,
    labels: [{ name: "ec2" }],
  });
  const registrations = [reg(1, 2), reg(2, 2, true), reg(3, 2), reg(4, 2), reg(5, 30), { id: 99, name: "other-runner", busy: false, labels: [] }];
  const inst = (r: { name: string }, state: string) => ({ instanceId: `i-${r.name}`, state, launchTime: new Date(now), runnerName: r.name });
  const instances = [inst(registrations[0]!, "running"), inst(registrations[1]!, "running"), inst(registrations[2]!, "terminated")];
  const available = availableRunners({ prefix: "ec2-runners", registrations, instances, now, graceMs: 10 * 60_000 });
  // 1 is running and idle. 4 has no instance yet but registered 2 minutes ago.
  // 2 is busy, 3's instance ended, and 5 never got an instance within the grace period.
  expect(available.map((r) => r.name)).toEqual([registrations[0]!.name, registrations[3]!.name]);
});

test("classifyRunners treats an ended instance and an overdue launch as stale", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const reg = (jobId: number, minutesAgo: number, busy = false) => ({
    id: jobId,
    name: runnerName("ec2-runners", jobId, now - minutesAgo * 60_000),
    busy,
    labels: [],
  });
  const [running, busyEnded, ended, launching, overdue] = [reg(1, 2), reg(2, 30, true), reg(3, 30), reg(4, 2), reg(5, 30)];
  const states = classifyRunners({
    prefix: "ec2-runners",
    registrations: [running, busyEnded, ended, launching, overdue],
    instances: [
      { instanceId: "i-1", runnerName: running.name, state: "running" },
      { instanceId: "i-2", runnerName: busyEnded.name, state: "terminated" },
      { instanceId: "i-3", runnerName: ended.name, state: "shutting-down" },
    ],
    now,
    graceMs: 10 * 60_000,
  }).map((c) => c.state);
  expect(states).toEqual(["live", "busy", "stale", "launching", "stale"]);
});

test("matchJobs needs no launch when two jobs swap runners", () => {
  // Jobs 1 and 2 both asked for [ec2]; each runner can take either job.
  const jobs = [
    { id: 1, labels: ["ec2"] },
    { id: 2, labels: ["ec2"] },
  ];
  expect(matchJobs(jobs, [{ labels: ["ec2"] }, { labels: ["ec2"] }]).uncovered).toEqual([]);
});

test("matchJobs finds the job a smaller job left without a fitting runner", () => {
  // The [ec2] job took the cpu=8 runner. The remaining [ec2] runner cannot run the cpu=8 job.
  const big = { id: 1, labels: ["ec2", "cpu=8"] };
  expect(matchJobs([big], [{ labels: ["ec2"] }]).uncovered).toEqual([big]);
});

test("matchJobs reassigns runners to cover every job it can", () => {
  // A greedy pass that gives the cpu=8 runner to the [ec2] job would strand
  // the cpu=8 job; the matching moves the [ec2] job to the plain runner.
  const small = { id: 1, labels: ["ec2"] };
  const big = { id: 2, labels: ["ec2", "cpu=8"] };
  const runners = [{ labels: ["ec2", "cpu=8"] }, { labels: ["ec2"] }];
  expect(matchJobs([small, big], runners).uncovered).toEqual([]);
  // A third job leaves exactly one job uncovered.
  const third = { id: 3, labels: ["ec2"] };
  expect(matchJobs([small, big, third], runners).uncovered).toHaveLength(1);
});

test("retirableRunners keeps runners a queued job may still need", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const runner = (jobId: number, state: "live" | "launching", instanceId: string | undefined = `i-${jobId}`) => ({
    id: jobId,
    name: runnerName("ec2-runners", jobId, now),
    labels: ["ec2"],
    state,
    instanceId,
  });
  const spare = [runner(1, "live"), runner(2, "live"), runner(3, "launching", undefined)];
  // Job 2 still waits, so its runner stays; job 3's runner is still launching.
  expect(retirableRunners(spare, new Set([2]), "ec2-runners").map((r) => r.id)).toEqual([1]);
});

// ---- MicroVM runners ----

const kinds = { ec2Label: "ec2", microvmLabel: "microvm" };

test("jobKind tells EC2 jobs from MicroVM jobs and rejects labels no runner can satisfy", () => {
  expect(jobKind(["ec2", "cpu=4"], kinds)).toBe("ec2");
  expect(jobKind(["MicroVM"], kinds)).toBe("microvm");
  expect(jobKind(["microvm/run=42"], kinds)).toBe("microvm");
  expect(() => jobKind(["ec2", "microvm"], kinds)).toThrow(/not both/);
  expect(() => jobKind(["microvm", "ram=8"], kinds)).toThrow(JobConfigError);
  expect(() => jobKind(["ec2", "cpu=lots"], kinds)).toThrow(JobConfigError);
  expect(isStackJob(["microvm"], kinds) && isStackJob(["ec2"], kinds) && !isStackJob(["ubuntu-latest"], kinds)).toBe(true);
});

test("microvmIdOf reads the MicroVM ID label", () => {
  expect(microvmIdOf({ labels: [{ name: "microvm" }, { name: "microvm-id=microvm-abc" }] })).toBe("microvm-abc");
  expect(microvmIdOf({ labels: [{ name: "ec2" }] })).toBeUndefined();
});

test("runHookPayload fits an encoded JIT config under RunMicrovm's 4,096-character limit", () => {
  // Sized like a real one: a JIT config's .runner settings, credentials, and
  // 2048-bit RSA key come to about 4,140 characters encoded.
  const encoded = Buffer.from(
    JSON.stringify({ ".runner": "r".repeat(568), ".credentials": randomBase64(225), ".credentials_rsaparams": randomBase64(1632) }),
  ).toString("base64");
  expect(encoded.length).toBeGreaterThan(4096);
  expect(runHookPayload(encoded).length).toBeLessThan(4096);
});

function randomBase64(bytes: number): string {
  return Buffer.from(Array.from({ length: bytes }, () => Math.floor(Math.random() * 256))).toString("base64");
}

const GH_CLI = {
  version: "2.103.3",
  url: "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_arm64.tar.gz",
  sha256: "c".repeat(64),
};
const RUNNER = {
  version: "2.338.2",
  url: "https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-linux-arm64-2.338.2.tar.gz",
  sha256: "a".repeat(64),
};
const NODE = {
  version: "26.13.1",
  url: "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-arm64.tar.gz",
  sha256: "d".repeat(64),
};
const RELEASES = { runner: RUNNER, ghCli: GH_CLI, node: NODE };

test("zipFiles writes an archive that a standard zip reader extracts", () => {
  const { files } = imageSource(RELEASES, 2048);
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const path = join(dir, "source.zip");
  writeFileSync(path, zipFiles(files));
  const read = execFileSync("python3", [
    "-c",
    "import json, sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))",
    path,
  ]);
  expect(JSON.parse(read.toString())).toEqual(files);
  expect(files.Dockerfile).toContain(`echo "${RUNNER.sha256}  /tmp/runner.tgz" | sha256sum -c -`);
  expect(files.Dockerfile).toContain(`echo "${GH_CLI.sha256}  /tmp/gh.tgz" | sha256sum -c -`);
  expect(files.Dockerfile).toContain(`echo "${NODE.sha256}  /tmp/node.tgz" | sha256sum -c -`);
  expect(files.Dockerfile).toContain("touch /home/runner/work/_tool/node/26.13.1/arm64.complete");
});

test("imageSource fingerprints change with the runner, gh, and Node.js releases and the memory size", () => {
  const base = imageSource(RELEASES, 2048).fingerprint;
  expect(imageSource(RELEASES, 2048).fingerprint).toBe(base);
  const next = { version: "2.339.0", url: RUNNER.url.replaceAll("2.338.2", "2.339.0"), sha256: "b".repeat(64) };
  expect(imageSource({ ...RELEASES, runner: next }, 2048).fingerprint).not.toBe(base);
  expect(imageSource(RELEASES, 1024).fingerprint).not.toBe(base);
  const nextNode = { version: "26.13.2", url: NODE.url.replaceAll("26.13.1", "26.13.2"), sha256: "e".repeat(64) };
  expect(imageSource({ ...RELEASES, node: nextNode }, 2048).fingerprint).not.toBe(base);
  expect(imageSource({ ...RELEASES, ghCli: { ...GH_CLI, url: GH_CLI.url.replaceAll("2.103.3", "2.104.0") } }, 2048).fingerprint).not.toBe(base);
});

// A fake Lambda MicroVMs client holding one image and its versions.
function imageClient(image: Record<string, unknown> | undefined, versions: Record<string, Record<string, unknown>> = {}) {
  const calls: { name: string; input: any }[] = [];
  const send = async (cmd: { constructor: { name: string }; input: any }) => {
    calls.push({ name: cmd.constructor.name, input: cmd.input });
    switch (cmd.constructor.name) {
      case "GetMicrovmImageCommand":
        if (!image) throw new ResourceNotFoundException({ message: "no image", $metadata: {} });
        return image;
      case "GetMicrovmImageVersionCommand": {
        const v = versions[cmd.input.imageVersion];
        if (!v) throw new ResourceNotFoundException({ message: "no version", $metadata: {} });
        return v;
      }
      case "ListMicrovmImageVersionsCommand":
        return { items: Object.values(versions) };
      default:
        return {};
    }
  };
  return { client: { send } as any, calls, names: () => calls.map((c) => c.name) };
}
const s3 = () => {
  const puts: any[] = [];
  return { client: { send: async (cmd: { input: unknown }) => (puts.push(cmd.input), {}) } as any, puts };
};
const settings: ImageSettings = {
  imageName: "ec2-runners-runner",
  imageArn: "arn:aws:lambda:us-west-2:1:microvm-image:ec2-runners-runner",
  region: "us-west-2",
  memoryMiB: 2048,
  buildRoleArn: "arn:aws:iam::1:role/build",
  sourceBucket: "source",
  releases: RELEASES,
  maxMinutes: 360,
};
const ARN = "arn:aws:lambda:us-west-2:1:microvm-image:ec2-runners-runner";
const currentDescription = `runner 2.338.2, gh 2.103.3, node 26.13.1, source ${imageSource(RELEASES, 2048).fingerprint}`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

test("ensureMicrovmImage creates the image when it is missing", async () => {
  const lambda = imageClient(undefined);
  const bucket = s3();
  expect((await ensureMicrovmImage(lambda.client, bucket.client, settings)).status).toBe("build started");
  expect(bucket.puts[0]).toMatchObject({ Bucket: "source", Key: `ec2-runners-runner/${imageSource(RELEASES, 2048).fingerprint}.zip` });
  const create = lambda.calls.find((c) => c.name === "CreateMicrovmImageCommand")!.input;
  expect(create).toMatchObject({
    name: "ec2-runners-runner",
    baseImageArn: "arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1",
    description: currentDescription,
    cpuConfigurations: [{ architecture: "ARM_64" }],
    resources: [{ minimumMemoryInMiB: 2048 }],
    hooks: { port: 9000, microvmHooks: { run: "ENABLED" } },
  });
});

test("ensureMicrovmImage leaves a current image alone and deletes versions no MicroVM can use", async () => {
  const lambda = imageClient(
    { imageArn: ARN, state: "UPDATED", latestActiveImageVersion: "3.0" },
    {
      "3.0": { imageVersion: "3.0", description: currentDescription, state: "SUCCESSFUL", createdAt: hoursAgo(10), updatedAt: hoursAgo(9) },
      "2.0": { imageVersion: "2.0", description: "older", state: "SUCCESSFUL" },
      "1.0": { imageVersion: "1.0", description: "broken", state: "FAILED" },
    },
  );
  expect((await ensureMicrovmImage(lambda.client, s3().client, settings)).status).toBe("current");
  expect(
    lambda.calls
      .filter((c) => c.name === "DeleteMicrovmImageVersionCommand")
      .map((c): string => c.input.imageVersion)
      .sort((x, y) => x.localeCompare(y)),
  ).toEqual(["1.0", "2.0"]);
  expect(lambda.names()).not.toContain("UpdateMicrovmImageCommand");
});

test("ensureMicrovmImage keeps the previous version while MicroVMs may still run on it", async () => {
  const lambda = imageClient(
    { imageArn: ARN, state: "UPDATED", latestActiveImageVersion: "3.0" },
    {
      "3.0": { imageVersion: "3.0", description: currentDescription, state: "SUCCESSFUL", createdAt: hoursAgo(1), updatedAt: hoursAgo(1) },
      "2.0": { imageVersion: "2.0", description: "older", state: "SUCCESSFUL" },
    },
  );
  await ensureMicrovmImage(lambda.client, s3().client, settings);
  expect(lambda.names()).not.toContain("DeleteMicrovmImageVersionCommand");
});

test("ensureMicrovmImage rebuilds for a new runner release or a month-old version, and waits out a running build", async () => {
  const stale = imageClient(
    { imageArn: ARN, state: "UPDATED", latestActiveImageVersion: "3.0" },
    { "3.0": { imageVersion: "3.0", description: "runner 2.337.0, gh 2.103.3, source 0", state: "SUCCESSFUL", createdAt: hoursAgo(5) } },
  );
  expect((await ensureMicrovmImage(stale.client, s3().client, settings)).status).toBe("build started");
  expect(stale.calls.find((c) => c.name === "UpdateMicrovmImageCommand")!.input).toMatchObject({
    imageIdentifier: ARN,
    description: currentDescription,
  });

  const old = imageClient(
    { imageArn: ARN, state: "UPDATED", latestActiveImageVersion: "3.0" },
    { "3.0": { imageVersion: "3.0", description: currentDescription, state: "SUCCESSFUL", createdAt: hoursAgo(31 * 24) } },
  );
  expect((await ensureMicrovmImage(old.client, s3().client, settings)).status).toBe("build started");

  const building = imageClient({ imageArn: ARN, state: "UPDATING", latestActiveImageVersion: "3.0" });
  expect((await ensureMicrovmImage(building.client, s3().client, settings)).status).toBe("building");
  expect(building.names()).toEqual(["GetMicrovmImageCommand"]);
});

test("ensureMicrovmImage retries a failed build of the same inputs only after six hours", async () => {
  const failed = (hours: number) =>
    imageClient(
      { imageArn: ARN, state: "UPDATE_FAILED", latestFailedImageVersion: "4.0" },
      { "4.0": { imageVersion: "4.0", description: currentDescription, state: "FAILED", stateReason: "boom", updatedAt: hoursAgo(hours) } },
    );
  const recent = await ensureMicrovmImage(failed(1).client, s3().client, settings);
  expect(recent).toEqual({ status: "build failed", failure: { version: "4.0", reason: "boom", newlyFailed: false } });
  expect((await ensureMicrovmImage(failed(7).client, s3().client, settings)).status).toBe("build started");
});

test("ensureMicrovmImage builds when the image's latest failed version has been deleted", async () => {
  const lambda = imageClient(
    { imageArn: ARN, state: "UPDATED", latestActiveImageVersion: "2.0", latestFailedImageVersion: "1.0" },
    { "2.0": { imageVersion: "2.0", description: "runner 2.338.2, gh 2.103.3, source old", state: "SUCCESSFUL", createdAt: hoursAgo(5) } },
  );
  expect((await ensureMicrovmImage(lambda.client, s3().client, settings)).status).toBe("build started");
  expect(lambda.names()).toContain("UpdateMicrovmImageCommand");
});

// nodejs.org's release index and checksums, answered by a stubbed fetch.
function stubNodejsOrg(shasums: string) {
  const index = [
    { version: "v27.0.0", lts: false },
    { version: "v26.13.1", lts: "Lithium" },
    { version: "v24.22.3", lts: "Krypton" },
  ];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "https://nodejs.org/dist/index.json") return new Response(JSON.stringify(index));
    if (url === "https://nodejs.org/dist/v26.13.1/SHASUMS256.txt") return new Response(shasums);
    return new Response("not found", { status: 404 });
  });
}
afterEach(() => vi.unstubAllGlobals());

test("nodeDownload picks the newest LTS release and its ARM64 checksum", async () => {
  stubNodejsOrg(`${"1".repeat(64)}  node-v26.13.1-linux-x64.tar.gz\n${"2".repeat(64)}  node-v26.13.1-linux-arm64.tar.gz\n`);
  expect(await nodeDownload()).toEqual({
    version: "26.13.1",
    url: "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-arm64.tar.gz",
    sha256: "2".repeat(64),
  });
});

test("nodeDownload fails when the release has no ARM64 checksum", async () => {
  stubNodejsOrg(`${"1".repeat(64)}  node-v26.13.1-linux-x64.tar.gz\n`);
  await expect(nodeDownload()).rejects.toThrow("no checksum for node-v26.13.1-linux-arm64.tar.gz");
});
