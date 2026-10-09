# ec2-runners

Ephemeral GitHub Actions runners on EC2 Spot for the example-org org, deployed as one CloudFormation stack. Each job that asks for an EC2 runner gets a fresh instance sized from its labels. The instance runs that one job and terminates itself.

## How it works

1. GitHub sends a `workflow_job` webhook to a Lambda function URL (`<stack>-webhook`). The function checks the HMAC signature and keeps only jobs whose labels include `ec2`. It records each queued job from a private repository in a DynamoDB table (`<stack>-jobs`), marks jobs done when they start or finish, and invokes the reconciler asynchronously.
2. The reconciler (`<stack>-reconciler`) compares the queued jobs with the runners that could still take them: registered, idle, and either running or still launching. It launches a runner for each job those runners cannot cover. Before launching, it confirms with the GitHub API that the job is still queued, finds the newest matching AMI, and checks that some instance type matches the labels. It then registers a just-in-time runner with the job's labels and calls EC2 Fleet (`instant`) with attribute-based instance selection, one subnet per call in shuffled order, trying Spot with `price-capacity-optimized` in each subnet first, then On-Demand.
3. The instance boot script runs `run.sh --jitconfig`, executes the job, and powers off. The launch template sets shutdown behavior to `terminate`, so power-off deletes the instance.
4. The janitor (`<stack>-janitor`, every 5 minutes) terminates instances that have not started a job within `IdleMinutes` or have run longer than `MaxMinutes`, removes runner registrations whose instance has ended or never appeared, and deletes launch template versions left by a reconciler that stopped partway. The same schedule also runs the reconciler, which retries launches that still failed after a reconcile's own retries, replaces runners the janitor terminated for still-queued jobs, and catches up on reconciles that the webhook could not invoke. GitHub sometimes never sends a job's `queued` webhook, and a delivery can also fail, which leaves the job out of the jobs table. Before each scheduled reconcile, the reconciler therefore lists the queued jobs in the workflow runs of the last 24 hours in every private repository the GitHub App can access (public ones too when `AllowPublicRepos` is true), and records those with the `ec2` label that the table lacks. Such a job waits at most about 5 minutes for its runner. The reconciler's log records each one as `recorded queued jobs whose webhook never arrived`.

### Why the reconciler matches jobs to runners

GitHub gives a queued job to any idle runner whose labels include all of the job's labels. It does not know which job a runner was launched for, so a job that asks for `[ec2]` can start on a runner launched for a job that asked for `[ec2, cpu=8]`. The reconciler therefore treats the stack's runners as one pool. On every run it pairs queued jobs with available runners using a maximum bipartite matching, and launches only for the jobs left without a runner. Two jobs that each take the other's runner need no launch. A `cpu=8` job whose runner went to an `[ec2]` job gets a new runner, because the `[ec2]` job's runner does not fit it.

Reconciles never overlap: each pass holds a lock item in the jobs table. An invocation that finds the lock held records a request and exits, and the holder runs one more pass for each request before releasing the lock. Each pass therefore sees the runners the previous pass registered, so two reconciles do not launch for the same job. A holder that crashes keeps the lock only until 30 seconds past the reconciler's Lambda timeout. A job can still get a second runner in a narrow window: GitHub marks a runner busy a moment before the job's status changes, and a reconcile in between sees the job queued with no free runner. The spare runner serves the next queued job that fits it, or the janitor terminates it after `IdleMinutes`. One run launches all uncovered jobs in parallel, so a burst of queued jobs does not wait on a line of separate runs.

The matching also shows which idle runners no queued job needs. A running one whose own job has started elsewhere, finished, or been cancelled is retired right away instead of idling until `IdleMinutes`, which matters for repositories whose CI cancels superseded runs.

Runner names are `<stack>-<job id>-<launch time>`. The job ID shows which job the launch was for, and the launch time lets the janitor remove a registration that never got an instance.

### Alerts

