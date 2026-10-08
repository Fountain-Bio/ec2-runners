# ec2-runners

Ephemeral GitHub Actions runners on EC2 Spot for the example-org org, deployed as one CloudFormation stack. Each job that asks for an EC2 runner gets a fresh instance sized from its labels. The instance runs that one job and terminates itself.

## How it works

1. GitHub sends a `workflow_job` webhook to a Lambda function URL (`<stack>-webhook`). The function checks the HMAC signature, keeps only `queued` jobs whose labels include `ec2`, and invokes the launcher asynchronously.
2. The launcher (`<stack>-launcher`) registers a just-in-time runner named `<stack>-<job id>` with the job's labels, finds the newest matching AMI, and calls EC2 Fleet (`instant`) with attribute-based instance selection, one subnet per call in shuffled order. It tries Spot with `price-capacity-optimized` in each subnet first, then On-Demand.
3. The instance boot script runs `run.sh --jitconfig`, executes the job, and powers off. The launch template sets shutdown behavior to `terminate`, so power-off deletes the instance.
4. The janitor (`<stack>-janitor`, every 5 minutes) terminates instances that have not started a job within `IdleMinutes` or have run longer than `MaxMinutes`, and removes runner registrations whose instance has ended.

The runner name includes the job ID, so a redelivered webhook gets a 409 from GitHub and launches nothing.

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

Every job also gets these variables, usable in shells and as `${{ env.NAME }}` in workflow expressions: `EC2_RUNNER_CACHE_BUCKET`, `EC2_RUNNER_REGION`, and `EC2_RUNNER_NVME` (`true` when the instance store is in use).

The `full` images are ports of GitHub's hosted runner images, so actions that work on `ubuntu-latest` generally work here. `runs-on/cache` reads the bucket name from `RUNS_ON_S3_BUCKET_CACHE`, which the boot script sets for every job, and authenticates with the instance profile. On GitHub-hosted runners the variable is absent and `runs-on/cache` falls back to GitHub's cache.

## Docker builds

Local NVMe disks and the BuildKit layer cache make image builds fast. Neither requires changes to Dockerfiles.

### Local NVMe disks

When the instance type has instance-store SSDs, the boot script formats them (striped with RAID 0 when there are several), and mounts them over `/var/lib/docker`, `/var/lib/containerd`, the job work directory, and `TMPDIR`. `nvme=true` makes the launcher choose only such instance types. Instance-store disks are much faster than the gp3 root volume and are erased when the instance terminates. Images preloaded in the AMI under `/var/lib/docker` are hidden by the mount, which matters only for jobs that relied on them.

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

Requirements: AWS CLI v2 with admin credentials for the target account, and owner access to the GitHub org.

### 1. Deploy the stack

```bash
AWS_REGION=us-west-2 ./deploy.sh
```

The script creates an artifact bucket for the Lambda zip on first run, then packages and deploys. The `runs-on-v2.2-*` AMIs are published in us-east-1, us-east-2, us-west-2, eu-west-1, eu-west-2, eu-west-3, eu-central-1, ap-south-1, ap-northeast-1, ap-southeast-1, and ap-southeast-2. The stack prints `WebhookUrl`, `GitHubAppSecretArn`, and `CacheBucket`.

### 2. Create the GitHub App

In the example-org org settings, open Developer settings, then GitHub Apps, then New GitHub App:

- Webhook URL: the `WebhookUrl` output.
- Webhook secret: a random string, for example from `openssl rand -hex 32`. Keep it for step 3.
- Repository permissions: Actions: Read-only, Metadata: Read-only.
- Organization permissions: Self-hosted runners: Read and write.
- Subscribe to events: Workflow job.
- Where can this app be installed: Only on this account.

After creating the app, note the App ID, generate a private key (a `.pem` file downloads), and install the app on the org for all repositories or the ones that should use EC2 runners.

### 3. Store the credentials

```bash
aws secretsmanager put-secret-value \
  --secret-id "<GitHubAppSecretArn>" \
  --secret-string "$(jq -n \
      --arg appId "<App ID>" \
      --rawfile privateKey path/to/app.private-key.pem \
      --arg webhookSecret "<webhook secret>" \
      '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
```

### 4. Check the runner group

The launcher registers runners in the org's Default runner group (ID 1). If any public repository will use these runners, enable "Allow public repositories" on that group in org settings under Actions, Runner groups. Running untrusted pull-request code from forks on these runners gives that code the instance's cache-bucket access.

### 5. Test

Push a workflow with `runs-on: [ec2]`. In the GitHub App's Advanced tab, recent deliveries should show `202` for `queued` events. Logs are in CloudWatch under `/aws/lambda/<stack>-webhook`, `-launcher`, and `-janitor`. The boot log on an instance is `/var/log/ec2-runner-boot.log`, reachable through Session Manager while the instance is alive.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `GitHubOrg` | `example-org` | Org the app is installed on. Webhooks from other orgs are ignored. |
| `TriggerLabel` | `ec2` | Label that opts a job in. |
| `RunnerGroupId` | `1` | Org runner group for registrations. |
| `IdleMinutes` | `20` | Kill an instance that has not started a job after this long. Covers cancelled jobs and jobs that another runner took. |
| `MaxMinutes` | `360` | Hard instance lifetime, enforced both by the boot script and the janitor. |
| `AmiOwner`, `AmiNamePrefix` | RunsOn public images | Where `image=` names are looked up. |
| `RunnerVersion` | `latest` | actions/runner version to download when the AMI does not have one at `/opt/ec2-runner`. |
| `CacheRetentionDays` | `10` | Lifecycle expiry on the cache bucket. |
| `VpcCidr` | `10.42.0.0/16` | VPC range, split into three /20 subnets. |

Pass overrides as `./deploy.sh Key=Value …`.

## Known limits

- A Spot interruption fails the job. GitHub does not retry it automatically. Mark interruption-sensitive jobs `spot=false`.
- A job that waits in the queue longer than `IdleMinutes` (for example behind a concurrency group) loses its instance and stays queued. Raise `IdleMinutes` if that happens.
- The boot script downloads the actions runner from GitHub on each boot, which adds a few seconds. Baking it into a custom AMI at `/opt/ec2-runner` skips the download.
- The default AMIs are built and published by RunsOn. To use your own, build an AMI and set `AmiOwner` and `AmiNamePrefix`, or pass `image=ami-…`.
- Linux only. Windows and GPU images would need GPU instance requirements and a PowerShell boot script.

## Development

```bash
npm install          # AWS SDK, for tests only; the Lambda runtime provides it
npm test
npm run lint:template   # needs cfn-lint
```

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

Step 4 removes everything else: the VPC, Lambdas, launch template, IAM roles, log groups, and the GitHub App secret. Secrets Manager may keep the deleted secret in a recovery window before removing it, during which it is not billed.
