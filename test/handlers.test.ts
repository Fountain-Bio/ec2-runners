import { beforeEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { EC2Client } from "@aws-sdk/client-ec2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { runnerName } from "../src/pool.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const WEBHOOK_SECRET = "hook-secret";
const RUNNER_SHA256 = "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32";
const PREFIX = "ec2-runners";

// src/index.ts reads its configuration at import time, so this runs before the import.
Object.assign(process.env, {
  AWS_REGION: "us-west-2",
  SECRET_ARN: "arn:secret",
  GITHUB_ORG: "example-org",
  TRIGGER_LABEL: "ec2",
  RUNNER_GROUP_ID: "1",
  RUNNER_PREFIX: PREFIX,
  RECONCILER_FUNCTION: "ec2-runners-reconciler",
  JOBS_TABLE: "ec2-runners-jobs",
  ALERT_TOPIC_ARN: "arn:topic",
  LAUNCH_TEMPLATE_ID: "lt-1",
  LAUNCH_TEMPLATE_VERSION: "1",
  SUBNET_IDS: "subnet-a,subnet-b,subnet-c",
  CACHE_BUCKET: "cache-bucket",
  IDLE_MINUTES: "20",
  MAX_MINUTES: "360",
  AMI_OWNER: "135269210855",
  AMI_NAME_PREFIX: "runs-on-v2.2-",
  RUNNER_VERSION: "latest",
  ALLOW_PUBLIC_REPOS: "false",
});

interface Call {
  name: string;
  // Each command's input has a different shape; the assertions know which one they read.
  input: any;
}
type Command = { constructor: { name: string }; input: any };

// ---- AWS stubs: every client shares its prototype's send() ----
let awsCalls: Call[] = [];
let ec2Handler: (name: string, input: any) => object = () => ({});
const record = (cmd: Command) => awsCalls.push({ name: cmd.constructor.name, input: cmd.input });
Object.assign(SecretsManagerClient.prototype, {
  send: async () => ({
    SecretString: JSON.stringify({ appId: "42", privateKey, webhookSecret: WEBHOOK_SECRET }),
  }),
});
Object.assign(LambdaClient.prototype, {
  send: async (cmd: Command) => (record(cmd), { StatusCode: 202 }),
});
Object.assign(SNSClient.prototype, {
  send: async (cmd: Command) => (record(cmd), { MessageId: "m-1" }),
});
Object.assign(EC2Client.prototype, {
  send: async (cmd: Command) => (record(cmd), ec2Handler(cmd.constructor.name, cmd.input)),
});

// ---- Jobs table stub: an in-memory table that understands the store's requests ----
let table = new Map<number, Record<string, any>>();
const conditionFailed = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
Object.assign(DynamoDBDocumentClient.prototype, {
  send: async (cmd: Command) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case "PutCommand":
        if (table.has(input.Item.jobId)) throw conditionFailed();
        table.set(input.Item.jobId, { ...input.Item });
        return {};
      case "UpdateCommand": {
        const row = table.get(input.Key.jobId) ?? { jobId: input.Key.jobId };
        const values = input.ExpressionAttributeValues;
        if (input.UpdateExpression.startsWith("ADD launchFailures")) {
          row.launchFailures = (row.launchFailures ?? 0) + 1;
          table.set(row.jobId, row);
          return { Attributes: { launchFailures: row.launchFailures } };
        }
        if (input.ConditionExpression && row.status !== values[":queued"]) throw conditionFailed();
        row.status = values[":done"] ?? values[":failed"];
        if (values[":error"]) row.error = values[":error"];
        table.set(row.jobId, row);
        return {};
      }
      case "ScanCommand":
        return { Items: [...table.values()].filter((r) => r.status === "queued") };
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  },
});