The `<stack>-alerts` SNS topic receives these alerts and passes them to Slack (setup step 2) and to `AlertEmail`:

- A job whose labels can never launch, such as `cpu=3` or an unknown image. Sent once per job.
- A job that has failed to launch ten times, for example for lack of Spot capacity or vCPU quota. A reconcile whose launch fails retries it 30 seconds later, up to 6 passes per invocation, and the 5-minute schedule picks the job up after that. Ten failures take about 5 minutes.
- A job whose runners keep going unused. When two runners launched for a job sit idle until the janitor terminates them while the job is still queued, GitHub is not assigning the job to them. Usually the runner group does not allow the job's repository. The reconciler stops launching for that job.
- The runner group allows public repositories while `AllowPublicRepos` is false. No runners launch until one of the two settings changes.
- CloudWatch alarms, both when they fire and when they clear:
  - `<stack>-webhook-errors`: the webhook failed on a delivery. GitHub does not retry it. The next scheduled reconcile records the job if it is still queued, so fixing the cause is the only action needed.
  - `<stack>-webhook-invalid-signatures`: three or more deliveries in 15 minutes failed signature checks, which usually means the webhook secret in GitHub differs from the one in the app secret.
  - `<stack>-reconciler-errors`: a reconcile failed before reaching any job, for example on a GitHub API error, or the scheduled check for queued jobs missing from the jobs table failed.
  - `<stack>-janitor-errors`: the janitor failed, so idle instances are not being terminated.

A job that cannot launch stays queued in GitHub until it is cancelled or GitHub's 24-hour queue limit ends it.

The stack creates its own VPC with three public subnets and no NAT gateway. The runner security group has no inbound rules. An S3 gateway endpoint keeps cache traffic on the AWS network.

## Using it in a workflow

```yaml
jobs:
  build:
    runs-on: [ec2, cpu=4]
    steps:
      - uses: actions/checkout@v6
      - uses: runs-on/cache@v5          # drop-in for actions/cache, backed by the stack's S3 bucket
        with:
          path: ~/.npm
          key: npm-${{ hashFiles('package-lock.json') }}
      - run: npm ci && npm test
```

Labels can be separate entries or one string joined with `/`, for example `runs-on: "ec2/cpu=8/ram=32"`.

