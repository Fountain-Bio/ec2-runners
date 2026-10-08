import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const WEBHOOK_SECRET = "hook-secret";

Object.assign(process.env, {
  AWS_REGION: "us-west-2",
  SECRET_ARN: "arn:secret",
  GITHUB_ORG: "example-org",
  TRIGGER_LABEL: "ec2",
  RUNNER_GROUP_ID: "1",
  RUNNER_PREFIX: "ec2-runners",
  LAUNCHER_FUNCTION: "ec2-runners-launcher",
  LAUNCH_TEMPLATE_ID: "lt-1",
  LAUNCH_TEMPLATE_VERSION: "1",
  SUBNET_IDS: "subnet-a,subnet-b,subnet-c",
  CACHE_BUCKET: "cache-bucket",
  IDLE_MINUTES: "20",
  MAX_MINUTES: "360",
  AMI_OWNER: "135269210855",
  AMI_NAME_PREFIX: "runs-on-v2.2-",
  RUNNER_VERSION: "latest",
});

// ---- AWS stubs: every client shares its prototype's send() ----
let awsCalls = [];
let ec2Handler = () => ({});
SecretsManagerClient.prototype.send = async () => ({
  SecretString: JSON.stringify({ appId: "42", privateKey, webhookSecret: WEBHOOK_SECRET }),
});
LambdaClient.prototype.send = async (cmd) => {
  awsCalls.push({ name: cmd.constructor.name, input: cmd.input });
  return { StatusCode: 202 };
};
EC2Client.prototype.send = async (cmd) => {
  awsCalls.push({ name: cmd.constructor.name, input: cmd.input });
  return ec2Handler(cmd.constructor.name, cmd.input);
};

// ---- GitHub stub ----
let ghCalls = [];
let ghRoutes = {};
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname + new URL(url).search;
  const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
  ghCalls.push({ key, path, body: init.body ? JSON.parse(init.body) : undefined });
  const route = ghRoutes[key];
  if (!route) return new Response(`no route for ${key}`, { status: 500 });
  const { status = 200, body } = typeof route === "function" ? route(path) : route;
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
};

const baseRoutes = () => ({
  "GET /orgs/example-org/installation": { body: { id: 99 } },
  "POST /app/installations/99/access_tokens": {
    status: 201,
    body: { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() },
  },
});

const { webhook, launcher, janitor } = await import("../src/index.mjs");

beforeEach(() => {
  awsCalls = [];
  ghCalls = [];
  ghRoutes = baseRoutes();
  ec2Handler = () => ({});
});

function delivery(eventName, payload, { secret = WEBHOOK_SECRET, base64 = false } = {}) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return {
    headers: { "X-GitHub-Event": eventName, "X-Hub-Signature-256": sig, "X-GitHub-Delivery": "d-1" },
    body: base64 ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: base64,
  };
}

const queued = (labels, org = "example-org") => ({
  action: "queued",
  organization: { login: org },
  repository: { full_name: `${org}/app` },
  workflow_job: { id: 555, run_id: 777, labels },
});

test("webhook rejects a bad signature", async () => {
  const res = await webhook(delivery("workflow_job", queued(["ec2"]), { secret: "nope" }));
  assert.equal(res.statusCode, 401);
  assert.equal(awsCalls.length, 0);
});

test("webhook hands queued ec2 jobs to the launcher asynchronously", async () => {
  const res = await webhook(delivery("workflow_job", queued(["ec2", "cpu=4"]), { base64: true }));
  assert.equal(res.statusCode, 202);
  assert.equal(awsCalls.length, 1);
  assert.equal(awsCalls[0].name, "InvokeCommand");
  assert.equal(awsCalls[0].input.InvocationType, "Event");
  assert.equal(awsCalls[0].input.FunctionName, "ec2-runners-launcher");
  assert.deepEqual(JSON.parse(Buffer.from(awsCalls[0].input.Payload).toString()), {
    jobId: 555,
    runId: 777,
    repo: "example-org/app",
    labels: ["ec2", "cpu=4"],
  });
});

