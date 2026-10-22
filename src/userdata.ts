// Builds the boot script for a runner instance. The instance registers as a
// just-in-time runner, runs exactly one job, and powers off. The launch
// template sets shutdown behavior to "terminate", so powering off deletes it.

export interface UserDataOptions {
  // Base64 JIT runner config from GitHub's generate-jitconfig endpoint.
  jitConfig: string;
  cacheBucket: string;
  region: string;
  // Hard instance lifetime. The script schedules a shutdown after this long.
  maxMinutes: number;
  // actions/runner tarball to install when the AMI has none at /opt/ec2-runner.
  // The script refuses a download whose SHA-256 differs from runner.sha256.
  runner: { url: string; sha256: string };
  // The runner's registration name, used as its boot log's stream name.
  runnerName: string;
  // CloudWatch Logs group that receives the boot log when the script exits.
  bootLogGroup: string;
}

// The directory that holds each job's workspace, <dir>/<repo>/<repo>. The
// reconciler sets it in the JIT config, and the boot script creates it. It
// matches GitHub-hosted runners (and Blacksmith's), because actions/cache
// stores paths outside the workspace relative to the workspace: a cache of
// ~/.bun saved there holds ../../../.bun, which lands in the runner's home
// only when the workspace sits at the same place.
export const RUNNER_WORK_DIR = "/home/runner/work";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Returns the script base64-encoded, as EC2 launch template user data expects.
export function buildUserData({ jitConfig, cacheBucket, region, maxMinutes, runner, runnerName, bootLogGroup }: UserDataOptions): string {
  const script = `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/ec2-runner-boot.log) 2>&1

# Logs a message prefixed with the UTC time in milliseconds. Each step of the
# boot logs one, so the boot log shows how the time from launch to the
# runner listening for its job divides between steps. The kernel's uptime at
# the first line separates the OS boot from EC2 starting the instance.
stage() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) $*"; }
stage "boot script started; kernel up $(cut -d' ' -f1 /proc/uptime)s"

# Hard cap on instance lifetime, in case the job or the runner hangs.
shutdown -h +${Number(maxMinutes)} "ec2-runners max lifetime reached" || true

JIT_CONFIG=${shellQuote(jitConfig)}
CACHE_BUCKET=${shellQuote(cacheBucket)}
REGION=${shellQuote(region)}
RUNNER_URL=${shellQuote(runner.url)}
RUNNER_SHA256=${shellQuote(runner.sha256)}
RUNNER_NAME=${shellQuote(runnerName)}
BOOT_LOG_GROUP=${shellQuote(bootLogGroup)}
RUNNER_DIR=/opt/ec2-runner
WORK_DIR=${shellQuote(RUNNER_WORK_DIR)}
HOOK_DIR=/opt/ec2-runner-hooks

# The boot log is lost when the instance terminates, so it is copied to
# CloudWatch Logs on exit, one stream per runner. CloudWatch takes at most
# 256 KB per event, so the upload keeps the log's last 200 KB. The AWS CLI
# and jq come with the GitHub-style runner images; without them the upload
# is skipped.
upload_boot_log() {
  if ! command -v aws >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    echo "aws or jq not installed; boot log not uploaded"
    return 0
  fi
  tail -c 200000 /var/log/ec2-runner-boot.log \
    | jq -Rs --argjson ts "$(date +%s%3N)" '[{timestamp: $ts, message: .}]' > /tmp/boot-log-events.json
  aws logs create-log-stream --region "$REGION" --log-group-name "$BOOT_LOG_GROUP" --log-stream-name "$RUNNER_NAME" 2>/dev/null || true
  aws logs put-log-events --region "$REGION" --log-group-name "$BOOT_LOG_GROUP" --log-stream-name "$RUNNER_NAME" \
    --log-events file:///tmp/boot-log-events.json >/dev/null
}

finish() {
  # Writes go straight to the log file from here on. On termination SIGTERM
  # also stops the tee process above, and an echo into its closed pipe would
  # kill this script with SIGPIPE before the upload.
  exec >>/var/log/ec2-runner-boot.log 2>&1
  stage "runner exited; powering off"
  upload_boot_log || echo "boot log upload failed"
  shutdown -h now
}
trap finish EXIT
# Termination (by the janitor or at MaxMinutes) stops this script with
# SIGTERM. Exiting on it runs the EXIT trap, so the boot log is uploaded
# while the network is still up.
trap 'exit 143' TERM

# ---- Local NVMe instance storage ----
# On instance types with instance-store SSDs, put Docker, containerd, and the
# job work directory on them. Several disks are striped with RAID 0. Anything
# the AMI preloaded under /var/lib/docker is hidden by the mount.
setup_instance_store() {
  local disks dev
  mapfile -t disks < <(lsblk -dpno NAME,MODEL | awk '/Instance Storage/ {print $1}')
  if [ "\${#disks[@]}" -eq 0 ]; then
    echo "no instance-store disks"
    return 1
  fi
  if [ "\${#disks[@]}" -gt 1 ] && command -v mdadm >/dev/null 2>&1; then
    mdadm --create /dev/md0 --level=0 --raid-devices="\${#disks[@]}" --run "\${disks[@]}" || return 1
    dev=/dev/md0
  else
    dev="\${disks[0]}"
  fi
  stage "using instance store \${dev} (\${#disks[@]} disk(s))"
  # The caller runs this function as an if condition, where set -e does not
  # apply, so every step that matters returns on failure explicitly.
  mkfs.ext4 -F -q -m 0 -E nodiscard "$dev" || return 1
  mkdir -p /mnt/nvme
  mount -o noatime "$dev" /mnt/nvme || return 1
  mountpoint -q /mnt/nvme || return 1
  mkdir -p /mnt/nvme/docker /mnt/nvme/containerd /mnt/nvme/work /mnt/nvme/tmp
  chmod 1777 /mnt/nvme/tmp
  stage "instance store formatted and mounted"

  systemctl stop docker.socket docker.service containerd.service 2>/dev/null || true
  stage "Docker stopped"
  mkdir -p /var/lib/docker /var/lib/containerd
  mount --bind /mnt/nvme/docker /var/lib/docker || return 1
  mount --bind /mnt/nvme/containerd /var/lib/containerd || return 1
  return 0
}
NVME=false
if setup_instance_store; then
  NVME=true
  stage "instance store ready"
else
  stage "instance store not used; Docker and the work directory stay on the root volume"
fi

# Start Docker (it was stopped if the instance store was mounted) without
# waiting for it. Its startup takes several seconds and overlaps the runner
# install below. The script waits for Docker just before it starts the runner.
HAS_DOCKER=false
if command -v docker >/dev/null 2>&1; then
  HAS_DOCKER=true
  stage "starting Docker"
  systemctl start --no-block containerd.service docker.service 2>/dev/null || true
fi

if ! id runner >/dev/null 2>&1; then
  useradd -m -s /bin/bash runner
  echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
  chmod 0440 /etc/sudoers.d/runner
fi
getent group docker >/dev/null && usermod -aG docker runner

# The reconciler picked the tarball for the AMI's architecture. sha256sum -c
# fails on a mismatch, and set -e then powers the instance off.
if [ ! -x "$RUNNER_DIR/run.sh" ]; then
  mkdir -p "$RUNNER_DIR"
  stage "downloading runner"
  curl -fsSL -o /tmp/actions-runner.tar.gz "$RUNNER_URL"
  stage "runner downloaded"
  echo "$RUNNER_SHA256  /tmp/actions-runner.tar.gz" | sha256sum -c -
  stage "runner checksum verified"
  tar -xzf /tmp/actions-runner.tar.gz -C "$RUNNER_DIR"
  rm -f /tmp/actions-runner.tar.gz
  stage "runner extracted"
fi

# The JIT config points the runner's work folder at WORK_DIR.
mkdir -p "$WORK_DIR"
if [ "$NVME" = true ]; then
  # A bind mount keeps the physical and logical paths identical for tools
  # that compare realpath(cwd) with GITHUB_WORKSPACE.
  mount --bind /mnt/nvme/work "$WORK_DIR"
fi
chown runner:runner "$WORK_DIR"

# ---- Job-started hook ----
# Runs as the runner user before each job. Writing to GITHUB_ENV makes the
# values usable as \${{ env.NAME }} in workflow expressions as well as in shells.
mkdir -p "$HOOK_DIR"
cat > "$HOOK_DIR/job-started.sh" <<EOF
#!/bin/bash
{
  echo "EC2_RUNNER_CACHE_BUCKET=$CACHE_BUCKET"
  echo "EC2_RUNNER_REGION=$REGION"
  echo "EC2_RUNNER_NVME=$NVME"
} >> "\\$GITHUB_ENV"
exit 0
EOF
chmod 0755 "$HOOK_DIR/job-started.sh"

# Variables in the runner's .env file are passed to every job step. JIT runners
# skip config.sh, which normally writes PATH here, so copy the image's
# /etc/environment (PATH, ImageOS, tool locations) first.
# runs-on/cache reads RUNS_ON_S3_BUCKET_CACHE and uses the instance profile.
if [ -f /etc/environment ]; then
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /etc/environment | sed 's/"//g' > "$RUNNER_DIR/.env" || true
else
  : > "$RUNNER_DIR/.env"
fi
cat >> "$RUNNER_DIR/.env" <<EOF
LANG=C.UTF-8
AWS_REGION=$REGION
AWS_DEFAULT_REGION=$REGION
RUNS_ON_S3_BUCKET_CACHE=$CACHE_BUCKET
ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOK_DIR/job-started.sh
EOF
if [ "$NVME" = true ]; then
  echo "TMPDIR=/mnt/nvme/tmp" >> "$RUNNER_DIR/.env"
fi
chown -R runner:runner "$RUNNER_DIR"

# Wait up to 30 seconds for the Docker daemon started above, so the job's
# first docker command does not race daemon startup.
if [ "$HAS_DOCKER" = true ]; then
  stage "waiting for Docker"
  DOCKER_READY=false
  for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && DOCKER_READY=true && break; sleep 0.2; done
  stage "Docker ready: $DOCKER_READY"
fi

# A login shell picks up /etc/environment, where the GitHub-style images set PATH.
# The JIT config is base64, so single quotes are safe around it.
stage "starting runner"
sudo -iu runner bash -c "cd '$RUNNER_DIR' && ./run.sh --jitconfig '$JIT_CONFIG'" || echo "run.sh exited with status $?"
`;
  return Buffer.from(script).toString("base64");
}
