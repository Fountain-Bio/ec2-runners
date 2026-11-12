# Security

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a vulnerability.

## Security model

Self-hosted runners run arbitrary code from every workflow that can reach them. The stack limits that exposure as follows:

- **Private repositories only, by default.** The webhook and reconciler ignore jobs from public repositories, where pull requests from forks could run untrusted code. While the runner group's **Allow public repositories** setting is on and `AllowPublicRepos` is false, the reconciler launches nothing and sends an alert. Enable `AllowPublicRepos` only if you accept the cache risk described below.
- **One job per runner.** Each runner registers with a just-in-time config for a single job and terminates afterwards, so no files, credentials, or processes carry over to the next job.
- **No inbound access.** Runners sit in public subnets with a security group that has no inbound rules. Shell access is through Session Manager.
- **Narrow runner credentials.** An EC2 runner's instance profile can read and write the cache bucket, write its boot log, and register with Session Manager. MicroVM runners get no AWS credentials. The MicroVM image is built from a bucket that runners cannot write to.
- **Signed webhooks.** The webhook function URL is public, and the function rejects any delivery without a valid HMAC signature. Repeated invalid signatures raise a CloudWatch alarm.
- **Secrets in Secrets Manager.** The GitHub App's private key and webhook secret live in one Secrets Manager secret. The stack grants read access to its Lambda functions' roles only, and runners cannot read it. IAM principals in the account with broad Secrets Manager permissions, such as administrators, can read it too.

The cache bucket is shared: every job on every repository that uses the runners can read and overwrite every cache entry, including BuildKit layers. Anyone who can push a branch to any repository in the organization can therefore poison a cache that another repository restores. Treat cached content as trusted only as far as you trust everyone with push access in the organization.
