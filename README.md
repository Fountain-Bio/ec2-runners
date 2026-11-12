# ec2-runners

Ephemeral GitHub Actions runners on EC2 Spot and AWS Lambda MicroVMs for the example-org org, deployed as one CloudFormation stack. Each job that asks for an EC2 runner gets a fresh instance sized from its labels. Each job that asks for a MicroVM runner gets a fresh Lambda MicroVM, which starts in seconds, for short jobs. A runner runs its one job and terminates itself.

## How it works

1. GitHub sends a `workflow_job` webhook to a Lambda function URL (`<stack>-webhook`). The function checks the HMAC signature and keeps only jobs whose labels include `ec2` or `microvm`. It records each queued job from a private repository in a DynamoDB table (`<stack>-jobs`), marks jobs done when they start or finish, and invokes the reconciler asynchronously.
2. The reconciler (`<stack>-reconciler`) compares the queued jobs with the runners that could still take them: registered, idle, and either running or still launching. It launches a runner for each job those runners cannot cover. Before launching, it confirms with the GitHub API that the job is still queued, finds the newest matching AMI, and checks that some instance type matches the labels. It then registers a just-in-time runner with the job's labels and calls EC2 Fleet (`instant`) with attribute-based instance selection, one subnet per call in shuffled order, trying Spot with `price-capacity-optimized` in each subnet first, then On-Demand. A `microvm` job gets a Lambda MicroVM instead (see [MicroVM runners](#microvm-runners)).
3. The instance boot script runs `run.sh --jitconfig`, executes the job, and powers off. The launch template sets shutdown behavior to `terminate`, so power-off deletes the instance.
4. The janitor (`<stack>-janitor`, every 5 minutes) terminates instances that have not started a job within `IdleMinutes` or have run longer than `MaxMinutes`, removes runner registrations whose instance has ended or never appeared, and deletes launch template versions left by a reconciler that stopped partway. The same schedule also runs the reconciler, which retries launches that still failed after a reconcile's own retries, replaces runners the janitor terminated for still-queued jobs, and catches up on reconciles that the webhook could not invoke. GitHub sometimes never sends a job's `queued` webhook, and a delivery can also fail, which leaves the job out of the jobs table. Before each scheduled reconcile, the reconciler therefore lists the queued jobs in the workflow runs of the last 24 hours in every private repository the GitHub App can access (public ones too when `AllowPublicRepos` is true), and records those with the `ec2` or `microvm` label that the table lacks. Such a job waits at most about 5 minutes for its runner. The reconciler's log records each one as `recorded queued jobs whose webhook never arrived`.

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
- A MicroVM image build failed. MicroVM jobs run on EC2 runners until a build succeeds. The janitor retries after 6 hours, or sooner when the runner, gh, Node.js, or Bun release or the image source changes. The build log is in `/aws/lambda-microvms/<stack>-runner`.
- CloudWatch alarms, both when they fire and when they clear:
  - `<stack>-webhook-errors`: the webhook failed on a delivery. GitHub does not retry it. The next scheduled reconcile records the job if it is still queued, so fixing the cause is the only action needed.
  - `<stack>-webhook-invalid-signatures`: three or more deliveries in 15 minutes failed signature checks, which usually means the webhook secret in GitHub differs from the one in the app secret.
  - `<stack>-reconciler-errors`: the reconciler failed in each of the last three 5-minute periods (15 minutes), for example on GitHub API errors, or the scheduled check for queued jobs missing from the jobs table kept failing. A single failure does not fire it: Lambda retries the invocation, and the schedule runs again 5 minutes later. The scheduled check queries each repository separately, so one repository's failure does not keep the others' jobs from being recorded, and it skips a repository that answers 404 because it was deleted or removed from the installation. The GitHub client retries a server error or failed connection twice, 1 and 4 seconds later, and waits out a rate limit once when GitHub asks for 30 seconds or less, so the alarm means GitHub kept failing or asked for a longer wait. The log records each failed attempt as `GitHub request failed` and each rate limit as `GitHub rate limit`.
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

## MicroVM runners

A job labelled `microvm` runs in an AWS Lambda MicroVM: a Firecracker VM that Lambda starts from a snapshot of the stack's MicroVM image. From a job being queued to the job starting takes about 10 seconds, against about 30 to 45 for an EC2 runner, so short jobs such as path filters, status gates, and review bots spend more of their time working.

```yaml
jobs:
  changes:
    runs-on: microvm
    steps:
      - run: gh api "repos/$GITHUB_REPOSITORY/pulls/${{ github.event.pull_request.number }}/files" --jq '.[].filename'
        env:
          GH_TOKEN: ${{ github.token }}
```