test("webhook ignores other events, actions, orgs, and labels", async () => {
  const cases = [
    delivery("ping", { zen: "hi" }),
    delivery("workflow_job", { ...queued(["ec2"]), action: "completed" }),
    delivery("workflow_job", queued(["ec2"], "someone-else")),
    delivery("workflow_job", queued(["ubuntu-latest"])),
    delivery("workflow_job", queued(["ec2", "cpu=lots"])),
  ];
  for (const event of cases) {
    const res = await webhook(event);
    assert.equal(res.statusCode, 200, res.body);
  }
  assert.equal(awsCalls.length, 0);
});

test("launcher registers a JIT runner and launches an instance", async () => {
  ghRoutes["POST /orgs/example-org/actions/runners/generate-jitconfig"] = {
    status: 201,
    body: { runner: { id: 1001 }, encoded_jit_config: "JITCFG" },
  };
  ec2Handler = (name) => {
    if (name === "DescribeImagesCommand")
      return {
        Images: [
          { ImageId: "ami-old", CreationDate: "2026-09-01T00:00:00Z", RootDeviceName: "/dev/sda1" },
          {
            ImageId: "ami-new",
            CreationDate: "2026-10-01T00:00:00Z",
            RootDeviceName: "/dev/sda1",
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 75 } }],
          },
        ],
      };
    if (name === "CreateLaunchTemplateVersionCommand") return { LaunchTemplateVersion: { VersionNumber: 3 } };
    if (name === "CreateFleetCommand") return { Instances: [{ InstanceIds: ["i-9"], InstanceType: "c7a.xlarge", Lifecycle: "spot" }] };
    return {};
  };

  const result = await launcher({ jobId: 555, runId: 777, repo: "example-org/app", labels: ["ec2", "cpu=4"] });
  assert.equal(result.instanceId, "i-9");
  assert.equal(result.lifecycle, "spot");

  const jit = ghCalls.find((c) => c.key.endsWith("generate-jitconfig"));
  assert.deepEqual(jit.body, { name: "ec2-runners-555", runner_group_id: 1, labels: ["ec2", "cpu=4"] });

  const images = awsCalls.find((c) => c.name === "DescribeImagesCommand").input;
  assert.deepEqual(images.Owners, ["135269210855"]);
  assert.deepEqual(images.Filters[0], { Name: "name", Values: ["runs-on-v2.2-ubuntu24-full-x64-*"] });

  const version = awsCalls.find((c) => c.name === "CreateLaunchTemplateVersionCommand").input;
  assert.equal(version.LaunchTemplateData.ImageId, "ami-new");
  assert.equal(version.SourceVersion, "1");
  assert.equal(version.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize, 75, "disk raised to snapshot size");
  const script = Buffer.from(version.LaunchTemplateData.UserData, "base64").toString();
  assert.match(script, /JIT_CONFIG='JITCFG'/);
  assert.match(script, /CACHE_BUCKET='cache-bucket'/);
  const tags = Object.fromEntries(version.LaunchTemplateData.TagSpecifications[0].Tags.map((t) => [t.Key, t.Value]));
  assert.equal(tags["ec2-runners:stack"], "ec2-runners");
  assert.equal(tags["ec2-runners:runner-name"], "ec2-runners-555");

  const fleet = awsCalls.find((c) => c.name === "CreateFleetCommand").input;
  assert.equal(fleet.LaunchTemplateConfigs[0].Overrides.length, 1);
  assert.ok(["subnet-a", "subnet-b", "subnet-c"].includes(fleet.LaunchTemplateConfigs[0].Overrides[0].SubnetId));
  assert.equal(result.subnetId, fleet.LaunchTemplateConfigs[0].Overrides[0].SubnetId);
});

