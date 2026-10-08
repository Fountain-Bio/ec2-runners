// Keeps reconciles from overlapping, so two of them never launch for the same
// job. The lock is one item in the jobs table (jobId 0, which no GitHub job
// uses). Its lockedBy and lockUntil attributes name the holder and when its
// hold lapses, and rerun records that another invocation asked for a
// reconcile while the lock was held.
//
// An invocation that finds the lock held sets rerun and exits. The holder
// runs another pass for each such request before it releases the lock, so no
// request is dropped. A holder that crashes stops blocking others once
// lockUntil passes, which the caller sets just past the Lambda timeout.

import { ConditionalCheckFailedException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";

const LOCK_KEY = { jobId: 0 };

export class ReconcileLock {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(client: DynamoDBClient, table: string) {
    this.doc = DynamoDBDocumentClient.from(client);
    this.table = table;
  }

  // Runs pass while holding the lock, then again for each request that
  // arrives meanwhile, as long as canRunAgain() allows. Returns the last pass's
  // result, or undefined when another invocation holds the lock and has taken
  // this caller's request.
  async runExclusive<T>({
    holder,
    holdUntil,
    pass,
    canRunAgain,
    now = Date.now,
  }: {
    holder: string;
    holdUntil: number;
    pass: () => Promise<T>;
    canRunAgain: () => boolean;
    now?: () => number;
  }): Promise<T | undefined> {
    // The lock can change hands between a failed acquire and the request, so
    // each is retried a few times.
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      if (await this.acquire(holder, holdUntil, now())) acquired = true;
      else if (await this.requestRerun(now())) return undefined;
    }
    if (!acquired) return undefined;

    for (;;) {
      let result: T;
      try {
        result = await pass();
      } catch (err) {
        // A failed pass releases the lock, so Lambda's retry can take it.
        await this.forceRelease(holder);
        throw err;
      }
      if (await this.release(holder)) return result;
      // Release fails when a request arrived during the pass, or when the
      // hold lapsed and another invocation took the lock.
      if (!(await this.takeRequest(holder))) return result;
      if (!canRunAgain()) {
        // The next scheduled reconcile covers the request.
        await this.forceRelease(holder);
        return result;
      }
    }
  }

  private acquire(holder: string, holdUntil: number, now: number): Promise<boolean> {
    return this.update({
      UpdateExpression: "SET lockedBy = :holder, lockUntil = :until, rerun = :false",
      ConditionExpression: "attribute_not_exists(lockedBy) OR lockUntil < :now",
      ExpressionAttributeValues: { ":holder": holder, ":until": holdUntil, ":false": false, ":now": now },
    });
  }

  private requestRerun(now: number): Promise<boolean> {
    return this.update({
      UpdateExpression: "SET rerun = :true",
      ConditionExpression: "attribute_exists(lockedBy) AND lockUntil >= :now",
      ExpressionAttributeValues: { ":true": true, ":now": now },
    });
  }

  // Releases only when no request is waiting, so a request made during the
  // pass is never released past.
  private release(holder: string): Promise<boolean> {
    return this.update({
      UpdateExpression: "REMOVE lockedBy, lockUntil",
      ConditionExpression: "lockedBy = :holder AND rerun = :false",
      ExpressionAttributeValues: { ":holder": holder, ":false": false },
    });
  }

  // Clears a waiting request while keeping the lock.
  private takeRequest(holder: string): Promise<boolean> {
    return this.update({
      UpdateExpression: "SET rerun = :false",
      ConditionExpression: "lockedBy = :holder AND rerun = :true",
      ExpressionAttributeValues: { ":holder": holder, ":true": true, ":false": false },
    });
  }

  private async forceRelease(holder: string): Promise<void> {
    await this.update({
      UpdateExpression: "REMOVE lockedBy, lockUntil",
      ConditionExpression: "lockedBy = :holder",
      ExpressionAttributeValues: { ":holder": holder },
    });
  }

  // Applies a conditional update to the lock item. Returns false when the
  // condition does not hold.
  private async update(input: Omit<UpdateCommandInput, "TableName" | "Key">): Promise<boolean> {
    try {
      await this.doc.send(new UpdateCommand({ TableName: this.table, Key: LOCK_KEY, ...input }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
