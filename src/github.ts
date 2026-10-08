// GitHub access for the control plane, through Octokit.
//
// The GitHub App is installed on one org. Octokit's app auth signs the app JWT,
// exchanges it for an installation token, and refreshes that token before it
// expires, so one client is reused across warm Lambda invocations.

import { createAppAuth } from "@octokit/auth-app";
import type { components } from "@octokit/openapi-webhooks-types";
import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";

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

// An actions/runner release tarball and its SHA-256 checksum.
export interface RunnerDownload {
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

export class GitHubClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly org: string;
  private installation: Promise<Octokit> | undefined;

  constructor({ appId, privateKey, org }: { appId: string; privateKey: string; org: string }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.org = org;
  }

  // Looks up the app's installation on the org once, then returns a client
  // that authenticates as that installation.
  private octokit(): Promise<Octokit> {
    this.installation ??= (async () => {
      const auth = { appId: this.appId, privateKey: this.privateKey };
      const app = new Octokit({ authStrategy: createAppAuth, auth, log: quietLog });
      const { data } = await app.rest.apps.getOrgInstallation({ org: this.org });
      return new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId: data.id }, log: quietLog });
    })();
    // A failed lookup is retried on the next call.
    this.installation.catch(() => (this.installation = undefined));
    return this.installation;
  }

  async generateJitConfig({ name, labels, runnerGroupId }: { name: string; labels: string[]; runnerGroupId: number }) {
    const gh = await this.octokit();
    const { data } = await gh.rest.actions.generateRunnerJitconfigForOrg({
      org: this.org,
      name,
      labels,
      runner_group_id: runnerGroupId,
    });
    return data;
  }

  // repo is "owner/name".
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

  async listRunners(namePrefix: string) {
    const gh = await this.octokit();
    const runners = await gh.paginate(gh.rest.actions.listSelfHostedRunnersForOrg, { org: this.org, per_page: 100 });
    return runners.filter((r) => r.name.startsWith(namePrefix));
  }

  async deleteRunner(runnerId: number): Promise<void> {
    const gh = await this.octokit();
    await gh.rest.actions.deleteSelfHostedRunnerFromOrg({ org: this.org, runner_id: runnerId });
  }

  // Looks up the actions/runner release tarball for a version ("latest" or
  // "2.338.0") and its checksum, which GitHub publishes as the asset digest.
  async runnerDownload(version: string, arch: RunnerArch): Promise<RunnerDownload> {
    const gh = await this.octokit();
    const repo = { owner: "actions", repo: "runner" };
    const { data: release } =
      version === "latest"
        ? await gh.rest.repos.getLatestRelease(repo)
        : await gh.rest.repos.getReleaseByTag({ ...repo, tag: `v${version}` });
    const resolved = release.tag_name.replace(/^v/, "");
    const filename = `actions-runner-linux-${arch}-${resolved}.tar.gz`;
    const asset = release.assets.find((a) => a.name === filename);
    const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (!asset || !sha256) throw new Error(`actions/runner ${release.tag_name} has no ${filename} with a sha256 digest`);
    return { version: resolved, url: asset.browser_download_url, sha256 };
  }
}
