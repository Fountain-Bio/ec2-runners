// Runs JobStore against DynamoDB Local in Docker, so the conditional writes,
// the strongly consistent scan, and the ADD counter are checked against the
// real DynamoDB engine. Needs Docker. Run with `bun run test:integration`.
//
// The file name lacks ".test", so plain `bun test` skips it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { JobStore } from "../../src/jobs.ts";

const IMAGE = "amazon/dynamodb-local:3.3.1";
const TABLE = "ec2-runners-jobs";

let containerId = "";
let client: DynamoDBClient;
let store: JobStore;

beforeAll(
  async () => {
    // Publishes the container's port 8000 on a free localhost port.
    containerId = execFileSync(
      "docker",
      ["run", "--detach", "--rm", "--publish", "127.0.0.1::8000", IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory"],
      { encoding: "utf8" },
    ).trim();
    const hostPort = execFileSync("docker", ["port", containerId, "8000/tcp"], { encoding: "utf8" }).trim().split("\n")[0];

    // DynamoDB Local accepts any credentials.
    client = new DynamoDBClient({
      endpoint: `http://${hostPort}`,
      region: "us-west-2",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    await waitUntilReady(client);

    // The same key schema as JobsTable in template.yaml.
    await client.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "jobId", AttributeType: "N" }],
        KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }],
      }),
    );
    store = new JobStore(client, TABLE);
  },
  { timeout: 120_000 },
);

afterAll(() => {
  if (containerId) execFileSync("docker", ["rm", "--force", containerId]);
});

async function waitUntilReady(dynamodb: DynamoDBClient): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await dynamodb.send(new ListTablesCommand({}));
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const job = (jobId: number, labels = ["ec2"]) => ({ jobId, repo: "example-org/app", runId: 777, labels });

async function row(jobId: number) {
  const { Item } = await DynamoDBDocumentClient.from(client).send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
  return Item;
}

const queuedIds = async () => (await store.listQueued()).map((j) => j.jobId).sort((a, b) => a - b);

test("a queued job is listed and expires a day after it was queued", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  await store.markQueued(job(1, ["ec2", "cpu=4"]), now);
  expect(await store.listQueued()).toContainEqual(job(1, ["ec2", "cpu=4"]));
  expect(await row(1)).toMatchObject({ status: "queued", launchFailures: 0, expiresAt: now / 1000 + 24 * 60 * 60 });
});

test("a redelivered queued event leaves the existing row alone", async () => {
  await store.markQueued(job(2));
  expect(await store.recordLaunchFailure(2)).toBe(1);
  await store.markQueued(job(2, ["ec2", "cpu=8"]));
  expect(await row(2)).toMatchObject({ labels: ["ec2"], launchFailures: 1, status: "queued" });
});

test("a started job leaves the queue, and a late queued event does not bring it back", async () => {
  await store.markQueued(job(3));
  await store.markDone(3);
  expect(await queuedIds()).not.toContain(3);

  // The in_progress event for job 4 arrives before its queued event.
  await store.markDone(4);
  await store.markQueued(job(4));
  expect(await row(4)).toMatchObject({ status: "done" });
  expect(await queuedIds()).not.toContain(4);
});

test("markFailed succeeds once, only for a queued job", async () => {
  await store.markQueued(job(5));
  expect(await store.markFailed(5, "No x86_64 instance type has cpu=3")).toBe(true);
  expect(await store.markFailed(5, "again")).toBe(false);
  expect(await row(5)).toMatchObject({ status: "failed", error: "No x86_64 instance type has cpu=3" });
  expect(await queuedIds()).not.toContain(5);

  await store.markDone(6);
  expect(await store.markFailed(6, "too late")).toBe(false);
});

test("recordLaunchFailure counts attempts and keeps the job queued", async () => {
  await store.markQueued(job(7));
  expect([await store.recordLaunchFailure(7), await store.recordLaunchFailure(7), await store.recordLaunchFailure(7)]).toEqual([1, 2, 3]);
  expect(await queuedIds()).toContain(7);
});

test("listQueued reads every page of the table", async () => {
  // Scan pages hold up to 1 MB. 600 rows padded to about 2 KB each take two or more pages.
  const padding = "x".repeat(2000);
  for (let start = 1000; start < 1600; start += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.markQueued({ ...job(start + i), repo: `example-org/${padding}` })));
  }
  const ids = await queuedIds();
  expect(ids.filter((id) => id >= 1000)).toHaveLength(600);
});
