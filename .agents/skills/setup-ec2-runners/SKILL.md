---
name: setup-ec2-runners
description: Deploys the ec2-runners stack to an AWS account and connects it to a GitHub organization, ending with a test workflow that runs on the new runners. Use when installing ec2-runners, deploying it to a new account, region, or organization, or replacing the stack's GitHub App.
---

# Set up ec2-runners

Work from the root of this repository. `docs/setup.md` is the reference for every step; this skill adds the checks that prove each step worked. Ask the person before any step that spends money or changes their GitHub organization, and say which account and organization it touches.

Throughout, `$STACK`, `$REGION`, and `$ORG` are the stack name, AWS region, and GitHub organization from step 1, and every AWS command runs with the person's chosen `AWS_PROFILE`.

## 1. Inputs

Collect:

- GitHub organization (`$ORG`).
- AWS credentials: the `AWS_PROFILE` to use, or the environment's current credentials.
- Region (`$REGION`), default `us-west-2`. Stack name (`$STACK`), default `ec2-runners`.
- An email address for alerts, or none.

Run `aws sts get-caller-identity` and `gh api user --jq .login`. Check that `gh api user/memberships/orgs/$ORG --jq .role` prints `admin`, which step 4 and the runner group check need. The runner group API also needs the `admin:org` scope: when `gh auth status` does not list it, ask the person to run `gh auth refresh -h github.com -s admin:org`, which opens a browser. Check `node --version` is 24 or later and `bun --version` succeeds.

**Done when** every input has a value, the tools run, and the person has confirmed the AWS account ID and the organization by name.

## 2. Preflight

Run each check and record its result:

- **Existing stack.** `aws cloudformation describe-stacks --region $REGION --stack-name $STACK`. If the stack exists, this run is an update: keep its parameters, and step 4 applies only when the person wants a new GitHub App.
- **Availability zones.** `aws ec2 describe-availability-zones --region $REGION --query 'length(AvailabilityZones[?State==`available`])'` must be at least 3.
- **Runner images.** `aws ec2 describe-images --region $REGION --owners 135269210855 --filters 'Name=name,Values=runs-on-v2.2-ubuntu24-full-x64-*' --query 'length(Images)'` must be above 0. At 0, the region has no RunsOn images, and the person needs their own AMIs (`AmiOwner`, `AmiNamePrefix`) or another region.
- **Quotas.** List the vCPU quotas:
  ```bash
  aws service-quotas list-service-quotas --region $REGION --service-code ec2 \
    --query "Quotas[?contains(QuotaName, 'Standard (A, C, D, H, I, M, R, T, Z)')].[QuotaName,Value]" --output table
  ```
  Compare the Spot quota with the peak vCPUs the person's CI runs at once (the sum of `cpu=` across parallel jobs). A quota below that peak makes launches fail; tell the person, and point them to the quota list in `docs/setup.md`.
- **Runner group.** `gh api orgs/$ORG/actions/runner-groups/1 --jq .allows_public_repositories` must print `false`, or the reconciler launches nothing. If it prints `true`, ask the person whether to turn the setting off (the safe default) or deploy with `AllowPublicRepos=true` (see `SECURITY.md` for the cache risk).

**Done when** each check has a recorded result, and each failing check is fixed or the person has accepted it.

## 3. Deploy

```bash
AWS_REGION=$REGION STACK=$STACK ./deploy.sh GitHubOrg=$ORG AlertEmail=<email>
```

Leave out `AlertEmail` when the person gave none, and leave out `GitHubOrg` on an update unless it changes. Pass any other parameters the person asked for (`docs/setup.md`, Parameters). A first deploy takes several minutes.

**Done when** `aws cloudformation describe-stacks --region $REGION --stack-name $STACK --query 'Stacks[0].StackStatus'` prints `CREATE_COMPLETE` or `UPDATE_COMPLETE`, and the outputs include `WebhookUrl` and `GitHubAppSecretArn`.

## 4. GitHub App

Run the app script in the background and keep its output:

```bash
AWS_REGION=$REGION node scripts/create-github-app.ts --org $ORG --stack $STACK
```

It serves a page on `127.0.0.1` and opens it in the browser. The person must click **Create GitHub App** on GitHub while signed in as an organization owner, then install the app on the organization for the repositories that should use the runners. If the browser is on a different machine from the script, the `127.0.0.1` address cannot reach it; follow the manual steps in `docs/setup.md`, steps 2 and 3, instead. Pass `--no-open` when this machine has no browser and print the address for the person.

If the script says the secret already holds credentials, the stack already has an app: stop and ask whether to keep it or replace it with `--force`.

**Done when** the script printed `Created GitHub App` and exited 0, and the installation exists:

```bash
gh api orgs/$ORG/installations --jq '.installations[] | select(.app_slug == "<slug from the script>") | .repository_selection'
```

## 5. Alerts

If `AlertEmail` was set, ask the person to confirm the subscription from the email SNS sent. For Slack or Microsoft Teams, follow `docs/setup.md`, step 5, with the person's existing Amazon Q Developer channel configuration.

**Done when** `aws sns list-subscriptions-by-topic --region $REGION --topic-arn <AlertTopicArn>` shows no `PendingConfirmation` subscription, or the person chose to skip alerts.

## 6. Test

Ask the person for a private repository where the app is installed, and get their approval to push a test branch to it. Push a branch named `ec2-runners-smoke-test` with this workflow at `.github/workflows/ec2-runners-smoke-test.yml`:

```yaml
name: ec2-runners smoke test
on:
  push:
    branches: [ec2-runners-smoke-test]
jobs:
  ec2:
    runs-on: [ec2, cpu=2]
    steps:
      - run: echo "ran on $(hostname) with $(nproc) vCPUs"
  microvm:
    runs-on: microvm
    steps:
      - run: echo "ran on $(uname -m)"
```

Watch it with `gh run watch --repo <owner>/<repo> <run id>`. The EC2 job should start within about a minute. The MicroVM image builds on the janitor's first run after the deploy, which takes up to about 8 minutes, and until then the `microvm` job runs on an EC2 runner, which still counts as a pass.

If a job is still queued after 5 minutes, follow the `debug-ec2-runners` skill, then return here.

**Done when** both jobs succeeded. Then delete the test branch (`git push origin --delete ec2-runners-smoke-test`) and tell the person the stack's outputs, where alerts go, and that `docs/usage.md` lists the labels workflows can use.