// ---- GitHub stub: Octokit sends every request through globalThis.fetch ----
type Route = { status?: number; body?: unknown };
let ghCalls: { key: string; search: string; body: any }[] = [];
let ghRoutes: Record<string, Route> = {};
Object.assign(globalThis, {
  fetch: async (url: string, init: RequestInit = {}) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method ?? "GET"} ${pathname}`;
    ghCalls.push({ key, search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = ghRoutes[key];
    const res = route
      ? new Response(route.status === 204 ? null : JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { "content-type": "application/json" },
        })
      : new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 500, headers: { "content-type": "application/json" } });
    // A real fetch response carries its URL, which Octokit's paginator reads.
    return Object.defineProperty(res, "url", { value: url });
  },
});

const baseRoutes = (): Record<string, Route> => ({
  "GET /orgs/example-org/installation": { body: { id: 99 } },
  "POST /app/installations/99/access_tokens": {
    status: 201,
    body: { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" },
  },
  "GET /repos/actions/runner/releases/latest": {
    body: {
      tag_name: "v2.338.0",
      assets: ["x64", "arm64"].map((arch) => ({
        name: `actions-runner-linux-${arch}-2.338.0.tar.gz`,
        browser_download_url: `https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-linux-${arch}-2.338.0.tar.gz`,
        digest: `sha256:${RUNNER_SHA256}`,
      })),
    },
  },
  "GET /orgs/example-org/actions/runners": { body: { total_count: 0, runners: [] } },
  "POST /orgs/example-org/actions/runners/generate-jitconfig": {
    status: 201,
    body: { runner: { id: 1001, name: "registered" }, encoded_jit_config: "JITCFG" },
  },
});

// GitHub's view of a job, for GET /repos/{repo}/actions/jobs/{id}.
function githubJob(repo: string, id: number, status = "queued") {
  ghRoutes[`GET /repos/${repo}/actions/jobs/${id}`] = {
    body: { id, run_id: 777, status, labels: [], runner_name: null, html_url: `https://github.com/${repo}/actions/runs/777/job/${id}` },
  };
}

// A runner registration as GitHub lists it.
const registration = (id: number, name: string, labels: string[], busy = false) => ({
  id,
  name,
  busy,
  status: busy ? "online" : "offline",
  labels: labels.map((l) => ({ name: l })),
});

const instance = (id: string, state: string, launchedMinutesAgo: number, runner: string) => ({
  InstanceId: id,
  State: { Name: state },
  LaunchTime: new Date(Date.now() - launchedMinutesAgo * 60_000).toISOString(),
  Tags: [{ Key: "ec2-runners:runner-name", Value: runner }],
});

// EC2 answers for launches that succeed on the first fleet call. `instances`
// is what DescribeInstances reports.
function ec2With({ instances = [] as object[], instanceTypes = ["c7a.xlarge"], fleet = "ok" as "ok" | "no-capacity" } = {}) {
  return (name: string): object => {
    if (name === "DescribeInstancesCommand") return { Reservations: [{ Instances: instances }] };
    if (name === "DescribeImagesCommand")
      return {
        Images: [
          {
            ImageId: "ami-new",
            Architecture: "x86_64",
            CreationDate: "2026-10-01T00:00:00Z",
            RootDeviceName: "/dev/sda1",
            BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 75 } }],
          },
        ],
      };
    if (name === "GetInstanceTypesFromInstanceRequirementsCommand") return { InstanceTypes: instanceTypes.map((t) => ({ InstanceType: t })) };
    if (name === "CreateLaunchTemplateVersionCommand") return { LaunchTemplateVersion: { VersionNumber: 3 } };
    if (name === "CreateFleetCommand")
      return fleet === "ok"
        ? { Instances: [{ InstanceIds: ["i-9"], InstanceType: "c7a.xlarge", Lifecycle: "spot" }] }
        : { Instances: [], Errors: [{ ErrorCode: "InsufficientInstanceCapacity", ErrorMessage: "none" }] };
    return {};
  };
}

const queuedRow = (jobId: number, labels: string[], repo = "example-org/app") =>
  table.set(jobId, { jobId, repo, runId: 777, labels, status: "queued", launchFailures: 0 });

const { webhook, reconciler, janitor } = await import("../src/index.ts");

beforeEach(() => {
  awsCalls = [];
  ghCalls = [];
  ghRoutes = baseRoutes();
  ec2Handler = ec2With();
  table = new Map();
});

