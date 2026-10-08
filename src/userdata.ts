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
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Returns the script base64-encoded, as EC2 launch template user data expects.
export function buildUserData({ jitConfig, cacheBucket, region, maxMinutes, runner }: UserDataOptions): string {
  const script = `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/ec2-runner-boot.log) 2>&1

# Hard cap on instance lifetime, in case the job or the runner hangs.
shutdown -h +${Number(maxMinutes)} "ec2-runners max lifetime reached" || true

JIT_CONFIG=${shellQuote(jitConfig)}
CACHE_BUCKET=${shellQuote(cacheBucket)}
REGION=${shellQuote(region)}
RUNNER_URL=${shellQuote(runner.url)}
RUNNER_SHA256=${shellQuote(runner.sha256)}
RUNNER_DIR=/opt/ec2-runner
HOOK_DIR=/opt/ec2-runner-hooks

finish() { echo "runner exited; powering off"; shutdown -h now; }
trap finish EXIT

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
  echo "using instance store \${dev} (\${#disks[@]} disk(s))"
  # The caller runs this function as an if condition, where set -e does not
  # apply, so every step that matters returns on failure explicitly.
  mkfs.ext4 -F -q -m 0 -E nodiscard "$dev" || return 1
  mkdir -p /mnt/nvme
  mount -o noatime "$dev" /mnt/nvme || return 1
  mountpoint -q /mnt/nvme || return 1
  mkdir -p /mnt/nvme/docker /mnt/nvme/containerd /mnt/nvme/work /mnt/nvme/tmp
  chmod 1777 /mnt/nvme/tmp

  systemctl stop docker.socket docker.service containerd.service 2>/dev/null || true
  mkdir -p /var/lib/docker /var/lib/containerd
  mount --bind /mnt/nvme/docker /var/lib/docker || return 1
  mount --bind /mnt/nvme/containerd /var/lib/containerd || return 1
  return 0
}
NVME=false
if setup_instance_store; then
  NVME=true
else
  echo "instance store not used; Docker and the work directory stay on the root volume"
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
  curl -fsSL -o /tmp/actions-runner.tar.gz "$RUNNER_URL"
  echo "$RUNNER_SHA256  /tmp/actions-runner.tar.gz" | sha256sum -c -
  tar -xzf /tmp/actions-runner.tar.gz -C "$RUNNER_DIR"
  rm -f /tmp/actions-runner.tar.gz
fi

if [ "$NVME" = true ]; then
  # The runner's default work folder is _work inside its directory. A bind
  # mount keeps the physical and logical paths identical for tools that
  # compare realpath(cwd) with GITHUB_WORKSPACE.
  mkdir -p "$RUNNER_DIR/_work"
  mount --bind /mnt/nvme/work "$RUNNER_DIR/_work"
  chown runner:runner /mnt/nvme/work
fi

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

# Start Docker (it was stopped if the instance store was mounted) and wait for
# it, so the job's first docker command does not race daemon startup.
if command -v docker >/dev/null 2>&1; then
  systemctl start containerd.service 2>/dev/null || true
  systemctl start docker.service 2>/dev/null || true
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# A login shell picks up /etc/environment, where the GitHub-style images set PATH.
# The JIT config is base64, so single quotes are safe around it.
sudo -iu runner bash -c "cd '$RUNNER_DIR' && ./run.sh --jitconfig '$JIT_CONFIG'" || echo "run.sh exited with status $?"
`;
  return Buffer.from(script).toString("base64");
}
