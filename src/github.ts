// GitHub access for the control plane, through Octokit.
//
// The GitHub App is installed on one org. Octokit's app auth signs the app JWT,
// exchanges it for an installation token, and refreshes that token before it
// expires, so one client is reused across warm Lambda invocations.
//
// GitHub sometimes fails a request with a 5xx, drops a connection, or answers
// with a rate limit, and one such answer would otherwise fail a whole
// reconcile or backfill. The retry plugin retries server errors and failed
// connections, and the throttling plugin paces requests the way GitHub
// recommends and waits out short rate limits.

import { createAppAuth } from "@octokit/auth-app";
import type { components } from "@octokit/openapi-webhooks-types";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";
import Bottleneck from "bottleneck";
import { log } from "./log.ts";

// workflow_job webhook payloads, typed from GitHub's OpenAPI description.
export type WorkflowJobEvent =
  | components["schemas"]["webhook-workflow-job-queued"]
  | components["schemas"]["webhook-workflow-job-in-progress"]
  | components["schemas"]["webhook-workflow-job-completed"]
  | components["schemas"]["webhook-workflow-job-waiting"];

// Checks the X-Hub-Signature-256 header against the raw request body.
export async function verifySignature(secret: string, rawBody: string, signatureHeader: string | undefined): Promise<boolean> {
  // verify() throws on an empty body or signature; neither comes from GitHub.
  if (!rawBody || !signatureHeader) return false;
  return verify(secret, rawBody, signatureHeader);
}

export function isGitHubError(err: unknown, status: number): boolean {
  return err instanceof RequestError && err.status === status;
}

// A release tarball (actions/runner, or the gh CLI) and its SHA-256 checksum.
export interface ReleaseDownload {
  version: string;
  url: string;
  sha256: string;
}

// actions/runner names its Linux tarballs by these architectures.
export type RunnerArch = "x64" | "arm64";

// Octokit logs every failed request at error level, including expected ones
// such as the 409 for an existing runner. Callers log or rethrow each error
// themselves, so only warnings (such as deprecation notices) are kept.
const quietLog = { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} };

// Retries after a server error or failed connection, which Octokit reports as
// a 500. The waits are 1 and 4 seconds. No 4xx is retried: a rate limit is
// the throttling plugin's to retry, and the rest fail the same way again.
const SERVER_ERROR_RETRIES = 2;
const NOT_RETRIED = Array.from({ length: 100 }, (_, i) => 400 + i);
// The longest rate limit wait a request sits out, once. A longer one fails
// the request, and the next scheduled run, at most 5 minutes later, tries
// again. GitHub asks for a minute when it gives no retry-after header.
const MAX_RATE_LIMIT_WAIT_SECONDS = 30;

// Logs each failed attempt the retry plugin will retry. Registered before
// the retry plugin, so its hook runs inside the retries and sees every attempt.
function logRetries(octokit: Pick<Octokit, "hook">) {
  octokit.hook.error("request", (error, options) => {
    if (error instanceof RequestError && error.status >= 500) {
      const retryCount = (options.request as { retryCount?: number } | undefined)?.retryCount ?? 0;
      log("GitHub request failed", {
        request: `${options.method} ${options.url}`,
        status: error.status,
        error: error.message,
        retrying: retryCount < SERVER_ERROR_RETRIES,
      });
    }
    throw error;
  });
}

const GitHubOctokit = Octokit.plugin(logRetries, retry, throttling);
type GitHubOctokit = InstanceType<typeof GitHubOctokit>;

// Waits out a rate limit once when GitHub asks for a short wait.
function retryRateLimit(limit: string, retryAfter: number, options: { method: string; url: string }, retryCount: number): boolean {
  const retrying = retryCount === 0 && retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS;
  log("GitHub rate limit", { limit, request: `${options.method} ${options.url}`, retryAfterSeconds: retryAfter, retrying });
  return retrying;
}

