// Registers the GitHub App for a deployed stack and stores its credentials in
// the stack's secret, in place of docs/setup.md steps 2 and 3.
//
//   node scripts/create-github-app.ts --org my-org [--stack ec2-runners] [--region us-west-2] [--force] [--no-open]
//
// The script reads the stack's WebhookUrl and GitHubAppSecretArn outputs,
// serves a page on 127.0.0.1 that sends an app manifest to GitHub, and opens
// it in a browser (--no-open only prints the address, for a machine without
// one). The person signed in to GitHub as an organization owner
// clicks "Create GitHub App". GitHub then redirects back to the script, which
// exchanges the code for the app's ID, private key, and webhook secret, writes
// them to the secret, and sends the browser on to install the app. The private
// key goes from GitHub to Secrets Manager without touching disk.
//
// It refuses to overwrite a secret that already holds an app's credentials
// unless --force is given. Uses the AWS CLI and the same AWS_PROFILE and
// AWS_REGION rules as deploy.sh.

import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { appManifest, appSecretString, assertOwnedBy, escapeHtml, isPlaceholderSecret, manifestPage, type ManifestConversion } from "./github-app.ts";

// GitHub's codes expire after an hour, so waiting longer cannot succeed.
const TIMEOUT_MS = 60 * 60 * 1000;

const { values } = parseArgs({
  options: {
    org: { type: "string" },
    stack: { type: "string", default: process.env.STACK ?? "ec2-runners" },
    region: { type: "string", default: process.env.AWS_REGION ?? "us-west-2" },
    force: { type: "boolean", default: false },
    open: { type: "boolean", default: true },
  },
  allowNegative: true,
});
const { org, stack, region, force, open } = values;
if (!org) {
  console.error("Usage: node scripts/create-github-app.ts --org <GitHub organization> [--stack <name>] [--region <region>] [--force] [--no-open]");
  process.exit(2);
}

function stackOutputs(): Record<string, string> {
  let json: string;
  try {
    // The AWS CLI's own error, such as expired credentials or a missing
    // stack, goes straight to the terminal.
    json = execFileSync(
      "aws",
      ["cloudformation", "describe-stacks", "--region", region, "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch {
    console.error(`Could not read the outputs of stack ${stack} in ${region}.`);
    process.exit(1);
  }
  const outputs = (JSON.parse(json) ?? []) as { OutputKey: string; OutputValue: string }[];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue]));
}

async function exchangeCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub rejected the manifest code: ${res.status} ${await res.text()}`);
  return (await res.json()) as ManifestConversion;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  // A missing opener is fine: the URL is printed for the person to open.
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

const outputs = stackOutputs();
const webhookUrl = outputs.WebhookUrl;
const secretArn = outputs.GitHubAppSecretArn;
if (!webhookUrl || !secretArn) {
  console.error(`Stack ${stack} in ${region} has no WebhookUrl or GitHubAppSecretArn output. Deploy it with deploy.sh first.`);
  process.exit(1);
}

const secrets = new SecretsManagerClient({ region });
const current = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
if (!isPlaceholderSecret(current.SecretString) && !force) {
  console.error(`${secretArn} already holds a GitHub App's credentials. Pass --force to replace them with a new app's.`);
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
let finished = false;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const html = (status: number, body: string) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
  const { port } = server.address() as AddressInfo;

  // A web page that rebinds its own hostname to 127.0.0.1 can reach this
  // server, but its requests carry that hostname, so only requests addressed
  // to 127.0.0.1 itself are served.
  if (req.headers.host !== `127.0.0.1:${port}`) {
    html(421, "Misdirected request");
    return;
  }

  if (url.pathname === "/") {
    const manifest = appManifest({ org, stack, webhookUrl, redirectUrl: `http://127.0.0.1:${port}/callback` });
    html(200, manifestPage(org, state, manifest));
    return;
  }
  if (url.pathname !== "/callback") {
    html(404, "Not found");
    return;
  }
  const code = url.searchParams.get("code");
  if (finished || !code || url.searchParams.get("state") !== state) {
    html(400, "This link is not from the current run of create-github-app.ts.");
    return;
  }
  finished = true;

  void (async () => {
    try {
      const app = await exchangeCode(code);
      assertOwnedBy(app, org);
      await secrets.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: appSecretString(app) }));
      const installUrl = `${app.html_url}/installations/new`;
      const [slugHtml, urlHtml, orgHtml] = [app.slug, installUrl, org].map(escapeHtml);
      console.log(`Created GitHub App ${app.slug} (ID ${app.id}) and stored its credentials in ${secretArn}.`);
      console.log(`Install it on ${org} for the repositories that should use the runners: ${installUrl}`);
      html(
        200,
        `<!doctype html><title>GitHub App created</title><meta http-equiv="refresh" content="0;url=${urlHtml}">` +
          `<p>Stored the credentials for ${slugHtml}. Next, <a href="${urlHtml}">install the app</a> on ${orgHtml}.</p>`,
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      html(500, "Creating the app failed. The terminal running create-github-app.ts has the error.");
    } finally {
      server.close();
      clearTimeout(timeout);
    }
  })();
});

const timeout = setTimeout(() => {
  console.error("No reply from GitHub within an hour. Run the script again.");
  process.exitCode = 1;
  server.close();
}, TIMEOUT_MS);

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  const start = `http://127.0.0.1:${port}/`;
  console.log(`Open ${start} in a browser signed in to GitHub as an owner of ${org}, then click "Create GitHub App".`);
  if (open) openBrowser(start);
});
