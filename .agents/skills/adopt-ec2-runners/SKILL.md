---
name: adopt-ec2-runners
description: Moves a repository's GitHub Actions jobs onto ec2-runners by choosing ec2 or microvm labels and sizes for each job. Use when migrating workflows from GitHub-hosted or other self-hosted runners to ec2-runners, or sizing a job's runs-on labels.
---

# Adopt ec2-runners in a repository

Run this in the repository whose workflows should move. The organization must already have the stack deployed and the GitHub App installed on this repository. `docs/usage.md` in the ec2-runners repository is the reference for every label and for the cache and Docker settings.

## 1. Inventory

For every job in `.github/workflows/*.yml`, record its workflow, job ID, current `runs-on`, and what it does: Docker builds, AWS calls, caches, services, and the architecture of any binaries it downloads. Read recent durations with `gh run list --workflow <file> --limit 10 --json databaseId,conclusion` and `gh run view <id> --json jobs --jq '.jobs[] | {name, startedAt, completedAt}'`.

Confirm the repository is private (`gh repo view --json isPrivate`). The stack ignores public repositories by default, so stop and tell the person if it is public.

**Done when** every job in every workflow has a row with those facts.

## 2. Classify each job

Give each job one of these classes, with a one-line reason:

- **microvm**: runs in about 2 minutes or less, and needs no Docker, no AWS credentials, no `runs-on/cache`, and nothing x86-only (a MicroVM is ARM64 Amazon Linux). Path filters, status gates, labelers, and review bots usually fit. `runs-on: microvm`.
- **ec2**: everything else on Linux. Size it with `cpu=` and, when memory matters, `ram=`. A job on `ubuntu-latest` in a private repository had 2 vCPUs, so `cpu=2` keeps its speed and `cpu=4` or `cpu=8` buys parallelism for builds and test suites. Add `nvme=true` for Docker builds and jobs heavy on disk. Add `spot=false` for jobs that must not be interrupted, such as deploys and releases.
- **stay**: macOS, Windows, GPU, jobs in public repositories, and jobs that use GitHub-hosted features the stack lacks. Keep their current `runs-on`.

**Done when** every job has a class and a reason, and the person has reviewed the table.

## 3. Edit the workflows

- Set each job's `runs-on` to its new labels, for example `[ec2, cpu=4]` or `microvm`.
- In `ec2` jobs, `actions/cache` keeps working. Swap it for `runs-on/cache` with the same inputs to store caches in the stack's S3 bucket, which is faster from EC2; on other runners `runs-on/cache` falls back to GitHub's cache.
- For Docker builds on `ec2`, add `docker/setup-buildx-action` and the stack's `docker-cache` action as shown in `docs/usage.md`, Docker builds, pinned to a full commit SHA.
- In `microvm` jobs that need Node.js or Bun, keep `actions/setup-node` and use `oven-sh/setup-bun` 2.1.0 or later.

**Done when** every job classed `ec2` or `microvm` has its new `runs-on`, and `git diff` shows no other change to jobs classed `stay`.

## 4. Verify

Push the changes on a branch and open a pull request, or push to a branch whose workflows trigger on push. Watch the run with `gh run watch`.

**Done when** every moved job succeeded on its new runner, and you have compared each job's duration with the inventory. Report jobs that got slower, with the likely cause: too few `cpu=`, a cache that has not warmed yet, or a MicroVM job that fell back to EC2. If a job stays queued for more than 5 minutes, the stack's `debug-ec2-runners` skill finds out why.