A MicroVM runner is an Amazon Linux 2023 container on ARM64 with the actions runner, `git`, `gh`, `jq`, `tar`, `unzip`, and Python 3. JavaScript actions run on the Node.js that the actions runner bundles, and a step that needs `node` or `npm` itself installs it with `actions/setup-node`. The image holds the newest Node.js LTS release in the runner's tool cache, so a `setup-node` step that asks for that release's major (such as `26`) uses it without a download; other versions download as usual. The image also holds the newest Bun release at `~/.bun/bin/bun`, where `oven-sh/setup-bun` 2.1.0 and later use it without a download when the job asks for that version (for example through `bun-version-file: package.json`). Older setup-bun releases always restore Bun from GitHub's cache, a download that sometimes stalls for up to a minute on a MicroVM, so pin setup-bun 2.1.0 or later. Each MicroVM has `MicrovmMemoryMiB` of memory (2 GiB by default) with 1 vCPU per 2 GiB, and Lambda lets it burst to 4 times that while the job needs it. It has no Docker, no AWS credentials, and no cache bucket, so jobs that build images, call AWS, or use `runs-on/cache` belong on `ec2` runners. A job cannot ask for both labels, and a `microvm` job cannot set EC2 labels such as `cpu=`; the webhook alerts on either.

How it works:

- **Image.** The janitor builds the image `<stack>-runner` on its first run after a deploy, which takes about three minutes, and rebuilds it when the actions runner, gh, Node.js LTS, or Bun release, the image source in `src/microvm-image.ts`, or `MicrovmMemoryMiB` changes, and when the image is 30 days old, which keeps it ahead of Lambda's base image deprecations. Lambda builds it from a zip that the janitor writes to a bucket that runners cannot write to. The janitor deletes image versions once no MicroVM can still be running on them.
- **Launch.** The reconciler registers a just-in-time runner and calls `RunMicrovm`, passing the gzipped JIT config to the image's `/run` hook, which starts the runner. RunMicrovm limits that payload to 4,096 characters, and an encoded JIT config is about 4,100, hence the gzip. The MicroVM accepts no inbound connections and has no idle policy, since Lambda measures idleness by inbound traffic, which a runner never gets. When the runner exits after its job, the container exits and Lambda terminates the MicroVM. Lambda also terminates it after `MaxMinutes`.
- **Pool.** MicroVMs have no tags, so after the launch the reconciler adds a `microvm-id=<id>` label to the runner's GitHub registration, and the reconciler and janitor read that label to find an idle runner's MicroVM. The MicroVM runners join the pool described above: a spare one is retired, an idle one is terminated after `IdleMinutes`, and a registration whose MicroVM ended is removed.
- **Fallback to EC2.** When a MicroVM does not launch, because the account's MicroVM memory quota is full, the image is still building, or the service fails, the reconciler launches an EC2 runner for the job instead, of the default size and image and with the job's labels, so it can take the `microvm` job. The reconciler's log records each one as `MicroVM launch failed, launching an EC2 runner instead`.

The account quota **Max allocated ARM_64 MicroVM memory** caps how many MicroVM runners run at once: the quota divided by `MicrovmMemoryMiB`. The quota **Rate of RunMicrovm API requests** caps launches per second; the reconciler's MicroVM client backs off and retries when Lambda throttles it.

## Docker builds

Local NVMe disks and the BuildKit layer cache make image builds fast. Neither requires changes to Dockerfiles.

### Local NVMe disks

When the instance type has instance-store SSDs, the boot script formats them (striped with RAID 0 when there are several), and mounts them over `/var/lib/docker`, `/var/lib/containerd`, the job work directory (`/home/runner/work`), and `TMPDIR`. `nvme=true` makes the reconciler choose only such instance types. Instance-store disks are much faster than the gp3 root volume and are erased when the instance terminates. Images preloaded in the AMI under `/var/lib/docker` are hidden by the mount, which matters only for jobs that relied on them.

### BuildKit layer cache in S3

The `docker-cache` action in this repository (`actions/docker-cache`) gives a build its `cache-from` and `cache-to` values, so a workflow caches image layers without knowing the bucket, region, or key layout. On these runners the cache lives in the stack's S3 bucket under `buildkit/<owner>/<repo>/`. On any other runner both outputs are empty, and the build runs without a cache.

The default `docker` build driver cannot export cache, so the build needs a `docker-container` builder, which `docker/setup-buildx-action` creates. Buildx reads the instance-profile credentials on the host and passes them to BuildKit, so no AWS keys are needed.