| Label | Default | Meaning |
| --- | --- | --- |
| `ec2` | required | Opts the job in. Change with the `TriggerLabel` parameter. |
| `cpu=N` | 2 | Exact vCPU count. |
| `ram=N` | `cpu × 2` | Minimum memory in GiB. |
| `family=c7i+m7a` | any current generation | Allowed instance families, joined with `+`. A full type such as `c7i.2xlarge` also works. |
| `image=NAME` | `ubuntu24-full-x64` | Runner image. `ubuntu24-full-arm64`, `ubuntu22-full-x64`, and the others published at [runs-on/runner-images-for-aws](https://github.com/runs-on/runner-images-for-aws). An AMI ID (`image=ami-…`) is used as-is. |
| `disk=N` | 40 | Root volume size in GiB (gp3). Raised automatically to the AMI snapshot size when that is larger. |
| `spot=false` | spot on | Launch On-Demand only. Use for jobs that cannot tolerate a Spot interruption. |
| `nvme=true` | off | Require an instance type with local NVMe SSDs (`c7id`, `m7gd`, `c6id`, and similar). Recommended for Docker builds. |

Any other `key=value` label, such as `run=${{ github.run_id }}`, is copied onto the runner and otherwise ignored. Jobs without the `ec2` label keep running on GitHub-hosted runners, so workflows can move one job at a time.

Jobs run in `/home/runner/work/<repo>/<repo>` with `HOME` at `/home/runner`, the layout of GitHub-hosted and Blacksmith runners. `actions/cache` stores paths outside the workspace, such as `~/.bun`, relative to the workspace, so this layout lets a cache saved on those runners restore to the right place here.

Every job also gets these variables, usable in shells and as `${{ env.NAME }}` in workflow expressions: `EC2_RUNNER_CACHE_BUCKET`, `EC2_RUNNER_REGION`, and `EC2_RUNNER_NVME` (`true` when the instance store is in use).

The cache bucket is shared by every repository and branch that uses these runners, and every job can read and write all of it. A job in one repository can therefore replace a cache entry that a build in another repository restores. Treat cached content as trusted only as far as everyone who can push a branch in the org is trusted.

The `full` images are ports of GitHub's hosted runner images, so actions that work on `ubuntu-latest` generally work here. `runs-on/cache` reads the bucket name from `RUNS_ON_S3_BUCKET_CACHE`, which the boot script sets for every job, and authenticates with the instance profile. On GitHub-hosted runners the variable is absent and `runs-on/cache` falls back to GitHub's cache.

## Docker builds

Local NVMe disks and the BuildKit layer cache make image builds fast. Neither requires changes to Dockerfiles.

### Local NVMe disks

When the instance type has instance-store SSDs, the boot script formats them (striped with RAID 0 when there are several), and mounts them over `/var/lib/docker`, `/var/lib/containerd`, the job work directory (`/home/runner/work`), and `TMPDIR`. `nvme=true` makes the reconciler choose only such instance types. Instance-store disks are much faster than the gp3 root volume and are erased when the instance terminates. Images preloaded in the AMI under `/var/lib/docker` are hidden by the mount, which matters only for jobs that relied on them.

### BuildKit layer cache in S3

BuildKit stores layer cache in the stack's S3 bucket with `type=s3`. The default `docker` build driver cannot export cache, so the build needs a `docker-container` builder, which `docker/setup-buildx-action` creates. Buildx reads the instance-profile credentials on the host and passes them to BuildKit, so no AWS keys are needed.

```yaml
jobs:
  image:
    runs-on: [ec2, cpu=8, nvme=true]
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v4
      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: your-registry/app:${{ github.sha }}
          cache-from: type=s3,region=${{ env.EC2_RUNNER_REGION }},bucket=${{ env.EC2_RUNNER_CACHE_BUCKET }},prefix=buildkit/${{ github.repository }}/,name=app
          cache-to: type=s3,region=${{ env.EC2_RUNNER_REGION }},bucket=${{ env.EC2_RUNNER_CACHE_BUCKET }},prefix=buildkit/${{ github.repository }}/,name=app,mode=max,ignore-error=true
```

`mode=max` caches the layers of every build stage, which is what makes multi-stage builds skip unchanged stages. BuildKit refreshes the timestamps of layers it reuses once a day, so the bucket's 10-day expiry removes only layers that no build has used recently. `ignore-error=true` keeps a cache upload failure from failing the build. Use a different `name` for each image built from the same repository.

## Setup

Requirements: AWS CLI v2 with admin credentials for the target account, [Bun](https://bun.com), and owner access to the GitHub org.

### 1. Deploy the stack

```bash
AWS_PROFILE=dev ./deploy.sh AlertEmail=you@example.com
```

The script deploys to us-west-2 unless `AWS_REGION` is set. It creates an artifact bucket for the Lambda zip on first run, then bundles the code, packages, and deploys. The region needs three availability zones, and the `runs-on-v2.2-*` AMIs are published in us-east-1, us-east-2, us-west-2, eu-west-1, eu-west-2, eu-west-3, eu-central-1, ap-south-1, ap-northeast-1, ap-southeast-1, and ap-southeast-2. The stack prints `WebhookUrl`, `GitHubAppSecretArn`, `CacheBucket`, and `AlertTopicArn`. With `AlertEmail` set, SNS emails a subscription confirmation that must be accepted before alerts arrive.

### 2. Connect Slack

Alerts reach Slack through Amazon Q Developer in chat applications (formerly AWS Chatbot). The account's channel configuration for #alerts is `slack-alerts`, created in that console. Add the stack's alert topic to it:

```bash
TOPIC=$(aws cloudformation describe-stacks --profile dev --stack-name ec2-runners \
  --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue" --output text)
aws chatbot update-slack-channel-configuration --profile dev --region us-east-2 \
  --chat-configuration-arn <channel configuration ARN> \
  --slack-channel-id <channel ID> --sns-topic-arns "$TOPIC"
```

`--sns-topic-arns` replaces the configuration's topic list, so include any topics already on it (`aws chatbot describe-slack-channel-configurations --region us-east-2` lists them).

### 3. Create the GitHub App

In the example-org org settings, open Developer settings, then GitHub Apps, then New GitHub App:

- Webhook URL: the `WebhookUrl` output.
- Webhook secret: a random string, for example from `openssl rand -hex 32`. Keep it for step 4.
- Repository permissions: Actions: Read-only, Metadata: Read-only.
- Organization permissions: Self-hosted runners: Read and write.
- Subscribe to events: Workflow job.
- Where can this app be installed: Only on this account.

After creating the app, note the App ID, generate a private key (a `.pem` file downloads), and install the app on the org for all repositories or the ones that should use EC2 runners.

### 4. Store the credentials

```bash
aws secretsmanager put-secret-value \
  --secret-id "<GitHubAppSecretArn>" \
  --secret-string "$(jq -n \
      --arg appId "<App ID>" \
      --rawfile privateKey path/to/app.private-key.pem \
      --arg webhookSecret "<webhook secret>" \
      '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
```

### 5. Check the runner group

The reconciler registers runners in the org's Default runner group (ID 1). Jobs from public repositories are ignored by default, because pull requests from forks would run untrusted code with write access to the shared cache bucket. To use these runners from public repositories anyway, deploy with `AllowPublicRepos=true` and enable "Allow public repositories" on the runner group in org settings under Actions, Runner groups. GitHub gives runners to any job the runner group allows, so the reconciler also reads the group's setting: while the group allows public repositories and `AllowPublicRepos` is false, it launches nothing and sends an alert.

### 6. Test

Push a workflow with `runs-on: [ec2]`. In the GitHub App's Advanced tab, recent deliveries should show `202` for `queued` events and `200` for most other events. Logs are in CloudWatch under `/aws/lambda/<stack>-webhook`, `-reconciler`, and `-janitor`. Each runner's boot log, which includes the runner's own output, is at `/var/log/ec2-runner-boot.log` on the instance (reachable through Session Manager while it is alive) and is copied to the `/ec2-runners/<stack>/boot` log group, in a stream named after the runner, when the boot script exits or the instance is terminated.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `GitHubOrg` | `example-org` | Org the app is installed on. Webhooks from other orgs are ignored. |
| `TriggerLabel` | `ec2` | Label that opts a job in. |
| `RunnerGroupId` | `1` | Org runner group for registrations. |
| `IdleMinutes` | `20` | Kill an instance that has not started a job after this long. A backstop for runners the reconciler did not retire, such as one whose runner process failed to connect. |
| `MaxMinutes` | `360` | Hard instance lifetime, enforced both by the boot script and the janitor. |
| `AmiOwner`, `AmiNamePrefix` | RunsOn public images | Where `image=` names are looked up. |
| `RunnerVersion` | `latest` | actions/runner version to download when the AMI does not have one at `/opt/ec2-runner`. The boot script checks the download against the SHA-256 digest GitHub publishes for the release asset, so the version must be 2.325.0 or later. |
| `CpuBaselineFamily` | `m6i` | Slowest CPU a runner may get, as an instance family. Excludes older types such as `i3` and `m5d` that EC2's "current generation" filter still allows and that are often the cheapest Spot types with local SSDs. Empty turns the floor off. A compute-family reference such as `c6i` matches no instance type for jobs with 4 GiB or more per vCPU. |
| `CacheRetentionDays` | `10` | Lifecycle expiry on the cache bucket. |
| `VpcCidr` | `10.42.0.0/16` | VPC range, split into three /20 subnets. |
| `AllowPublicRepos` | `false` | Launch runners for jobs from public repositories. See setup step 5. |
| `AlertEmail` | empty | Email address subscribed to the `<stack>-alerts` topic. See [Alerts](#alerts) for what it receives. |

Pass overrides as `./deploy.sh Key=Value …`.

## Known limits

- A Spot interruption fails the job. GitHub does not retry it automatically. Mark interruption-sensitive jobs `spot=false`.
- A job that stays queued longer than `IdleMinutes` while its runner sits idle loses that runner to the janitor, and the next reconcile launches another. Raise `IdleMinutes` if jobs often wait that long.
- When a job ends before it starts, for example when a newer push cancels it, the reconciler retires the runner launched for it: it deletes the registration, then terminates the instance. A runner that a queued job can still use is kept for that job. GitHub can assign a job to the runner in the moment between the reconciler's check and the deletion, which fails that job; this needs a job queued within that second, matching the runner's labels.
- The boot script downloads the actions runner from GitHub on each boot, which adds a few seconds. Baking it into a custom AMI at `/opt/ec2-runner` skips the download.
- The default AMIs are built and published by RunsOn. To use your own, build an AMI and set `AmiOwner` and `AmiNamePrefix`, or pass `image=ami-…`.
- Linux only. Windows and GPU images would need GPU instance requirements and a PowerShell boot script.

## Development

The code is TypeScript, run directly by [Bun](https://bun.com) in development. GitHub calls and webhook payload types come from Octokit, and Zod parses the environment, the app secret, and the rows read from the jobs table. The Lambdas run on the Node.js 24 runtime, so `deploy.sh` bundles `src/index.ts` and its dependencies, including the AWS SDK clients, into a single `index.mjs` with `bun build`.

```bash
bun install
bun test
bun run test:integration # jobs table against DynamoDB Local; needs Docker
bun run typecheck        # tsc, for src/ (Node types only) and test/ (Bun types)
bun run build            # writes .build/lambda/index.mjs; deploy.sh runs this
bun run lint:template    # cfn-lint through uvx; needs uv
```

`.github/workflows/ci.yml` runs the same checks on every push to `main` and every pull request, on this stack's own `ec2` runners. A passing run therefore also shows that the webhook, reconciler, and runners work. If the stack is down, CI waits for a runner until the stack is fixed and redeployed.

## Removing it

Run these with the same AWS region and stack name used for `deploy.sh`.

```bash
STACK=ec2-runners
REGION=us-west-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1. Stop new jobs from launching: in GitHub, uninstall the GitHub App from the org
#    (org settings, GitHub Apps), then delete the app (Developer settings, GitHub Apps).

# 2. Terminate any runner instances still running.
IDS=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:ec2-runners:stack,Values=$STACK" "Name=instance-state-name,Values=pending,running" \
  --query "Reservations[].Instances[].InstanceId" --output text)
[ -n "$IDS" ] && aws ec2 terminate-instances --region "$REGION" --instance-ids $IDS

# 3. Empty the cache bucket. CloudFormation cannot delete a bucket that still has objects.
CACHE=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CacheBucket'].OutputValue" --output text)
aws s3 rm "s3://$CACHE" --recursive --region "$REGION"

# 4. Delete the stack and wait for it to finish.
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"

# 5. Delete the artifact bucket that deploy.sh created for the Lambda code.
aws s3 rb "s3://$STACK-artifacts-$ACCOUNT-$REGION" --force --region "$REGION"
```

Then remove the `ec2` labels from workflows, or those jobs will wait for a runner that never comes.

Step 4 removes everything else: the VPC, Lambdas, jobs table, launch template, IAM roles, log groups, alarms, alert topic, and the GitHub App secret. The Slack channel configuration keeps the deleted topic's ARN in its list until it is removed in the Amazon Q Developer in chat applications console. Secrets Manager may keep the deleted secret in a recovery window before removing it, during which it is not billed.
