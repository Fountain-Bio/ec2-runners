---
name: debug-ec2-runners
description: Diagnoses a deployed ec2-runners stack. Use when a job waits for an ec2 or microvm runner, a runner failed or never started, or an ec2-runners alert or CloudWatch alarm fired.
---

# Debug ec2-runners

The goal is a **root cause backed by evidence**: a log line, an API response, or a table row that explains the symptom. `docs/operations.md` describes every alert and log group, and `docs/architecture.md` describes how a job becomes a runner.

## 1. Pin down the deployment and the symptom

Get the AWS profile, region (`$REGION`), stack name (`$STACK`, default `ec2-runners`), and GitHub organization (`$ORG`). Confirm the stack exists with `aws cloudformation describe-stacks --region $REGION --stack-name $STACK`. The runner and runner group API calls in step 3 need an organization owner's `gh` login with the `admin:org` scope; when `gh auth status` does not list it, ask the person to run `gh auth refresh -h github.com -s admin:org`.

Get the symptom as one of:

- **A job**: its URL or `owner/repo` and job ID (`$REPO`, `$JOB`). A run URL gives the run; `gh run view <run id> --repo $REPO --json jobs --jq '.jobs[] | {databaseId, name, status}'` lists its job IDs.
- **An alert**: its title and text.

**Done when** you know the deployment and have either a job ID or an alert text.

## 2. An alert

Find the alert's row in the Alerts table in `docs/operations.md`, and carry out its action. Alerts about a job name the repository and job; continue with step 3 for that job when the alert's action does not resolve it.

**Done when** the alert's action is done or the cause is identified.

## 3. A job

Work through these checks in order, recording each result. Stop at the first one that explains the symptom.

1. **The job.** `gh api repos/$REPO/actions/jobs/$JOB --jq '{status, labels, runner_name, created_at}'`. The labels must include `ec2` or `microvm` (or the stack's `TriggerLabel` and `MicrovmLabel`). A job with `runner_name` set has a runner; the problem is in the job itself.
2. **The repository.** `gh api repos/$REPO --jq .private` must be `true`, unless the stack has `AllowPublicRepos=true`. The app must be installed on the repository: `gh api orgs/$ORG/installations --jq '.installations[] | {app_slug, repository_selection}'`, and for `selected`, the repository must be among the installation's repositories.
3. **The jobs table.** `aws dynamodb get-item --region $REGION --table-name $STACK-jobs --key '{"jobId":{"N":"'$JOB'"}}'`. No item means the webhook never recorded the job; the next scheduled reconcile adds it within 5 minutes, so check the webhook deliveries in the GitHub App's **Advanced** tab and the webhook log. `status` `failed` means the reconciler gave up on the job; its `error` text says whether the labels can never launch or the job's runners kept going unused. A high `launchFailures` means launches keep failing. `idleRunners` of 2 or more means GitHub is not assigning the job to its runners.
4. **The reconciler log.** Each line is JSON with a numeric `jobId`:
   ```bash
   aws logs tail /aws/lambda/$STACK-reconciler --region $REGION --since 2h --filter-pattern '{ $.jobId = '$JOB' }'
   ```
   `launched runner` or `launched MicroVM runner` names the runner. `launch failed, will retry` and `job cannot launch` carry EC2's or GitHub's error. `job never assigned to its runners` points to the runner group. Without the `--filter-pattern`, `runner group allows public repositories, launching nothing` means nothing launches for any job.
5. **The runner.** Runner names are `$STACK-$JOB-<launch time>`. `gh api orgs/$ORG/actions/runners --paginate --jq '.runners[] | select(.name | startswith("'$STACK-$JOB-'")) | {name, status, busy}'` shows its registration. A runner that is `online` and not `busy` while the job stays queued means GitHub will not give it the job: check the runner group's repository access with `gh api orgs/$ORG/actions/runner-groups/1 --jq '{visibility, allows_public_repositories}'` (use the stack's `RunnerGroupId`).
6. **The instance.** For an EC2 runner, read its boot log, which includes the runner's output:
   ```bash
   aws logs tail /ec2-runners/$STACK/boot --region $REGION --since 6h --log-stream-name-prefix $STACK-$JOB-
   ```
   The log is copied when the boot script exits or the instance terminates. For a running instance, find it with `aws ec2 describe-instances --region $REGION --filters "Name=tag:ec2-runners:runner-name,Values=$STACK-$JOB-*"` and read `/var/log/ec2-runner-boot.log` through `aws ssm start-session`. For a MicroVM runner, read `/aws/lambda-microvms/$STACK-runner`.

**Done when** one check explains the symptom with the evidence in hand, or every check has a recorded result.

## 4. Report

Tell the person the root cause, the evidence (quote the log line or API output), and the fix: the workflow, quota, runner group, or stack parameter to change. Apply a fix only with the person's approval. When every check passed and the job still waits, report each check's result and the time window searched, since `aws logs tail --since` may need widening.
