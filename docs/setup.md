# Setup

Setting up ec2-runners takes one AWS account, one GitHub organization, and about 20 minutes. The steps deploy the stack, create a GitHub App that sends job webhooks to it, store the app's credentials in the stack's secret, and check the organization's runner group.

Agents can follow the `setup-ec2-runners` skill in `.agents/skills/setup-ec2-runners/SKILL.md`, which runs these steps and verifies each one.

## Requirements

- An AWS account with three availability zones in the target region, and credentials for the AWS CLI v2 that can create IAM roles, VPCs, Lambda functions, and the other resources in `template.yaml`.
- [Bun](https://bun.com) and Node.js 24 to build the Lambda bundle.
- [uv](https://docs.astral.sh/uv/) only if you run `bun run lint:template`.
- Owner access to the GitHub organization, to create the GitHub App and change runner group settings.

The stack registers runners at the organization level, so it serves one GitHub organization. Deploy one stack per organization, each with its own `STACK` name.

## 1. Deploy the stack

```bash
./deploy.sh GitHubOrg=my-org AlertEmail=you@example.com
```

`deploy.sh` deploys the stack `ec2-runners` to us-west-2. Set `AWS_REGION` to deploy to another region, `STACK` to use another stack name, and `AWS_PROFILE` to pick credentials. On first run it creates an S3 bucket for the Lambda code (`<stack>-artifacts-<account>-<region>`), then bundles the code, packages the template, and deploys it. Extra `Key=Value` arguments are template parameters; see [Parameters](#parameters).

The stack prints four outputs: `WebhookUrl`, `GitHubAppSecretArn`, `CacheBucket`, and `AlertTopicArn`. With `AlertEmail` set, SNS emails a subscription confirmation that must be accepted before alerts arrive.

The default runner images are the public `runs-on-v2.2-*` AMIs published by [RunsOn](https://runs-on.com) in us-east-1, us-east-2, us-west-2, eu-west-1, eu-west-2, eu-west-3, eu-central-1, ap-south-1, ap-northeast-1, ap-southeast-1, and ap-southeast-2. In another region, build your own AMIs and set `AmiOwner` and `AmiNamePrefix`.

## 2. Create the GitHub App

The quickest way is the script that registers the app from a manifest and stores its credentials, which also does step 3:

```bash
node scripts/create-github-app.ts --org my-org
```

It takes the same `AWS_PROFILE` and `AWS_REGION`, and `--stack` for a stack name other than `ec2-runners`. It opens a page in the browser that sends GitHub the app's webhook URL, permissions, and events; sign in as an organization owner and click **Create GitHub App**. GitHub then hands the app's ID, private key, and webhook secret back to the script, which writes them to the stack's secret and sends the browser on to install the app. Install it on the organization for all repositories or for the ones that should use these runners, then go to step 4. The script refuses to replace a secret that already holds an app's credentials unless you pass `--force`, and `--no-open` prints the page's address for a machine without a browser.

To create the app by hand instead, open the organization's settings, open **Developer settings → GitHub Apps → New GitHub App**, and set:

- **Webhook URL**: the `WebhookUrl` output.
- **Webhook secret**: a random string, for example from `openssl rand -hex 32`. Keep it for step 3.
- **Repository permissions**: Actions: Read-only. Metadata: Read-only.
- **Organization permissions**: Self-hosted runners: Read and write.
- **Subscribe to events**: Workflow job.
- **Where can this GitHub App be installed?**: Only on this account.

After creating the app, note the App ID, generate a private key (a `.pem` file downloads), and install the app on the organization for all repositories or for the ones that should use these runners. The reconciler's scheduled check for missed webhooks reads only the repositories the installation can access.

## 3. Store the app's credentials

Skip this step if `scripts/create-github-app.ts` created the app. The stack creates a Secrets Manager secret for the app holding `REPLACE_ME` placeholders. Put the App ID, private key, and webhook secret in it:

```bash
aws secretsmanager put-secret-value \
  --secret-id "<GitHubAppSecretArn>" \
  --secret-string "$(jq -n \
      --arg appId "<App ID>" \
      --rawfile privateKey path/to/app.private-key.pem \
      --arg webhookSecret "<webhook secret>" \
      '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
```

Delete the downloaded `.pem` file once the secret holds it.

## 4. Check the runner group

The reconciler registers runners in the runner group `RunnerGroupId` (1, the organization's Default group, unless you set another). Jobs from public repositories are ignored by default, because pull requests from forks would run untrusted code with write access to the shared cache bucket.

GitHub gives runners to any job the runner group allows, so the reconciler also reads the group's **Allow public repositories** setting. While the group allows public repositories and `AllowPublicRepos` is false, the reconciler launches nothing and sends an alert. Either turn the group setting off (organization settings, **Actions → Runner groups**), or, to use the runners from public repositories anyway, deploy with `AllowPublicRepos=true` and accept the cache risk.

## 5. Route alerts

The `<stack>-alerts` SNS topic receives every alert. [Operations](operations.md#alerts) lists them. `AlertEmail` subscribes one address. To subscribe more, add SNS subscriptions to the topic.

To send alerts to Slack or Microsoft Teams, use [Amazon Q Developer in chat applications](https://docs.aws.amazon.com/chatbot/latest/adminguide/what-is.html) (formerly AWS Chatbot). Alerts are published in its custom notification format, so they render as formatted messages. Create a channel configuration for the chat channel in that service's console, then add the stack's topic to it:

```bash
TOPIC=$(aws cloudformation describe-stacks --stack-name ec2-runners \
  --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue" --output text)
aws chatbot update-slack-channel-configuration --region us-east-2 \
  --chat-configuration-arn "<channel configuration ARN>" \
  --slack-channel-id "<channel ID>" --sns-topic-arns "$TOPIC" <topics already on the configuration>
```

`--sns-topic-arns` replaces the configuration's topic list, so include any topics already on it (`aws chatbot describe-slack-channel-configurations --region us-east-2` lists them). The Chatbot API runs in us-east-2 whatever region the stack is in. The stack does not create the channel configuration itself, because a chat channel allows one configuration per AWS account, and a stack-owned one would fail to deploy wherever the account already has one.

## 6. Test

Push a workflow with `runs-on: [ec2]` in a private repository the app is installed on. In the GitHub App's **Advanced** tab, recent deliveries should show `202` for `queued` events and `200` for most other events. The job should start within about a minute. [Operations](operations.md#logs) describes the logs to read when it does not.

## Account quotas

New AWS accounts often start with quotas too low for CI. Check these in Service Quotas for the stack's region:

- **All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests** (vCPUs) caps the Spot runners running at once. A CI run's peak is the sum of `cpu=` across its parallel jobs.
- **Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances** (vCPUs) caps `spot=false` runners and the On-Demand fallback when Spot has no capacity.
- **Concurrent executions** for Lambda. The stack's three functions need few, but they share the account's pool with every other function.
- **Max allocated ARM_64 MicroVM memory** caps MicroVM runners at the quota divided by `MicrovmMemoryMiB`. A full quota sends `microvm` jobs to EC2 runners.
- **Rate of RunMicrovm API requests** and its burst rate cap MicroVM launches per second. The reconciler backs off and retries when Lambda throttles it.

Accounts can start with the MicroVM quotas below the AWS defaults, and Service Quotas rejects a request for a value below the default, so raising them takes an AWS support case.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `GitHubOrg` | required | Organization the GitHub App is installed on. Webhooks from other organizations are ignored. |
| `TriggerLabel` | `ec2` | Label that opts a job in to an EC2 runner. |
| `MicrovmLabel` | `microvm` | Label that opts a job in to a MicroVM runner. |
| `MicrovmMemoryMiB` | `2048` | Baseline memory of each MicroVM runner: 512, 1024, 2048, 4096, or 8192. Lambda gives 1 vCPU per 2048 MiB. Changing it rebuilds the image. |
| `RunnerGroupId` | `1` | Organization runner group for registrations. |
| `IdleMinutes` | `20` | Terminate a runner that has not started a job after this long. A backstop for runners the reconciler did not retire, such as one whose runner process failed to connect. |
| `MaxMinutes` | `360` | Hard runner lifetime, enforced by the boot script and the janitor for instances and by Lambda for MicroVMs (at most 480). |
| `AmiOwner`, `AmiNamePrefix` | RunsOn public images | Where `image=` names are looked up. `image=ami-…` labels may name only AMIs owned by `AmiOwner` or by the stack's own account. |
| `RunnerVersion` | `latest` | actions/runner version to download when the AMI does not have one at `/opt/ec2-runner`, and to build into the MicroVM image. The boot script checks the download against the SHA-256 digest GitHub publishes for the release asset, so the version must be 2.325.0 or later. |
| `CpuBaselineFamily` | `m6i` | Slowest CPU a runner may get, as an instance family. Excludes older types such as `i3` and `m5d` that EC2's "current generation" filter still allows and that are often the cheapest Spot types with local SSDs. Empty turns the floor off. A compute-family reference such as `c6i` matches no instance type for jobs with 4 GiB or more per vCPU. |
| `CacheRetentionDays` | `10` | Lifecycle expiry on the cache bucket. |
| `VpcCidr` | `10.42.0.0/16` | VPC range, split into three /20 subnets. |
| `AllowPublicRepos` | `false` | Launch runners for jobs from public repositories. See [step 4](#4-check-the-runner-group). |
| `AlertEmail` | empty | Email address subscribed to the `<stack>-alerts` topic. |

Pass overrides as `./deploy.sh Key=Value …`. On an existing stack, a parameter left out keeps its current value.

## Updating

Pull the new version and run `./deploy.sh` with the same `AWS_REGION`, `STACK`, and credentials. Runners already running keep the code they launched with. The janitor rebuilds the MicroVM image on its next run when the image source changed.

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

# 3. Empty the cache bucket and the MicroVM image source bucket. CloudFormation
#    cannot delete a bucket that still has objects.
for ID in CacheBucket MicrovmSourceBucket; do
  BUCKET=$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" \
    --logical-resource-id "$ID" --query StackResourceDetail.PhysicalResourceId --output text)
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"
done

# 4. Delete the stack and wait for it to finish.
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"

# 5. Delete the MicroVM image the janitor built. It is created through the Lambda
#    API, so the stack does not own it. Needs an AWS CLI with the lambda-microvms
#    commands.
aws lambda-microvms delete-microvm-image --region "$REGION" \
  --image-identifier "arn:aws:lambda:$REGION:$ACCOUNT:microvm-image:$STACK-runner"

# 6. Delete the artifact bucket that deploy.sh created for the Lambda code.
aws s3 rb "s3://$STACK-artifacts-$ACCOUNT-$REGION" --force --region "$REGION"
```

Then remove the `ec2` and `microvm` labels from workflows, or those jobs will wait for a runner that never comes.

Step 4 removes everything else: the VPC, Lambdas, jobs table, launch template, IAM roles, log groups, alarms, alert topic, and the GitHub App secret. MicroVM runners still running end on their own within `MaxMinutes`. A chat channel configuration keeps the deleted topic's ARN in its list until it is removed in the Amazon Q Developer in chat applications console. Secrets Manager may keep the deleted secret in a recovery window before removing it, during which it is not billed.