test("launcher skips a job that already has a runner", async () => {
  ghRoutes["POST /orgs/example-org/actions/runners/generate-jitconfig"] = { status: 409, body: { message: "Already exists" } };
  const result = await launcher({ jobId: 555, runId: 777, repo: "r", labels: ["ec2"] });
  assert.deepEqual(result, { skipped: true });
  assert.equal(awsCalls.length, 0);
});

test("launcher deletes the runner registration when the launch fails", async () => {
  ghRoutes["POST /orgs/example-org/actions/runners/generate-jitconfig"] = {
    status: 201,
    body: { runner: { id: 2002 }, encoded_jit_config: "JIT" },
  };
  ghRoutes["DELETE /orgs/example-org/actions/runners/2002"] = { status: 204 };
  ec2Handler = (name) => {
    if (name === "DescribeImagesCommand") return { Images: [] };
    return {};
  };
  await assert.rejects(launcher({ jobId: 556, runId: 1, repo: "r", labels: ["ec2", "image=does-not-exist"] }), /No AMI found/);
  assert.ok(ghCalls.some((c) => c.key === "DELETE /orgs/example-org/actions/runners/2002"));
});

test("janitor terminates idle and expired instances and removes their registrations", async () => {
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  ec2Handler = (name) => {
    if (name === "DescribeInstancesCommand")
      return {
        Reservations: [
          {
            Instances: [
              // booting, too young to judge
              { InstanceId: "i-young", State: { Name: "running" }, LaunchTime: minutesAgo(3), Tags: [{ Key: "ec2-runners:runner-name", Value: "ec2-runners-1" }] },
              // old and busy: keep
              { InstanceId: "i-busy", State: { Name: "running" }, LaunchTime: minutesAgo(60), Tags: [{ Key: "ec2-runners:runner-name", Value: "ec2-runners-2" }] },
              // old and never picked up a job: terminate
              { InstanceId: "i-idle", State: { Name: "running" }, LaunchTime: minutesAgo(30), Tags: [{ Key: "ec2-runners:runner-name", Value: "ec2-runners-3" }] },
              // past max lifetime even though busy: terminate
              { InstanceId: "i-old", State: { Name: "running" }, LaunchTime: minutesAgo(400), Tags: [{ Key: "ec2-runners:runner-name", Value: "ec2-runners-4" }] },
              // already terminated; its registration is stale
              { InstanceId: "i-gone", State: { Name: "terminated" }, LaunchTime: minutesAgo(50), Tags: [{ Key: "ec2-runners:runner-name", Value: "ec2-runners-5" }] },
            ],
          },
        ],
      };
    return {};
  };
  ghRoutes["GET /orgs/example-org/actions/runners"] = {
    body: {
      runners: [
        { id: 1, name: "ec2-runners-1", busy: false, status: "offline" },
        { id: 2, name: "ec2-runners-2", busy: true, status: "online" },
        { id: 3, name: "ec2-runners-3", busy: false, status: "online" },
        { id: 4, name: "ec2-runners-4", busy: true, status: "online" },
        { id: 5, name: "ec2-runners-5", busy: false, status: "offline" },
        // registered moments ago, instance not visible yet: leave alone
        { id: 6, name: "ec2-runners-6", busy: false, status: "offline" },
        { id: 7, name: "other-runner", busy: false, status: "offline" },
      ],
    },
  };
  for (const id of [3, 5]) ghRoutes[`DELETE /orgs/example-org/actions/runners/${id}`] = { status: 204 };

  const result = await janitor();
  assert.deepEqual(result.terminated.sort(), ["i-idle", "i-old"]);
  assert.deepEqual(result.removedRunners.sort(), ["ec2-runners-3", "ec2-runners-5"]);
  const terminate = awsCalls.find((c) => c.name === "TerminateInstancesCommand");
  assert.deepEqual(terminate.input.InstanceIds.sort(), ["i-idle", "i-old"]);
});