// Builds a function URL event the way Lambda delivers a signed GitHub webhook.
function delivery(eventName: string, payload: object, { secret = WEBHOOK_SECRET, base64 = false } = {}): LambdaFunctionURLEvent {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return {
    headers: { "X-GitHub-Event": eventName, "X-Hub-Signature-256": sig, "X-GitHub-Delivery": "d-1" },
    body: base64 ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: base64,
  } as Partial<LambdaFunctionURLEvent> as LambdaFunctionURLEvent;
}

const jobEvent = (action: string, labels: string[], { org = "example-org", isPrivate = true, id = 555, runnerName = null as string | null } = {}) => ({
  action,
  organization: { login: org },
  repository: { full_name: `${org}/app`, private: isPrivate },
  workflow_job: { id, run_id: 777, labels, runner_name: runnerName, html_url: `https://github.com/${org}/app/actions/runs/777/job/${id}` },
});

const reconcilerInvokes = () => awsCalls.filter((c) => c.name === "InvokeCommand");
const alerts = () => awsCalls.filter((c) => c.name === "PublishCommand").map((c) => c.input);
const fleetCalls = () => awsCalls.filter((c) => c.name === "CreateFleetCommand");

test("webhook rejects a bad signature", async () => {
  const res = await webhook(delivery("workflow_job", jobEvent("queued", ["ec2"]), { secret: "nope" }));
  expect(res.statusCode).toBe(401);
  expect(awsCalls).toHaveLength(0);
});

test("webhook records a queued ec2 job and invokes the reconciler", async () => {
  const res = await webhook(delivery("workflow_job", jobEvent("queued", ["ec2", "cpu=4"]), { base64: true }));
  expect(res.statusCode).toBe(202);
  expect(table.get(555)).toMatchObject({ repo: "example-org/app", runId: 777, labels: ["ec2", "cpu=4"], status: "queued" });
  expect(reconcilerInvokes()).toHaveLength(1);
  expect(reconcilerInvokes()[0]!.input).toMatchObject({ FunctionName: "ec2-runners-reconciler", InvocationType: "Event" });
});

test("webhook ignores other events, actions, orgs, labels, and public repositories", async () => {
  const cases = [
    delivery("ping", { zen: "hi" }),
    delivery("workflow_job", jobEvent("waiting", ["ec2"])),
    delivery("workflow_job", jobEvent("queued", ["ec2"], { org: "someone-else" })),
    delivery("workflow_job", jobEvent("queued", ["ubuntu-latest"])),
    delivery("workflow_job", jobEvent("queued", ["ec2"], { isPrivate: false })),
  ];
  for (const event of cases) {
    const res = await webhook(event);
    expect(res.statusCode, res.body).toBe(200);
  }
  expect(awsCalls).toHaveLength(0);
  expect(table.size).toBe(0);
});

test("webhook alerts on labels that can never launch", async () => {
  const res = await webhook(delivery("workflow_job", jobEvent("queued", ["ec2", "cpu=lots"])));
  expect(res.statusCode).toBe(200);
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]!.Message).toContain("cpu=lots");
  expect(table.size).toBe(0);
  expect(reconcilerInvokes()).toHaveLength(0);
});

test("webhook marks started and completed jobs done", async () => {
  queuedRow(555, ["ec2"]);
  const ownRunner = runnerName(PREFIX, 555);
  await webhook(delivery("workflow_job", jobEvent("in_progress", ["ec2"], { runnerName: ownRunner })));
  expect(table.get(555)?.status).toBe("done");
  // A job on the runner launched for it changes nothing for other jobs.
  expect(reconcilerInvokes()).toHaveLength(0);

  await webhook(delivery("workflow_job", jobEvent("completed", ["ec2"], { id: 556 })));
  expect(table.get(556)?.status).toBe("done");
});

test("webhook reconciles when a job starts on a runner launched for another job", async () => {
  const res = await webhook(delivery("workflow_job", jobEvent("in_progress", ["ec2"], { id: 600, runnerName: runnerName(PREFIX, 555) })));
  expect(res.statusCode).toBe(202);
  expect(reconcilerInvokes()).toHaveLength(1);
});

