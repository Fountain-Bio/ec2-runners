import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceRequirements, parseLabels } from "../src/labels.mjs";
import { appJwt, verifySignature } from "../src/github.mjs";
import { buildUserData } from "../src/userdata.mjs";
import { launchRunner, shuffled } from "../src/ec2.mjs";

test("parseLabels returns null without the trigger label", () => {
  assert.equal(parseLabels(["ubuntu-latest"]), null);
  assert.equal(parseLabels(["self-hosted", "cpu=4"]), null);
});

test("parseLabels applies defaults", () => {
  const spec = parseLabels(["ec2"]);
  assert.deepEqual(
    { cpu: spec.cpu, ram: spec.ram, image: spec.image, disk: spec.disk, spot: spec.spot },
    { cpu: 2, ram: 4, image: "ubuntu24-full-x64", disk: 40, spot: true },
  );
});

test("parseLabels reads array and slash forms the same way", () => {
  const a = parseLabels(["ec2", "cpu=8", "ram=32", "family=c7i+m7i", "image=ubuntu24-full-arm64", "disk=100", "spot=false", "run=123"]);
  const b = parseLabels(["ec2/cpu=8/ram=32/family=c7i+m7i/image=ubuntu24-full-arm64/disk=100/spot=false/run=123"]);
  assert.deepEqual(a, b);
  assert.equal(a.cpu, 8);
  assert.equal(a.ram, 32);
  assert.deepEqual(a.families, ["c7i", "m7i"]);
  assert.equal(a.spot, false);
});

test("parseLabels honors a custom trigger label", () => {
  assert.ok(parseLabels(["linux", "cpu=4"], "linux"));
  assert.equal(parseLabels(["ec2"], "linux"), null);
  assert.ok(parseLabels(["EC2", "cpu=4"]), "trigger label match is case-insensitive");
});

test("parseLabels rejects bad numbers", () => {
  assert.throws(() => parseLabels(["ec2", "cpu=abc"]), /positive integer/);
  assert.throws(() => parseLabels(["ec2", "cpu=0"]), /positive integer/);
  assert.throws(() => parseLabels(["ec2", "cpu=500"]), /192/);
});

test("instanceRequirements pins vCPUs and maps families to wildcards", () => {
  const req = instanceRequirements(parseLabels(["ec2", "cpu=16", "family=c7i+m7i.4xlarge"]));
  assert.deepEqual(req.VCpuCount, { Min: 16, Max: 16 });
  assert.deepEqual(req.MemoryMiB, { Min: 32 * 1024 });
  assert.deepEqual(req.AllowedInstanceTypes, ["c7i.*", "m7i.4xlarge"]);
  assert.equal(req.BurstablePerformance, "excluded");
  assert.equal(instanceRequirements(parseLabels(["ec2"])).AllowedInstanceTypes, undefined);
});

test("nvme=true requires local SSD storage", () => {
  const spec = parseLabels(["ec2", "nvme=true", "cpu=8"]);
  assert.equal(spec.nvme, true);
  const req = instanceRequirements(spec);
  assert.equal(req.LocalStorage, "required");
  assert.deepEqual(req.LocalStorageTypes, ["ssd"]);
  assert.equal(instanceRequirements(parseLabels(["ec2"])).LocalStorage, undefined);
  assert.equal(parseLabels(["ec2", "nvme=false"]).nvme, false);
});

test("verifySignature accepts GitHub's format and rejects tampering", () => {
  const body = Buffer.from('{"action":"queued"}');
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature("s3cret", body, sig), true);
  assert.equal(verifySignature("wrong", body, sig), false);
  assert.equal(verifySignature("s3cret", Buffer.from("{}"), sig), false);
  assert.equal(verifySignature("s3cret", body, undefined), false);
  assert.equal(verifySignature("s3cret", body, "sha256=short"), false);
});

test("appJwt produces an RS256 token GitHub can verify", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const jwt = appJwt("12345", privateKey, 1_000_000);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 999_940, exp: 1_000_540, iss: "12345" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url"));
});

test("buildUserData produces valid bash with the JIT config and cache settings", () => {
  const b64 = buildUserData({
    jitConfig: "eyJhYmMiOiAxfQ==",
    cacheBucket: "my-cache",
    region: "us-west-2",
    maxMinutes: 360,
  });
  const script = Buffer.from(b64, "base64").toString("utf8");
  assert.ok(script.startsWith("#!/bin/bash\n"));
  assert.match(script, /JIT_CONFIG='eyJhYmMiOiAxfQ=='/);
  assert.match(script, /RUNS_ON_S3_BUCKET_CACHE=\$CACHE_BUCKET/);
  assert.match(script, /shutdown -h \+360/);
  assert.match(script, /run\.sh --jitconfig/);
  assert.match(script, /ACTIONS_RUNNER_HOOK_JOB_STARTED=\$HOOK_DIR\/job-started\.sh/);
  assert.match(script, /mount --bind \/mnt\/nvme\/docker \/var\/lib\/docker/);
  assert.doesNotMatch(script, /ecr/i);
  const dir = mkdtempSync(join(tmpdir(), "userdata-"));
  const file = join(dir, "boot.sh");
  writeFileSync(file, script);
  execFileSync("bash", ["-n", file]); // throws on a syntax error
});