```yaml
jobs:
  image:
    runs-on: [ec2, cpu=8, nvme=true]
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v4
      - id: cache
        uses: Fountain-Bio/ec2-runners/actions/docker-cache@<commit SHA>
        with:
          name: app
      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: your-registry/app:${{ github.sha }}
          cache-from: ${{ steps.cache.outputs.cache-from }}
          cache-to: ${{ steps.cache.outputs.cache-to }}
```

A bake build sets the same outputs per target through `docker/bake-action`'s `set` input, for example `app.cache-from=${{ steps.cache.outputs.cache-from }}`. A build for a pull request should use `cache-from` alone, so it reads the main branch's cache and cannot replace it.

The action takes two inputs:

- `name` (required) is the cache entry name. Use a different `name` for each image built from the same repository, or the images overwrite each other's cache.
- `mode` is `max` by default, which caches the layers of every build stage and lets multi-stage builds skip unchanged stages. `min` caches only the final image's layers, which uploads less when an intermediate stage is large and cheap to rebuild.

BuildKit refreshes the timestamps of layers it reuses once a day, so the bucket's 10-day expiry removes only layers that no build has used recently. A cache upload failure does not fail the build.

Other repositories in the org can use the action only while this repository's **Settings → Actions → General → Access** allows repositories in the example-org organization.

## Setup

Requirements: AWS CLI v2 with admin credentials for the target account, [Bun](https://bun.com) as the package manager, Node.js 24, and owner access to the GitHub org.

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

Push a workflow with `runs-on: [ec2]`. In the GitHub App's Advanced tab, recent deliveries should show `202` for `queued` events and `200` for most other events. Logs are in CloudWatch under `/aws/lambda/<stack>-webhook`, `-reconciler`, and `-janitor`. Each runner's boot log, which includes the runner's own output, is at `/var/log/ec2-runner-boot.log` on the instance (reachable through Session Manager while it is alive) and is copied to the `/ec2-runners/<stack>/boot` log group, in a stream named after the runner, when the boot script exits or the instance is terminated. The boot script prefixes each of its steps with a UTC timestamp, and its first line records the kernel's uptime, so the log shows how long the OS boot, the instance store setup, the runner download, and Docker startup each took.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `GitHubOrg` | `example-org` | Org the app is installed on. Webhooks from other orgs are ignored. |
| `TriggerLabel` | `ec2` | Label that opts a job in to an EC2 runner. |
| `MicrovmLabel` | `microvm` | Label that opts a job in to a MicroVM runner. See [MicroVM runners](#microvm-runners). |
| `MicrovmMemoryMiB` | `2048` | Baseline memory of each MicroVM runner: 512, 1024, 2048, 4096, or 8192. Lambda gives 1 vCPU per 2048 MiB. Changing it rebuilds the image. |
| `RunnerGroupId` | `1` | Org runner group for registrations. |
| `IdleMinutes` | `20` | Kill an instance that has not started a job after this long. A backstop for runners the reconciler did not retire, such as one whose runner process failed to connect. |
| `MaxMinutes` | `360` | Hard runner lifetime, enforced by the boot script and the janitor for instances and by Lambda for MicroVMs (at most 480). |
| `AmiOwner`, `AmiNamePrefix` | RunsOn public images | Where `image=` names are looked up. |
| `RunnerVersion` | `latest` | actions/runner version to download when the AMI does not have one at `/opt/ec2-runner`, and to build into the MicroVM image. The boot script checks the download against the SHA-256 digest GitHub publishes for the release asset, so the version must be 2.325.0 or later. |
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

The code is TypeScript. The toolchain is [Vite+](https://viteplus.dev), configured in `vite.config.ts`, with Bun installing packages. GitHub calls and webhook payload types come from Octokit, whose retry and throttling plugins retry server errors and pace requests as GitHub recommends (at most 10 at once, and a second between writes), and Zod parses the environment, the app secret, and the rows read from the jobs table. The Lambdas run on the Node.js 24 runtime, so `deploy.sh` bundles `src/index.ts` and its dependencies, including the AWS SDK clients, into `.build/lambda` with `vp pack`. The bundle is `index.mjs` plus a few chunk files, and all three functions use the whole directory as their code.

```bash
bun install
bun run check            # vp check: Oxfmt formatting, then Oxlint with type checking (Node types only)
bun run fmt              # vp fmt: formats the code in place
bun run test             # vp test: Vitest; plain `bun test` runs Bun's runner instead
bun run test:integration # jobs table against DynamoDB Local; needs Docker
bun run build            # vp pack: writes .build/lambda; deploy.sh runs this
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
