# Operations

This page is for whoever runs the stack: what each alert means and what to do about it, where the logs are, how to find out why a job is still queued, and the limits of the design.

Agents can follow the `debug-ec2-runners` skill in `.agents/skills/debug-ec2-runners/SKILL.md`, which walks the same checks.

## Alerts

The `<stack>-alerts` SNS topic receives these alerts. [Setup](setup.md#5-route-alerts) covers routing it to email and chat.

| Alert | Meaning | Action |
| --- | --- | --- |
| A job's labels can never launch | The job asks for something no instance type or image provides, such as `cpu=3` or an unknown `image=`. The reconciler sends "Runner labels cannot launch" once per job. Labels the webhook rejects outright, such as both `ec2` and `microvm`, EC2 labels on a `microvm` job, or `cpu=abc`, first send "Invalid runner labels", and the scheduled backfill later sends "Runner labels cannot launch" for the same job. | Fix the workflow's `runs-on`. The job stays queued until it is cancelled or GitHub's 24-hour queue limit ends it. |
| A job has failed to launch ten times | EC2 kept refusing the launch, for example for lack of Spot capacity or vCPU quota. Ten failures take about 5 minutes. | Read the error in the alert. For quota errors, raise the vCPU quota ([Setup](setup.md#account-quotas)). For capacity errors, widen `family=` or drop it, or use `spot=false`. |
| A job's runners keep going unused | Two runners launched for the job sat idle until the janitor terminated them while the job stayed queued, so GitHub is not assigning the job to them. The reconciler stops launching for that job. | Usually the runner group does not allow the job's repository. Check the group's repository access in organization settings under **Actions → Runner groups**. |
| The runner group allows public repositories | The group's **Allow public repositories** setting is on while `AllowPublicRepos` is false. No runners launch until one of the two changes. | Turn the group setting off, or deploy with `AllowPublicRepos=true`. |
| A MicroVM image build failed | MicroVM jobs run on EC2 runners until a build succeeds. The janitor retries after 6 hours, or sooner when the runner, gh, Node.js, or Bun release or the image source changes. | Read the build log in `/aws/lambda-microvms/<stack>-runner`. |
| `<stack>-webhook-errors` alarm | The webhook failed on a delivery. GitHub does not retry it. | The next scheduled reconcile records the job if it is still queued, so fixing the cause in the webhook log is the only action needed. |
| `<stack>-webhook-invalid-signatures` alarm | Three or more deliveries in 15 minutes failed signature checks. | The webhook secret in the GitHub App differs from `webhookSecret` in the app secret. Set them to the same value. |
| `<stack>-reconciler-errors` alarm | The reconciler failed in each of the last three 5-minute periods, for example on GitHub API errors, or because the scheduled check for queued jobs missing from the jobs table kept failing. | Read the reconciler log. The GitHub client retries server errors twice and waits out rate limits of 30 seconds or less, so the alarm means GitHub kept failing or asked for a longer wait. |
| `<stack>-janitor-errors` alarm | The janitor failed, so idle instances are not being terminated. | Read the janitor log, and check for runner instances older than `MaxMinutes`. |

CloudWatch alarms send a message both when they fire and when they clear.

The reconciler alarm ignores a single failure: Lambda retries the invocation, and the schedule runs again 5 minutes later. The scheduled check for missed webhooks queries each repository separately, so one repository's failure does not keep the others' jobs from being recorded, and it skips a repository that answers 404 because it was deleted or removed from the installation.

## Logs

| Log group | Contents |
| --- | --- |
| `/aws/lambda/<stack>-webhook` | Queued jobs it passed to the reconciler (`invoked reconciler`), deliveries with invalid signatures, jobs from public repositories it ignored, and jobs with invalid labels. Other deliveries leave no line. |
| `/aws/lambda/<stack>-reconciler` | Each reconcile: jobs recorded from the backfill, the matching, launches and their errors, runners retired. Failed GitHub requests appear as `GitHub request failed` and rate limits as `GitHub rate limit`. |
| `/aws/lambda/<stack>-janitor` | Instances and MicroVMs terminated, registrations removed, MicroVM image builds. |
| `/ec2-runners/<stack>/boot` | Each EC2 runner's boot log, in a stream named after the runner, copied when the boot script exits or the instance is terminated. |
| `/aws/lambda-microvms/<stack>-runner` | MicroVM image builds and each MicroVM runner's output. |

The boot log includes the runner's own output. The boot script prefixes each of its steps with a UTC timestamp, and its first line records the kernel's uptime, so the log shows how long the OS boot, the instance store setup, the runner download, and Docker startup each took. While an instance runs, the same log is at `/var/log/ec2-runner-boot.log`, reachable through Session Manager (`aws ssm start-session --target <instance id>`).

The GitHub App's **Advanced** tab lists recent webhook deliveries with their response codes: `202` for `queued` events the stack recorded, `200` for most other events.

## A job stays queued

Work through these in order:

1. **Does the job have the trigger label?** `runs-on` must include `ec2` (or `TriggerLabel`) or `microvm`. Jobs without one wait for some other runner.
2. **Is the repository private, and is the app installed on it?** The stack ignores public repositories unless `AllowPublicRepos` is true, and the scheduled backfill reads only repositories the installation can access.
3. **Did the webhook arrive?** Look for the delivery in the GitHub App's **Advanced** tab and in the webhook log. A missing delivery is recovered by the next scheduled reconcile, within about 5 minutes.
4. **Did the reconciler launch?** Search the reconciler log for the job ID. A launch error there names the cause: quota, capacity, an unknown image, or a label combination that matches no instance type.
5. **Did the runner start?** Runner names are `<stack>-<job id>-<launch time>`. Find the runner by name in organization settings under **Actions → Runners**, and the instance by its `ec2-runners:runner-name` tag, then read its boot log. A runner that registered but never took the job usually means the runner group does not allow the repository.

## Known limits

- A Spot interruption fails the job. GitHub does not retry it automatically. Mark interruption-sensitive jobs `spot=false`.
- A job that stays queued longer than `IdleMinutes` while its runner sits idle loses that runner to the janitor, and the next reconcile launches another. Raise `IdleMinutes` if jobs often wait that long.
- When a job ends before it starts, for example when a newer push cancels it, the reconciler retires the runner launched for it: it deletes the registration, then terminates the instance. A runner that a queued job can still use is kept for that job. GitHub can assign a job to the runner in the moment between the reconciler's check and the deletion, which fails that job. This needs a job matching the runner's labels to be queued within that second.
- The boot script downloads the actions runner from GitHub on each boot, which adds a few seconds. Baking it into a custom AMI at `/opt/ec2-runner` skips the download.
- The default AMIs are built and published by RunsOn. To use your own, build an AMI and set `AmiOwner` and `AmiNamePrefix`, or pass `image=ami-…` with an AMI in the stack's own account.
- Linux only. Windows and GPU images would need GPU instance requirements and a PowerShell boot script.
- One stack serves one GitHub organization. Repository-level and enterprise-level runners are not supported.
