import { expect, test } from "vite-plus/test";
import { appManifest, appSecretString, isPlaceholderSecret, manifestPage } from "../scripts/github-app.ts";

const manifest = appManifest({
  org: "example-org",
  stack: "ec2-runners",
  webhookUrl: "https://abc.lambda-url.us-west-2.on.aws/",
  redirectUrl: "http://127.0.0.1:4567/callback",
});

test("the manifest asks for the permissions and events in docs/setup.md", () => {
  expect(manifest).toMatchObject({
    name: "ec2-runners-example-org",
    hook_attributes: { url: "https://abc.lambda-url.us-west-2.on.aws/", active: true },
    redirect_url: "http://127.0.0.1:4567/callback",
    public: false,
    default_permissions: { actions: "read", metadata: "read", organization_self_hosted_runners: "write" },
    default_events: ["workflow_job"],
  });
});

test("the app name fits GitHub's 34-character limit", () => {
  const long = appManifest({ org: "an-organization-with-a-long-name", stack: "ec2-runners", webhookUrl: "x", redirectUrl: "y" });
  expect(long.name).toHaveLength(34);
});

test("the manifest page posts the escaped manifest to the organization's new-app form", () => {
  const page = manifestPage("example-org", "s1", { ...manifest, name: `a"<b>` });
  expect(page).toContain('action="https://github.com/organizations/example-org/settings/apps/new?state=s1"');
  expect(page).not.toContain('a"<b>');
  const value = /name="manifest" value="([^"]*)"/.exec(page)![1]!;
  const decoded = value.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  expect(JSON.parse(decoded)).toMatchObject({ name: `a"<b>`, default_events: ["workflow_job"] });
});

test("the secret has the shape src/app-secret.ts parses", () => {
  const secret = appSecretString({ id: 42, slug: "s", html_url: "u", pem: "-----BEGIN-----", webhook_secret: "w" });
  expect(JSON.parse(secret)).toEqual({ appId: "42", privateKey: "-----BEGIN-----", webhookSecret: "w" });
});

test("only an empty or placeholder secret counts as safe to overwrite", () => {
  expect(isPlaceholderSecret(undefined)).toBe(true);
  expect(isPlaceholderSecret('{"appId":"REPLACE_ME","privateKey":"REPLACE_ME","webhookSecret":"REPLACE_ME"}')).toBe(true);
  expect(isPlaceholderSecret('{"appId":"123","privateKey":"k","webhookSecret":"w"}')).toBe(false);
  expect(isPlaceholderSecret('{"appId":123}')).toBe(false);
  expect(isPlaceholderSecret("not json")).toBe(false);
});