test("buildUserData quotes values containing single quotes", () => {
  const script = Buffer.from(buildUserData({ jitConfig: "a'b", cacheBucket: "c", region: "r", maxMinutes: 10 }), "base64").toString();
  assert.match(script, /JIT_CONFIG='a'\\''b'/);
});

function fakeEc2(fleetResponses) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (name === "CreateLaunchTemplateVersionCommand") return { LaunchTemplateVersion: { VersionNumber: 7 } };
      if (name === "CreateFleetCommand") return fleetResponses.shift();
      if (name === "DeleteLaunchTemplateVersionsCommand") return {};
      throw new Error(`unexpected ${name}`);
    },
  };
}

const launchOpts = (spec) => ({
  launchTemplateId: "lt-123",
  sourceVersion: 1,
  random: () => 0.999, // keeps subnet order unchanged
  subnetIds: ["subnet-a", "subnet-b"],
  spec,
  ami: { imageId: "ami-abc", rootDeviceName: "/dev/sda1", snapshotSizeGiB: 30 },
  userData: "dXNlcmRhdGE=",
  tags: { Name: "r-1", "ec2-runners:runner-name": "r-1", "ec2-runners:stack": "r" },
  log: () => {},
});

test("launchRunner tries spot in each subnet, then on-demand, one subnet per call", async () => {
  const noCapacity = { Instances: [], Errors: [{ ErrorCode: "InsufficientInstanceCapacity", ErrorMessage: "none" }] };
  const ec2 = fakeEc2([
    noCapacity,
    noCapacity,
    { Instances: [{ InstanceIds: ["i-1"], InstanceType: "c7i.xlarge", Lifecycle: "on-demand" }] },
  ]);
  const result = await launchRunner(ec2, launchOpts(parseLabels(["ec2", "cpu=4", "disk=80"])));
  assert.deepEqual(result, { instanceId: "i-1", instanceType: "c7i.xlarge", lifecycle: "on-demand", subnetId: "subnet-a" });

  const names = ec2.calls.map((c) => c.name);
  assert.deepEqual(names, [
    "CreateLaunchTemplateVersionCommand",
    "CreateFleetCommand",
    "CreateFleetCommand",
    "CreateFleetCommand",
    "DeleteLaunchTemplateVersionsCommand",
  ]);

  const version = ec2.calls[0].input;
  assert.equal(version.SourceVersion, "1");
  assert.equal(version.LaunchTemplateData.ImageId, "ami-abc");
  assert.equal(version.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize, 80);
  assert.equal(version.LaunchTemplateData.BlockDeviceMappings[0].DeviceName, "/dev/sda1");

  const fleets = ec2.calls.filter((c) => c.name === "CreateFleetCommand").map((c) => c.input);
  for (const f of fleets) {
    assert.equal(f.Type, "instant");
    assert.equal(f.LaunchTemplateConfigs[0].LaunchTemplateSpecification.Version, "7");
    assert.equal(f.LaunchTemplateConfigs[0].Overrides.length, 1);
    assert.deepEqual(f.LaunchTemplateConfigs[0].Overrides[0].InstanceRequirements.VCpuCount, { Min: 4, Max: 4 });
  }
  assert.deepEqual(
    fleets.map((f) => [f.TargetCapacitySpecification.DefaultTargetCapacityType, f.LaunchTemplateConfigs[0].Overrides[0].SubnetId]),
    [["spot", "subnet-a"], ["spot", "subnet-b"], ["on-demand", "subnet-a"]],
  );
  assert.equal(fleets[0].SpotOptions.AllocationStrategy, "price-capacity-optimized");
  assert.equal(fleets[2].OnDemandOptions.AllocationStrategy, "lowest-price");
  assert.deepEqual(ec2.calls.at(-1).input, { LaunchTemplateId: "lt-123", Versions: ["7"] });
});

test("launchRunner raises the disk to the AMI snapshot size", async () => {
  const ec2 = fakeEc2([{ Instances: [{ InstanceIds: ["i-2"] }] }]);
  await launchRunner(ec2, launchOpts(parseLabels(["ec2", "disk=10"])));
  assert.equal(ec2.calls[0].input.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize, 30);
});

test("launchRunner with spot=false skips spot and reports every failure", async () => {
  const fail = { Instances: [], Errors: [{ ErrorCode: "X", ErrorMessage: "nope" }] };
  const ec2 = fakeEc2([fail, fail]);
  await assert.rejects(launchRunner(ec2, launchOpts(parseLabels(["ec2", "spot=false"]))), /on-demand subnet-a: X: nope \| on-demand subnet-b: X: nope/);
  const fleets = ec2.calls.filter((c) => c.name === "CreateFleetCommand");
  assert.equal(fleets.length, 2);
  assert.ok(fleets.every((f) => f.input.TargetCapacitySpecification.DefaultTargetCapacityType === "on-demand"));
  assert.equal(ec2.calls.at(-1).name, "DeleteLaunchTemplateVersionsCommand");
});

test("shuffled keeps every item", () => {
  assert.deepEqual(shuffled(["a", "b", "c"], () => 0).sort(), ["a", "b", "c"]);
});
