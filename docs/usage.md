# Using the runners in workflows

This page is for people writing GitHub Actions workflows in an organization where the stack is deployed. It covers the `runs-on` labels, what a job's environment contains, the shared cache, MicroVM runners, and Docker builds.

## EC2 runners

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

A label combination that can never launch, such as `cpu=3` or an image name that matches no AMI, sends an alert, and the job stays queued until it is cancelled or reaches GitHub's 24-hour queue limit.

### Job environment

Jobs run in `/home/runner/work/<repo>/<repo>` with `HOME` at `/home/runner`, the layout of GitHub-hosted runners. `actions/cache` stores paths outside the workspace, such as `~/.bun`, relative to the workspace, so this layout lets a cache saved on GitHub-hosted runners restore to the right place here.

Every job also gets these variables, usable in shells and as `${{ env.NAME }}` in workflow expressions: `EC2_RUNNER_CACHE_BUCKET`, `EC2_RUNNER_REGION`, and `EC2_RUNNER_NVME` (`true` when the instance store is in use).

The `full` images are ports of GitHub's hosted runner images, so actions that work on `ubuntu-latest` generally work here.

### The cache bucket

`runs-on/cache` reads the bucket name from `RUNS_ON_S3_BUCKET_CACHE`, which the boot script sets for every job, and authenticates with the instance profile. On GitHub-hosted runners the variable is absent and `runs-on/cache` falls back to GitHub's cache.

The cache bucket is shared by every repository and branch that uses these runners, and every job can read and write all of it. A job in one repository can therefore replace a cache entry that a build in another repository restores. Treat cached content as trusted only as far as everyone who can push a branch in the organization is trusted. Objects expire after `CacheRetentionDays` (10 by default).

### AWS access from a job

The instance profile grants access to the cache bucket and the boot log group only. A job that deploys to AWS or calls other AWS APIs should get its own credentials, for example through GitHub's OIDC provider and `aws-actions/configure-aws-credentials`, as it would on a GitHub-hosted runner.

## MicroVM runners

A job labelled `microvm` runs in an AWS Lambda MicroVM. From a job being queued to the job starting takes about 10 seconds, against about 30 to 45 for an EC2 runner, so short jobs such as path filters, status gates, and review bots spend more of their time working.

```yaml
jobs:
  changes:
    runs-on: microvm
    steps:
      - run: gh api "repos/$GITHUB_REPOSITORY/pulls/${{ github.event.pull_request.number }}/files" --jq '.[].filename'
        env:
          GH_TOKEN: ${{ github.token }}
```

A MicroVM runner is an Amazon Linux 2023 container on ARM64 with the actions runner, `git`, `gh`, `jq`, `tar`, `unzip`, and Python 3.

- JavaScript actions run on the Node.js that the actions runner bundles. A step that needs `node` or `npm` itself installs it with `actions/setup-node`. The image holds the newest Node.js LTS release in the runner's tool cache, so a `setup-node` step that asks for that release's major uses it without a download; other versions download as usual.
- The image holds the newest Bun release at `~/.bun/bin/bun`, where `oven-sh/setup-bun` 2.1.0 and later use it without a download when the job asks for that version (for example through `bun-version-file: package.json`). Older setup-bun releases always restore Bun from GitHub's cache, a download that sometimes stalls for up to a minute on a MicroVM, so pin setup-bun 2.1.0 or later.
- Each MicroVM has `MicrovmMemoryMiB` of memory (2 GiB by default) with 1 vCPU per 2 GiB, and Lambda lets it burst to 4 times that while the job needs it.
- A MicroVM has no Docker, no AWS credentials, and no cache bucket. Jobs that build images, call AWS, or use `runs-on/cache` belong on `ec2` runners.

A job cannot ask for both `ec2` and `microvm`, and a `microvm` job cannot set EC2 labels such as `cpu=`; the webhook sends an alert for either. When a MicroVM cannot launch, the job gets a default-size EC2 runner instead, so a `microvm` job still runs while the MicroVM quota is full or the image is building.

## Docker builds

Local NVMe disks and the BuildKit layer cache make image builds fast. Neither requires changes to Dockerfiles.

### Local NVMe disks

When the instance type has instance-store SSDs, the boot script formats them (striped with RAID 0 when there are several), and mounts them over `/var/lib/docker`, `/var/lib/containerd`, the job work directory (`/home/runner/work`), and `TMPDIR`. `nvme=true` makes the reconciler choose only such instance types. Instance-store disks are much faster than the gp3 root volume and are erased when the instance terminates. Images preloaded in the AMI under `/var/lib/docker` are hidden by the mount, which matters only for jobs that relied on them.

### BuildKit layer cache in S3

The `docker-cache` action in this repository (`actions/docker-cache`) gives a build its `cache-from` and `cache-to` values, so a workflow caches image layers without knowing the bucket, region, or key layout. On the stack's runners the cache lives in the stack's S3 bucket under `buildkit/<owner>/<repo>/`. On any other runner both outputs are empty, and the build runs without a cache.

The default `docker` build driver cannot export cache, so the build needs a `docker-container` builder, which `docker/setup-buildx-action` creates. Buildx reads the instance-profile credentials on the host and passes them to BuildKit, so no AWS keys are needed.

```yaml
jobs:
  image:
    runs-on: [ec2, cpu=8, nvme=true]
    steps:
      - uses: actions/checkout@v6
      - uses: docker/setup-buildx-action@v4
      - id: cache
        uses: <owner>/ec2-runners/actions/docker-cache@<commit SHA>
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

`<owner>/ec2-runners` is any copy of this repository that the workflow's repository can read: this public repository, or your organization's fork. A private fork's actions are usable from other repositories only while the fork's **Settings → Actions → General → Access** allows repositories in the organization. Pin the action to a full commit SHA, as GitHub recommends for third-party actions.

A bake build sets the same outputs per target through `docker/bake-action`'s `set` input, for example `app.cache-from=${{ steps.cache.outputs.cache-from }}`. A build for a pull request should use `cache-from` alone, so it reads the main branch's cache and cannot replace it.

The action takes two inputs:

- `name` (required) is the cache entry name. Use a different `name` for each image built from the same repository, or the images overwrite each other's cache.
- `mode` is `max` by default, which caches the layers of every build stage and lets multi-stage builds skip unchanged stages. `min` caches only the final image's layers, which uploads less when an intermediate stage is large and cheap to rebuild.

BuildKit refreshes the timestamps of layers it reuses once a day, so the bucket's expiry removes only layers that no build has used recently. A cache upload failure does not fail the build.
