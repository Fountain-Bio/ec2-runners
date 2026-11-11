// Each Lambda's environment, parsed with Zod the first time a handler runs,
// so a missing or malformed variable fails with the variable's name. Each
// function in template.yaml sets only the variables its handler reads.

import * as z from "zod";

// Every handler reads these.
const common = {
  SECRET_ARN: z.string().min(1),
  GITHUB_ORG: z.string().min(1),
  // The stack name. Prefixes runner names and tags the stack's instances.
  RUNNER_PREFIX: z.string().min(1),
};

// The handlers that call GitHub read this. Milliseconds in each second the
// GitHub client waits for a retry, a rate limit, or write pacing. Tests set 0.
const githubClient = {
  GITHUB_SECOND_MS: z.coerce.number().nonnegative().default(1000),
};

// The labels that opt a job in to an EC2 runner and to a MicroVM runner.
const kindLabels = {
  TRIGGER_LABEL: z.string().min(1),
  MICROVM_LABEL: z.string().min(1),
};

const WebhookConfig = z.object({
  ...common,
  ...kindLabels,
  RECONCILER_FUNCTION: z.string().min(1),
  JOBS_TABLE: z.string().min(1),
  ALERT_TOPIC_ARN: z.string().min(1),
  ALLOW_PUBLIC_REPOS: z.stringbool(),
});

const ReconcilerConfig = z.object({
  ...common,
  ...githubClient,
  // Set by the Lambda runtime.
  AWS_REGION: z.string().min(1),
  ...kindLabels,
  JOBS_TABLE: z.string().min(1),
  ALERT_TOPIC_ARN: z.string().min(1),
  ALLOW_PUBLIC_REPOS: z.stringbool(),
  RUNNER_GROUP_ID: z.coerce.number().int().positive(),
  LAUNCH_TEMPLATE_ID: z.string().min(1),
  LAUNCH_TEMPLATE_VERSION: z.string().min(1),
  SUBNET_IDS: z
    .string()
    .min(1)
    .transform((s) => s.split(",")),
  CACHE_BUCKET: z.string().min(1),
  MAX_MINUTES: z.coerce.number().positive(),
  AMI_OWNER: z.string().min(1),
  AMI_NAME_PREFIX: z.string().min(1),
  RUNNER_VERSION: z.string().min(1),
  BOOT_LOG_GROUP: z.string().min(1),
  // An instance family whose CPU performance is the slowest allowed, or empty
  // for no floor.
  CPU_BASELINE_FAMILY: z.string().default(""),
  // Seconds between a pass with a failed launch and the pass that retries it.
  RECONCILE_RETRY_SECONDS: z.coerce.number().nonnegative().default(30),
  // The stack's MicroVM image, and the role its MicroVMs run with.
  MICROVM_IMAGE_ARN: z.string().min(1),
  MICROVM_EXECUTION_ROLE_ARN: z.string().min(1),
});

const JanitorConfig = z.object({
  ...common,
  ...githubClient,
  JOBS_TABLE: z.string().min(1),
  IDLE_MINUTES: z.coerce.number().positive(),
  MAX_MINUTES: z.coerce.number().positive(),
  LAUNCH_TEMPLATE_ID: z.string().min(1),
  // Set by the Lambda runtime.
  AWS_REGION: z.string().min(1),
  ALERT_TOPIC_ARN: z.string().min(1),
  // The runner release the MicroVM image holds, "latest" or a version.
  RUNNER_VERSION: z.string().min(1),
  // The MicroVM image the janitor builds, its baseline memory, the role
  // Lambda builds it with, and the bucket that holds its source zip.
  MICROVM_IMAGE_NAME: z.string().min(1),
  MICROVM_IMAGE_ARN: z.string().min(1),
  MICROVM_MEMORY_MIB: z.coerce.number().int().positive(),
  MICROVM_BUILD_ROLE_ARN: z.string().min(1),
  MICROVM_SOURCE_BUCKET: z.string().min(1),
});

export type WebhookConfig = z.infer<typeof WebhookConfig>;
export type ReconcilerConfig = z.infer<typeof ReconcilerConfig>;
export type JanitorConfig = z.infer<typeof JanitorConfig>;

// Parses process.env with the schema once and returns the cached result after.
function lazy<T>(schema: z.ZodType<T>): () => T {
  let parsed: T | undefined;
  return () => (parsed ??= schema.parse(process.env));
}

export const webhookConfig = lazy(WebhookConfig);
export const reconcilerConfig = lazy(ReconcilerConfig);
export const janitorConfig = lazy(JanitorConfig);
