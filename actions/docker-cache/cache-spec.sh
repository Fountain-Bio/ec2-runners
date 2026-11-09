#!/usr/bin/env bash
# Writes the docker-cache action's cache-from and cache-to outputs.
#
# Reads CACHE_NAME and CACHE_MODE from the action's inputs, and
# EC2_RUNNER_CACHE_BUCKET and EC2_RUNNER_REGION, which the runner's job-started
# hook (src/userdata.ts) adds to every job's environment. GITHUB_REPOSITORY
# and GITHUB_OUTPUT come from the Actions runner.
set -euo pipefail

# The name ends up inside a comma-separated BuildKit cache spec, so a comma or
# an equals sign in it would change the spec's other fields.
if [[ ! "$CACHE_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::docker-cache: name '$CACHE_NAME' may contain only letters, digits, dots, dashes and underscores."
  exit 1
fi
if [[ "$CACHE_MODE" != min && "$CACHE_MODE" != max ]]; then
  echo "::error::docker-cache: mode must be min or max, got '$CACHE_MODE'."
  exit 1
fi

if [[ -z "${EC2_RUNNER_CACHE_BUCKET:-}" ]]; then
  echo "This runner has no layer cache, so the build runs without one."
  {
    echo "cache-from="
    echo "cache-to="
  } >> "$GITHUB_OUTPUT"
  exit 0
fi

# Buildx passes the instance profile's credentials to BuildKit, so the spec
# carries no keys. Entries live under the repository's own prefix; the
# bucket's lifecycle rule expires layers that no build has used for 10 days.
spec="type=s3,region=$EC2_RUNNER_REGION,bucket=$EC2_RUNNER_CACHE_BUCKET,prefix=buildkit/$GITHUB_REPOSITORY/,name=$CACHE_NAME"
{
  echo "cache-from=$spec"
  # ignore-error keeps a failed cache upload from failing a build that
  # otherwise succeeded.
  echo "cache-to=$spec,mode=$CACHE_MODE,ignore-error=true"
} >> "$GITHUB_OUTPUT"
