#!/usr/bin/env bash
# Packages the Lambda code and deploys the stack.
#
#   ./deploy.sh                      # stack "ec2-runners" in the current AWS region
#   STACK=ci-runners ./deploy.sh GitHubOrg=example-org IdleMinutes=15
#
# Extra arguments are passed as parameter overrides.
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK:-ec2-runners}"
REGION="${AWS_REGION:-$(aws configure get region)}"
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

mkdir -p .build
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