test("a queued event that arrives after the start event leaves the job done", async () => {
  await webhook(delivery("workflow_job", jobEvent("in_progress", ["ec2"], { runnerName: runnerName(PREFIX, 555) })));
  await webhook(delivery("workflow_job", jobEvent("queued", ["ec2"])));
  expect(table.get(555)?.status).toBe("done");
});

test("reconciler launches a runner for a queued job with none available", async () => {
  queuedRow(555, ["ec2", "cpu=4"]);
  githubJob("example-org/app", 555);

  const result = await reconciler();
  expect(result.outcomes).toEqual({ 555: "launched" });

  const jit = ghCalls.find((c) => c.key.endsWith("generate-jitconfig"))!;
  expect(jit.body.name).toMatch(/^ec2-runners-555-[0-9a-z]+$/);
  expect(jit.body).toMatchObject({ runner_group_id: 1, labels: ["ec2", "cpu=4"] });

  const version = awsCalls.find((c) => c.name === "CreateLaunchTemplateVersionCommand")!.input;
  expect(version.LaunchTemplateData.ImageId).toBe("ami-new");
  // The default 40 GiB disk is raised to the 75 GiB snapshot size.
  expect(version.LaunchTemplateData.BlockDeviceMappings[0].Ebs.VolumeSize).toBe(75);
  const script = Buffer.from(version.LaunchTemplateData.UserData, "base64").toString();
  expect(script).toMatch(/JIT_CONFIG='JITCFG'/);
  expect(script).toContain(`RUNNER_SHA256='${RUNNER_SHA256}'`);
  expect(script).toContain("actions-runner-linux-x64-2.338.0.tar.gz");
  const tags = Object.fromEntries(
    version.LaunchTemplateData.TagSpecifications[0].Tags.map((t: { Key: string; Value: string }) => [t.Key, t.Value]),
  );
  expect(tags).toMatchObject({
    "ec2-runners:stack": PREFIX,
    "ec2-runners:runner-name": jit.body.name,
    "ec2-runners:repo": "example-org/app",
    "ec2-runners:job-id": "555",
  });
  expect(fleetCalls()).toHaveLength(1);
});

test("reconciler launches nothing when two jobs swap runners", async () => {
  // Job 600 started on the runner launched for job 555. Job 600's own runner
  // is idle and has the labels job 555 needs.
  queuedRow(555, ["ec2"]);
  const runner600 = runnerName(PREFIX, 600);
  ghRoutes["GET /orgs/example-org/actions/runners"] = {
    body: {
      total_count: 2,
      runners: [registration(1, runnerName(PREFIX, 555), ["ec2"], true), registration(2, runner600, ["ec2"])],
    },
  };
  ec2Handler = ec2With({ instances: [instance("i-600", "pending", 1, runner600)] });

  const result = await reconciler();
  expect(result).toMatchObject({ queued: 1, available: 1, outcomes: {} });
  expect(fleetCalls()).toHaveLength(0);
});

test("reconciler launches for a job whose only fitting runner was taken", async () => {
  // Job 600 ([ec2]) took the cpu=8 runner launched for job 555. Job 600's own
  // runner is idle but lacks cpu=8.
  queuedRow(555, ["ec2", "cpu=8"]);
  githubJob("example-org/app", 555);
  const runner600 = runnerName(PREFIX, 600);
  ghRoutes["GET /orgs/example-org/actions/runners"] = {
    body: {
      total_count: 2,
      runners: [registration(1, runnerName(PREFIX, 555), ["ec2", "cpu=8"], true), registration(2, runner600, ["ec2"])],
    },
  };
  ec2Handler = ec2With({ instances: [instance("i-600", "running", 1, runner600)] });

  expect((await reconciler()).outcomes).toEqual({ 555: "launched" });
});

test("reconciler marks done a job GitHub already started", async () => {
  queuedRow(555, ["ec2"]);
  githubJob("example-org/app", 555, "in_progress");
  expect((await reconciler()).outcomes).toEqual({ 555: "already started" });
  expect(table.get(555)?.status).toBe("done");
  expect(fleetCalls()).toHaveLength(0);
});

