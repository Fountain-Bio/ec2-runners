import { createHmac, createSign, timingSafeEqual } from "node:crypto";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function appJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated 60s to tolerate clock drift; GitHub caps exp at 10 minutes.
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem, "base64url");
  return `${header}.${payload}.${signature}`;
}

export class GitHubApiError extends Error {
  constructor(status, method, path, body) {
    super(`GitHub ${method} ${path} failed with ${status}: ${body}`);
    this.status = status;
  }
}

async function request(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "ec2-runners",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new GitHubApiError(res.status, method, path, text);
  return text ? JSON.parse(text) : null;
}

// One client per org. Installation tokens last an hour; the client refreshes
// them five minutes before expiry and reuses them across warm invocations.
export class GitHubClient {
  constructor({ appId, privateKey, org }) {
    this.appId = appId;
    this.privateKey = privateKey;
    this.org = org;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async installationToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 5 * 60_000) return this.token;
    const jwt = appJwt(this.appId, this.privateKey);
    const installation = await request(jwt, "GET", `/orgs/${this.org}/installation`);
    const created = await request(jwt, "POST", `/app/installations/${installation.id}/access_tokens`);
    this.token = created.token;
    this.tokenExpiresAt = Date.parse(created.expires_at);
    return this.token;
  }

  async generateJitConfig({ name, labels, runnerGroupId }) {
    const token = await this.installationToken();
    return request(token, "POST", `/orgs/${this.org}/actions/runners/generate-jitconfig`, {
      name,
      runner_group_id: runnerGroupId,
      labels,
    });
  }

  async listRunners(namePrefix) {
    const token = await this.installationToken();
    const runners = [];
    for (let page = 1; ; page++) {
      const res = await request(token, "GET", `/orgs/${this.org}/actions/runners?per_page=100&page=${page}`);
      runners.push(...res.runners);
      if (res.runners.length < 100) break;
    }
    return runners.filter((r) => r.name.startsWith(namePrefix));
  }

  async deleteRunner(runnerId) {
    const token = await this.installationToken();
    await request(token, "DELETE", `/orgs/${this.org}/actions/runners/${runnerId}`);
  }
}
