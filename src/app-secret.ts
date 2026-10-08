// The GitHub App credentials in Secrets Manager, and the GitHub client built
// from them. Both are cached for the life of the Lambda execution environment.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as z from "zod";
import { GitHubClient } from "./github.ts";

const secrets = new SecretsManagerClient({});

// A value the deploy left as the template's "REPLACE_ME" placeholder.
const filledIn = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("REPLACE"), "still the REPLACE_ME placeholder");

// The JSON stored in the GitHub App secret. See README, setup step 4.
const AppSecret = z.object({
  appId: z.union([z.string(), z.int()]).transform(String).pipe(filledIn),
  privateKey: filledIn,
  webhookSecret: filledIn,
});
type AppSecret = z.infer<typeof AppSecret>;

let cachedSecret: AppSecret | undefined;
export async function loadSecret(secretArn: string): Promise<AppSecret> {
  if (cachedSecret) return cachedSecret;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const parsed = AppSecret.safeParse(JSON.parse(res.SecretString ?? "{}"));
  if (!parsed.success) {
    throw new Error(`Secret ${secretArn} is incomplete. See README, setup step 4.\n${z.prettifyError(parsed.error)}`);
  }
  cachedSecret = parsed.data;
  return cachedSecret;
}

let cachedGitHub: GitHubClient | undefined;
export async function github({ SECRET_ARN, GITHUB_ORG }: { SECRET_ARN: string; GITHUB_ORG: string }): Promise<GitHubClient> {
  if (cachedGitHub) return cachedGitHub;
  const s = await loadSecret(SECRET_ARN);
  cachedGitHub = new GitHubClient({ appId: s.appId, privateKey: s.privateKey, org: GITHUB_ORG });
  return cachedGitHub;
}
