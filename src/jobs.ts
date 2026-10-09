// The DynamoDB table of jobs that asked for an EC2 runner.
//
// The webhook adds a row when GitHub queues a job and marks it done when the
// job starts or finishes. The reconciler reads the queued rows. Rows expire
// after a day, which is how long GitHub keeps a job queued before failing it.

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import * as z from "zod";
import { log } from "./log.ts";

const TTL_SECONDS = 24 * 60 * 60;

// A job that GitHub reported as queued and that has not started yet, as the
// reconciler reads it from the table.
const QueuedRow = z.object({
  jobId: z.int(),
  // "owner/name".
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  runId: z.int(),
  labels: z.array(z.string()),
  // Runners launched for this job that the janitor terminated after they sat
  // idle, with the job still queued.
  idleRunners: z.int().default(0),
});
export type QueuedJob = z.infer<typeof QueuedRow>;

export class JobStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, table: string) {
    this.doc = DynamoDBDocumentClient.from(client);
    this.table = table;
  }

  private expiresAt(now: number): number {
    return Math.floor(now / 1000) + TTL_SECONDS;
  }

  // Adds a queued job and returns whether it did. Does nothing when a row
  // already exists, which covers a redelivered webhook, a "queued" event that
  // arrives after the job's "in_progress" event, and the reconciler's
  // backfill finding a job the webhook already recorded.
  async markQueued(job: Omit<QueuedJob, "idleRunners">, now = Date.now()): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...job, status: "queued", launchFailures: 0, idleRunners: 0, expiresAt: this.expiresAt(now) },
          ConditionExpression: "attribute_not_exists(jobId)",
        }),
      );
      return true;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      return false;
    }
  }

  // Records that the job started or finished. Creates the row when the
  // "queued" event has not arrived yet, so that event is ignored when it does.
  async markDone(jobId: number, now = Date.now()): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { jobId },
        UpdateExpression: "SET #status = :done, expiresAt = :expiresAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":done": "done", ":expiresAt": this.expiresAt(now) },
      }),
    );
  }

  // Stops the reconciler from launching for a job whose labels can never be
  // satisfied. Returns false when the job was no longer queued, so a caller
  // alerts only once per job.
  async markFailed(jobId: number, error: string): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { jobId },
          UpdateExpression: "SET #status = :failed, #error = :error",
          ConditionExpression: "#status = :queued",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" },
          ExpressionAttributeValues: { ":failed": "failed", ":error": error, ":queued": "queued" },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  // Counts a failed launch attempt, such as no Spot or On-Demand capacity, and
  // returns the job's total. The job stays queued and is retried.
  async recordLaunchFailure(jobId: number): Promise<number> {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { jobId },
        UpdateExpression: "ADD launchFailures :one",
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(res.Attributes?.launchFailures ?? 0);
  }

  // Counts a runner launched for this job that sat idle until the janitor
  // terminated it. Does nothing for a job with no row.
  async recordIdleRunner(jobId: number): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { jobId },
          UpdateExpression: "ADD idleRunners :one",
          ConditionExpression: "attribute_exists(jobId)",
          ExpressionAttributeValues: { ":one": 1 },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  // Reads with strong consistency, so a job the webhook queued just before
  // invoking the reconciler is included.
  async listQueued(): Promise<QueuedJob[]> {
    const jobs: QueuedJob[] = [];
    const pages = paginateScan(
      { client: this.doc },
      {
        TableName: this.table,
        ConsistentRead: true,
        FilterExpression: "#status = :queued",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":queued": "queued" },
      },
    );
    for await (const page of pages) {
      for (const item of page.Items ?? []) {
        // One unreadable row is skipped so it cannot stop every other job's launch.
        const row = QueuedRow.safeParse(item);
        if (row.success) jobs.push(row.data);
        else log("skipped unreadable jobs table row", { jobId: item.jobId, error: z.prettifyError(row.error) });
      }
    }
    return jobs;
  }
}

let cachedStore: JobStore | undefined;
// The store for the deployed table, reused across invocations.
export function jobStore(table: string): JobStore {
  return (cachedStore ??= new JobStore(new DynamoDBClient({}), table));
}
