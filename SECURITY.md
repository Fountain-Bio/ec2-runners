# Security

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a vulnerability.

## Who can run code on the runners

Self-hosted runners run whatever the workflows that reach them contain. With ec2-runners, that is every job with the `ec2` or `microvm` label in a repository that both the GitHub App installation and the runner group allow. Anyone who can push a branch to one of those repositories can run code on the runners, and so can anyone who can open a pull request from a fork when a private repository enables workflows for fork pull requests.

The runners form one pool across those repositories. GitHub gives a queued job to any idle runner whose labels cover the job's labels, so a runner launched for one repository's job can run another repository's job. Treat everyone with push access to any allowed repository as trusted with every allowed repository's jobs. To narrow that set, create a dedicated runner group limited to selected repositories and deploy with its ID as `RunnerGroupId`.

## Protections

- **Private repositories only, by default.** The webhook and reconciler ignore jobs from public repositories, where pull requests from forks could run untrusted code. While the runner group's **Allow public repositories** setting is on and `AllowPublicRepos` is false, the reconciler launches nothing and sends an alert. When GitHub refuses the runner group lookup (403 or 404, as for organizations without the runner group API), the reconciler cannot read the setting and launches as usual. Enable `AllowPublicRepos` only if you accept the cache risk described below.
- **One job per runner.** Each runner registers with a just-in-time config for a single job and terminates afterwards, so no files or processes carry over to the next job.
- **Trusted images only.** EC2 runners boot from AMIs owned by the `AmiOwner` account (RunsOn's public images by default) or by the stack's own account. An `image=ami-…` label naming any other account's AMI fails, because a runner booted from an attacker's image could run a modified runner and capture other repositories' jobs.
- **No inbound access.** Runners sit in public subnets with a security group that has no inbound rules. Shell access is through Session Manager.
- **Narrow runner credentials.** An EC2 runner's instance role can read, write, and delete objects in the cache bucket, write to the boot log group, and use Session Manager (the minimal Session Manager actions only). The instance metadata service requires IMDSv2. MicroVM runners run under an execution role that can only write to the MicroVM log group. The MicroVM image is built from a bucket that runners cannot write to.
- **Signed webhooks.** The webhook function URL is public, and the function rejects any delivery without a valid HMAC signature before parsing it. Repeated invalid signatures raise a CloudWatch alarm.
- **Secrets in Secrets Manager.** The GitHub App's private key and webhook secret live in one Secrets Manager secret. The stack grants read access to its Lambda functions' roles only, and runners cannot read it. IAM principals in the account with broad Secrets Manager permissions, such as administrators, can read it too.
- **Verified runner download.** The boot script checks the actions runner download against the SHA-256 digest GitHub publishes for the release.

## What a job can do

- **Root on its instance.** Jobs on EC2 runners have passwordless `sudo`, as on GitHub-hosted runners, so a job controls its instance for the rest of its lifetime.
- **Use the instance role's credentials beyond the job.** Credentials a job reads from the instance metadata service stay valid until they expire, a few hours later, even after the instance terminates. A job can therefore keep reading, writing, and deleting cache objects for that long.
- **Read its own runner registration.** The just-in-time runner config is in the instance's user data. It registers only that one runner, which is already in use by the job.
- **Spend money.** The stack has no spending cap of its own. A workflow can ask for large instances (`cpu=`, `ram=`, `disk=`, `spot=false`) and many parallel jobs, each living up to `MaxMinutes`. The account's EC2 vCPU quotas are the effective limit, so keep them at a level you are prepared to pay for.

## The shared cache

The cache bucket is shared: every job on every repository that uses the runners can read, overwrite, and delete every cache entry, including BuildKit layers. Anyone who can push a branch to any allowed repository can therefore poison a cache that another repository restores. Treat cached content as trusted only as far as you trust everyone with push access to those repositories.

## Credentials to protect

- **The GitHub App's private key.** A holder can mint installation tokens with the app's permissions: register self-hosted runners in the organization (which then receive jobs), delete runners, and read Actions data, including logs and artifacts, in every repository the app is installed on.
- **The webhook secret.** A holder can send signed `workflow_job` events. The reconciler confirms with GitHub that a job is still queued before launching, but a forged event can choose the labels used for a real queued job's runner, or mark a real job done so that no runner launches for it.
- **The deploying credentials.** `deploy.sh` uploads the Lambda code to an artifact bucket it checks belongs to the deploying account.

## Trusted upstreams

Deployments trust these parties' releases, which the stack picks up automatically:

- [RunsOn](https://github.com/runs-on/runner-images-for-aws) for the default runner AMIs. The reconciler uses the newest image matching each `image=` name.
- GitHub for the actions runner (`RunnerVersion=latest` by default) and the `gh` CLI in the MicroVM image.
- The Node.js project and Bun for the releases baked into the MicroVM image, and AWS for the MicroVM base image.

The janitor rebuilds the MicroVM image when a new release of any of these appears. Each download's checksum comes from the same publisher as the download, so it protects against corruption in transit and not against a compromised release. Pin `RunnerVersion` and use your own AMIs if you need to review each update before it reaches runners.