test("reconciler fails a job whose labels no instance type matches, and alerts once", async () => {
  queuedRow(556, ["ec2", "cpu=3"]);
  githubJob("example-org/app", 556);
  ec2Handler = ec2With({ instanceTypes: [] });

  expect((await reconciler()).outcomes).toEqual({ 556: "failed" });
  expect(table.get(556)).toMatchObject({ status: "failed", error: expect.stringContaining("cpu=3") });
  expect(alerts()).toHaveLength(1);
  // Nothing was registered for the job.
  expect(ghCalls.some((c) => c.key.endsWith("generate-jitconfig"))).toBe(false);

  // A failed job is no longer queued, so later reconciles leave it alone.
  expect((await reconciler()).outcomes).toEqual({});
  expect(alerts()).toHaveLength(1);
});

test("reconciler retries a launch that lacks capacity and alerts on the third failure", async () => {
  queuedRow(557, ["ec2"]);
  githubJob("example-org/app", 557);
  ghRoutes["DELETE /orgs/example-org/actions/runners/1001"] = { status: 204 };
  ec2Handler = ec2With({ fleet: "no-capacity" });

  for (let attempt = 1; attempt <= 3; attempt++) {
    expect((await reconciler()).outcomes).toEqual({ 557: "will retry" });
    expect(table.get(557)).toMatchObject({ status: "queued", launchFailures: attempt });
  }
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]!.Message).toContain("Failed 3 times");
  // Each failed launch removed its registration, so it never counts as available.
  expect(ghCalls.filter((c) => c.key === "DELETE /orgs/example-org/actions/runners/1001")).toHaveLength(3);
});

test("janitor terminates idle and expired instances and removes stale registrations", async () => {
  const name = (jobId: number, minutesAgo = 60) => runnerName(PREFIX, jobId, Date.now() - minutesAgo * 60_000);
  const [young, busy, idle, old, gone, launching, orphaned] = [name(1, 3), name(2), name(3), name(4, 400), name(5), name(6, 1), name(7, 30)];
  ec2Handler = (cmd) => {
    if (cmd === "DescribeInstancesCommand")
      return {
        Reservations: [
          {
            Instances: [
              // booting, too young to judge
              instance("i-young", "running", 3, young),
              // old and busy: keep
              instance("i-busy", "running", 60, busy),
              // old and never picked up a job: terminate
              instance("i-idle", "running", 30, idle),
              // past max lifetime even though busy: terminate
              instance("i-old", "running", 400, old),
              // already terminated; its registration is stale
              instance("i-gone", "terminated", 50, gone),
            ],
          },
        ],
      };
    if (cmd === "DescribeLaunchTemplateVersionsCommand")
      return {
        LaunchTemplateVersions: [
          { VersionNumber: 1, DefaultVersion: true, CreateTime: new Date(0) },
          { VersionNumber: 9, VersionDescription: name(9), CreateTime: new Date(Date.now() - 2 * 3600_000) },
        ],
      };
    return {};
  };
  ghRoutes["GET /orgs/example-org/actions/runners"] = {
    body: {
      total_count: 8,
      runners: [
        registration(1, young, ["ec2"]),
        registration(2, busy, ["ec2"], true),
        registration(3, idle, ["ec2"]),
        registration(4, old, ["ec2"], true),
        registration(5, gone, ["ec2"]),
        // registered a minute ago, instance not visible yet: leave alone
        registration(6, launching, ["ec2"]),
        // registered 30 minutes ago and never got an instance: stale
        registration(7, orphaned, ["ec2"]),
        registration(8, "other-runner", ["ec2"]),
      ],
    },
  };
  for (const id of [3, 5, 7]) ghRoutes[`DELETE /orgs/example-org/actions/runners/${id}`] = { status: 204 };

  const result = await janitor();
  expect(result.terminated.sort()).toEqual(["i-idle", "i-old"]);
  expect(result.removedRunners.sort()).toEqual([idle, gone, orphaned].sort());
  expect(result.deletedVersions).toEqual(["9"]);
  const terminate = awsCalls.find((c) => c.name === "TerminateInstancesCommand")!;
  expect(terminate.input.InstanceIds.sort()).toEqual(["i-idle", "i-old"]);
});
