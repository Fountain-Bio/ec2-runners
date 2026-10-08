// The DynamoDB table of jobs that asked for an EC2 runner.
//
// The webhook adds a row when GitHub queues a job and marks it done when the
// job starts or finishes. The reconciler reads the queued rows. Rows expire
// after a day, which is how long GitHub keeps a job queued before failing it.

import { ConditionalCheckFailedException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, paginateScan } from "@aws-sdk/lib-dynamodb";
import * as z from "zod";
import type { QueuedJob } from "./pool.ts";

const TTL_SECONDS = 24 * 60 * 60;

// A row the reconciler acts on.
const QueuedRow = z.object({
  jobId: z.int(),
  repo: z.string(),
  runId: z.int(),
  labels: z.array(z.string()),
});

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

  // Adds a queued job. Does nothing when a row already exists, which covers a
  // redelivered webhook and a "queued" event that arrives after the job's
  // "in_progress" event.
  async markQueued(job: QueuedJob, now = Date.now()): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...job, status: "queued", launchFailures: 0, expiresAt: this.expiresAt(now) },
          ConditionExpression: "attribute_not_exists(jobId)",
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
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
      for (const item of page.Items ?? []) jobs.push(QueuedRow.parse(item));
    }
    return jobs;
  }
}
