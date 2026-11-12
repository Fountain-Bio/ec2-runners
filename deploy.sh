#!/usr/bin/env bash
# Bundles the Lambda code and deploys the stack. Needs bun, Node.js 24, and the AWS CLI.
#
#   ./deploy.sh GitHubOrg=my-org     # first deploy: stack "ec2-runners" in us-west-2, or AWS_REGION when set
#   ./deploy.sh                      # later deploys keep the stack's current parameter values
#   STACK=ci-runners ./deploy.sh GitHubOrg=my-org IdleMinutes=15
#
# Extra arguments are passed as parameter overrides. A parameter left out keeps
# its current value on an existing stack, and its template default on a new one.
# GitHubOrg has no default, so the first deploy must set it.
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK:-ec2-runners}"
# us-west-2 has the three availability zones the template uses and the
# RunsOn runner AMIs. Set AWS_REGION to deploy elsewhere.
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ARTIFACTS="${ARTIFACTS_BUCKET:-${STACK}-artifacts-${ACCOUNT}-${REGION}}"

if ! aws s3api head-bucket --bucket "$ARTIFACTS" 2>/dev/null; then
  echo "Creating artifact bucket $ARTIFACTS"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$ARTIFACTS" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$ARTIFACTS" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$ARTIFACTS" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Bundles src/index.ts into .build/lambda (index.mjs and its chunks), which template.yaml uses
# as the code for all three functions.
bun install --frozen-lockfile
bun run build

aws cloudformation package \
  --region "$REGION" \
  --template-file template.yaml \
  --s3-bucket "$ARTIFACTS" \
  --s3-prefix "$STACK" \
  --output-template-file .build/packaged.yaml

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file .build/packaged.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  ${@:+--parameter-overrides "$@"}

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
