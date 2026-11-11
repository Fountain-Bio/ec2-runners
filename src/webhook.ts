// The GitHub App's webhook, served by a Lambda function URL. Verifies each
// delivery, records workflow_job state in the jobs table, and invokes the
// reconciler asynchronously, so GitHub gets a response well inside its 10
// second delivery timeout.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from "aws-lambda";
import { alert } from "./alerts.ts";
import { loadSecret } from "./app-secret.ts";
import { webhookConfig } from "./config.ts";
import { verifySignature, type WorkflowJobEvent } from "./github.ts";
import { jobStore } from "./jobs.ts";
import { JobConfigError, isStackJob, jobKind } from "./labels.ts";
import { log } from "./log.ts";
import { parseRunnerName } from "./pool.ts";

const lambda = new LambdaClient({});

// The reconciler always looks at the whole queue, so its invocation carries no payload.
async function invokeReconciler(functionName: string, reason: string): Promise<void> {
  await lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event" }));
  log("invoked reconciler", { reason });
}

// Function URLs use the API Gateway HTTP API (v2) event and response format.
export async function webhook(event: LambdaFunctionURLEvent): Promise<APIGatewayProxyStructuredResultV2> {
  const config = webhookConfig();
  const jobs = jobStore(config.JOBS_TABLE);
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");

  const { webhookSecret } = await loadSecret(config.SECRET_ARN);
  if (!(await verifySignature(webhookSecret, rawBody, headers["x-hub-signature-256"]))) {
    log("rejected delivery with invalid signature", { delivery: headers["x-github-delivery"] });
    return { statusCode: 401, body: "invalid signature" };
  }

  const eventName = headers["x-github-event"];
  if (eventName !== "workflow_job") return { statusCode: 200, body: `ignored ${eventName}` };

  // The signature proves GitHub sent this body, so it has the documented shape.
  const payload = JSON.parse(rawBody) as WorkflowJobEvent;
  const job = payload.workflow_job;
  if (payload.organization?.login.toLowerCase() !== config.GITHUB_ORG.toLowerCase()) {
    return { statusCode: 200, body: "ignored: other org" };
  }
  const kindLabels = { ec2Label: config.TRIGGER_LABEL, microvmLabel: config.MICROVM_LABEL };
  if (!isStackJob(job.labels, kindLabels)) return { statusCode: 200, body: "ignored: no trigger label" };

  switch (payload.action) {
    case "queued": {
      // Public repositories accept pull requests from forks, whose code would
      // get write access to the cache bucket that every repository's jobs read.
      if (!payload.repository.private && !config.ALLOW_PUBLIC_REPOS) {
        log("ignored job from public repository", { repo: payload.repository.full_name, jobId: job.id });
        return { statusCode: 200, body: "ignored: public repository" };
      }
      try {
        jobKind(job.labels, kindLabels);
      } catch (err) {
        if (!(err instanceof JobConfigError)) throw err;
        log("invalid job labels", { jobId: job.id, labels: job.labels, error: err.message });
        await alert(config.ALERT_TOPIC_ARN, `Invalid runner labels in ${payload.repository.full_name}`, `${job.html_url}\n\n${err.message}`);
        return { statusCode: 200, body: `invalid labels: ${err.message}` };
      }
      await jobs.markQueued({ jobId: job.id, repo: payload.repository.full_name, runId: job.run_id, labels: job.labels });
      await invokeReconciler(config.RECONCILER_FUNCTION, `job ${job.id} queued`);
      return { statusCode: 202, body: "queued" };
    }
    case "in_progress": {
      await jobs.markDone(job.id);
      // A job that starts on a runner launched for a different job can leave
      // that other job without a runner it fits.
      const launchedFor = parseRunnerName(config.RUNNER_PREFIX, job.runner_name ?? "")?.jobId;
      if (launchedFor !== undefined && launchedFor !== job.id) {
        await invokeReconciler(config.RECONCILER_FUNCTION, `job ${job.id} started on a runner launched for job ${launchedFor}`);
        return { statusCode: 202, body: "reconciling" };
      }
      return { statusCode: 200, body: "recorded start" };
    }
    case "completed":
      await jobs.markDone(job.id);
      // A job cancelled before it started leaves the runner launched for it
      // idle. The reconciler removes it unless another queued job needs it.
      if (job.runner_name === null) {
        await invokeReconciler(config.RECONCILER_FUNCTION, `job ${job.id} ended before it started`);
        return { statusCode: 202, body: "reconciling" };
      }
      return { statusCode: 200, body: "recorded completion" };
    default:
      return { statusCode: 200, body: `ignored ${payload.action}` };
  }
}