export class GitHubClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly org: string;
  private readonly options: ConstructorParameters<typeof GitHubOctokit>[0];
  private installation: Promise<GitHubOctokit> | undefined;

  // secondMs is the length of a second in the client's waits: retry backoff,
  // rate limit waits, and the pacing of write requests. Tests set it to 0.
  constructor({ appId, privateKey, org, secondMs = 1000 }: { appId: string; privateKey: string; org: string; secondMs?: number }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.org = org;
    this.options = {
      log: quietLog,
      retry: { retries: SERVER_ERROR_RETRIES, doNotRetry: NOT_RETRIED, retryAfterBaseValue: secondMs },
      throttle: {
        retryAfterBaseValue: secondMs,
        // GitHub asks for a second between write requests. The plugin's own
        // write group always waits a real second; this one waits secondMs.
        write: new Bottleneck.Group({ maxConcurrent: 1, minTime: secondMs }),
        onRateLimit: (retryAfter, options, _octokit, retryCount) => retryRateLimit("primary", retryAfter, options, retryCount),
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => retryRateLimit("secondary", retryAfter, options, retryCount),
      },
    };
  }

  // Looks up the app's installation on the org once, then returns a client
  // that authenticates as that installation.
  private octokit(): Promise<GitHubOctokit> {
    this.installation ??= (async () => {
      const auth = { appId: this.appId, privateKey: this.privateKey };
      const app = new GitHubOctokit({ ...this.options, authStrategy: createAppAuth, auth });
      const { data } = await app.rest.apps.getOrgInstallation({ org: this.org });
      return new GitHubOctokit({ ...this.options, authStrategy: createAppAuth, auth: { ...auth, installationId: data.id } });
    })();
    // A failed lookup is retried on the next call.
    this.installation.catch(() => (this.installation = undefined));
    return this.installation;
  }

  // workFolder may be absolute; the runner resolves it against its install directory.
  async generateJitConfig({
    name,
    labels,
    runnerGroupId,
    workFolder,
  }: {
    name: string;
    labels: string[];
    runnerGroupId: number;
    workFolder: string;
  }) {
    const gh = await this.octokit();
    const { data } = await gh.rest.actions.generateRunnerJitconfigForOrg({
      org: this.org,
      name,
      labels,
      runner_group_id: runnerGroupId,
      work_folder: workFolder,
    });
    return data;
  }

  // repo is "owner/name", which the jobs table schema enforces.
  async getJob(repo: string, jobId: number) {
    const gh = await this.octokit();
    const [owner = "", name = ""] = repo.split("/");
    const { data } = await gh.rest.actions.getJobForWorkflowRun({ owner, repo: name, job_id: jobId });
    return data;
  }

  // Whether the org runner group lets public repositories' jobs use its
  // runners. Undefined when the org has no runner group API, such as on
  // GitHub Free, where every org runner is in the Default group.
  async runnerGroupAllowsPublicRepos(runnerGroupId: number): Promise<boolean | undefined> {
    const gh = await this.octokit();
    try {
      // Octokit has no generated method for this endpoint, so it goes through the typed request route.
      const { data } = await gh.request("GET /orgs/{org}/actions/runner-groups/{runner_group_id}", {
        org: this.org,
        runner_group_id: runnerGroupId,
      });
      return data.allows_public_repositories;
    } catch (err) {
      if (isGitHubError(err, 404) || isGitHubError(err, 403)) return undefined;
      throw err;
    }
  }

  // The repositories the app's installation can access.
  async listRepositories() {
    const gh = await this.octokit();
    return gh.paginate(gh.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
  }

  // Jobs waiting for a runner in one repository's workflow runs created at or
  // after `since`. A run whose jobs all wait is "queued", and a run with some
  // jobs already running is "in_progress" while others can still wait.
  async listQueuedJobs(repo: string, since: Date) {
    const gh = await this.octokit();
    const [owner = "", name = ""] = repo.split("/");
    const created = `>=${since.toISOString()}`;
    const runsByStatus = await Promise.all(
      (["queued", "in_progress"] as const).map((status) =>
        gh.paginate(gh.rest.actions.listWorkflowRunsForRepo, { owner, repo: name, status, created, exclude_pull_requests: true, per_page: 100 }),
      ),
    );
    // A run can change status between the two lists and appear in both.
    const runIds = new Set(runsByStatus.flat().map((run) => run.id));
    const jobs = await Promise.all(
      [...runIds].map((run_id) =>
        gh.paginate(gh.rest.actions.listJobsForWorkflowRun, { owner, repo: name, run_id, filter: "latest", per_page: 100 }),
      ),
    );
    return jobs.flat().filter((job) => job.status === "queued");
  }

  async listRunners(namePrefix: string) {
    const gh = await this.octokit();
    const runners = await gh.paginate(gh.rest.actions.listSelfHostedRunnersForOrg, { org: this.org, per_page: 100 });
    return runners.filter((r) => r.name.startsWith(namePrefix));
  }

  // Adds custom labels to a registration, such as the microvm-id label that
  // links a MicroVM runner to its MicroVM.
  async addRunnerLabels(runnerId: number, labels: string[]): Promise<void> {
    const gh = await this.octokit();
    await gh.rest.actions.addCustomLabelsToSelfHostedRunnerForOrg({ org: this.org, runner_id: runnerId, labels });
  }

  async deleteRunner(runnerId: number): Promise<void> {
    const gh = await this.octokit();
    await gh.rest.actions.deleteSelfHostedRunnerFromOrg({ org: this.org, runner_id: runnerId });
  }

  // Looks up the actions/runner release tarball for a version ("latest" or
  // "2.338.0") and its checksum, which GitHub publishes as the asset digest.
  async runnerDownload(version: string, arch: RunnerArch): Promise<ReleaseDownload> {
    const gh = await this.octokit();
    const repo = { owner: "actions", repo: "runner" };
    const { data: release } =
      version === "latest" ? await gh.rest.repos.getLatestRelease(repo) : await gh.rest.repos.getReleaseByTag({ ...repo, tag: `v${version}` });
    const resolved = release.tag_name.replace(/^v/, "");
    const filename = `actions-runner-linux-${arch}-${resolved}.tar.gz`;
    const asset = release.assets.find((a) => a.name === filename);
    const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (!asset || !sha256) {
      throw new Error(
        `actions/runner ${release.tag_name} has no ${filename} with a sha256 digest. ` +
          `GitHub publishes digests for releases from 2.325.0 on; set RunnerVersion to one of those or to "latest".`,
      );
    }
    return { version: resolved, url: asset.browser_download_url, sha256 };
  }

  // Looks up the latest gh CLI release tarball for Linux on ARM64 and its
  // checksum, for the MicroVM image. The image installs gh from this tarball
  // because Amazon Linux 2023 rejects the signatures on GitHub's gh packages.
  async ghCliDownload(): Promise<ReleaseDownload> {
    const gh = await this.octokit();
    const { data: release } = await gh.rest.repos.getLatestRelease({ owner: "cli", repo: "cli" });
    const version = release.tag_name.replace(/^v/, "");
    const filename = `gh_${version}_linux_arm64.tar.gz`;
    const asset = release.assets.find((a) => a.name === filename);
    const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (!asset || !sha256) throw new Error(`cli/cli ${release.tag_name} has no ${filename} with a sha256 digest`);
    return { version, url: asset.browser_download_url, sha256 };
  }
}
