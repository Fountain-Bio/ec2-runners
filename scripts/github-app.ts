// Pure pieces of scripts/create-github-app.ts, kept apart so tests can import
// them without starting the CLI: the GitHub App manifest, the page that posts
// it to GitHub, and the secret built from GitHub's reply.
//
// GitHub's App manifest flow
// (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
// registers an app from a JSON manifest that a browser POSTs to GitHub. After
// the person clicks "Create GitHub App", GitHub redirects to redirect_url with
// a one-hour code, and POST /app-manifests/{code}/conversions exchanges the
// code for the app's ID, private key, and webhook secret.

// The permissions and events the stack needs, the same as docs/setup.md step 2.
// Actions: read lets the reconciler confirm a job is still queued and list
// queued jobs; self-hosted runners: write lets it register and delete runners.
const PERMISSIONS = {
  actions: "read",
  metadata: "read",
  organization_self_hosted_runners: "write",
} as const;

// GitHub limits app names to 34 characters.
const MAX_APP_NAME = 34;

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: typeof PERMISSIONS;
  default_events: string[];
}

export function appManifest({
  org,
  stack,
  webhookUrl,
  redirectUrl,
}: {
  org: string;
  stack: string;
  webhookUrl: string;
  redirectUrl: string;
}): AppManifest {
  return {
    // GitHub app names are unique across GitHub. The person can edit the name
    // on GitHub's page before creating the app.
    name: `${stack}-${org}`.slice(0, MAX_APP_NAME),
    url: `https://github.com/${org}`,
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: ["workflow_job"],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A page that POSTs the manifest to the organization's "new GitHub App" form
// as soon as it loads. GitHub accepts the manifest only as a form POST from
// the browser, so the CLI serves this page locally.
export function manifestPage(org: string, state: string, manifest: AppManifest): string {
  const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<title>Create the ec2-runners GitHub App</title>
<form id="manifest" action="${escapeHtml(action)}" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Sending the app manifest to GitHub. <button type="submit">Continue</button></p>
</form>
<script>document.getElementById("manifest").submit();</script>
`;
}

// The part of GitHub's reply to POST /app-manifests/{code}/conversions that
// the stack uses.
export interface ManifestConversion {
  id: number;
  slug: string;
  html_url: string;
  pem: string;
  webhook_secret: string;
}

// The JSON for the stack's GitHub App secret, in the shape src/app-secret.ts
// parses.
export function appSecretString(app: ManifestConversion): string {
  return JSON.stringify({ appId: String(app.id), privateKey: app.pem, webhookSecret: app.webhook_secret });
}

// True when the secret still holds the template's REPLACE_ME placeholder or
// nothing, so writing to it cannot replace a working app's credentials.
export function isPlaceholderSecret(secretString: string | undefined): boolean {
  if (!secretString) return true;
  try {
    const { appId } = JSON.parse(secretString) as { appId?: unknown };
    return appId === undefined || appId === "" || (typeof appId === "string" && appId.startsWith("REPLACE"));
  } catch {
    return false;
  }
}
