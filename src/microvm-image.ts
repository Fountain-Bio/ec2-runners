// The stack's Lambda MicroVM image, which MicroVM runners start from.
//
// Lambda builds a MicroVM image from a zip in S3 that holds a Dockerfile: it
// runs the Dockerfile, starts the container, calls the image's /ready and
// /validate hooks, and snapshots memory and disk. Each build of the same image
// is a new image version, and RunMicrovm starts the latest active one.
//
// The janitor keeps the image current (ensureMicrovmImage). It builds the
// image when it is missing, and rebuilds it when the actions/runner, gh, or
// Node.js LTS release, the image source, or the memory size changes, and when the active version is
// 30 days old, which picks up new Lambda base image versions before Lambda
// expires the old ones. A build takes about three minutes. Until the first
// build finishes, MicroVM launches fail and the reconciler launches EC2
// runners for those jobs instead.

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  ListMicrovmImageVersionsCommand,
  ResourceNotFoundException,
  UpdateMicrovmImageCommand,
  type CreateMicrovmImageRequest,
  type GetMicrovmImageVersionOutput,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ReleaseDownload } from "./github.ts";
import { errorMessage, log } from "./log.ts";
import type { Microvms } from "./microvm.ts";

// The port the hook server listens on for Lambda's lifecycle hooks.
const HOOK_PORT = 9000;
// A version this old is rebuilt. Lambda deprecates a base image version for
// 60 days, then lets it run for 30 more, so monthly rebuilds stay well ahead.
const REBUILD_AFTER_MS = 30 * 24 * 60 * 60_000;
// A build that failed is retried after this long, unless its inputs change.
const RETRY_FAILED_AFTER_MS = 6 * 60 * 60_000;
// The janitor's schedule. A failed build is alerted once, by the janitor run
// that first sees it.
const JANITOR_PERIOD_MS = 5 * 60_000;

// The container the image runs. Lambda supplies Amazon Linux 2023 and the
// MicroVM service components (the base image); this Dockerfile adds the
// runner. It is built for ARM64, the MicroVM default.
//
// The base container ships openssl-snapsafe-libs, an OpenSSL build that stays
// safe when many MicroVMs start from one memory snapshot, and it conflicts
// with the stock openssl-libs, so the runner's dependency list leaves OpenSSL
// out. oven-sh/setup-bun extracts Bun with unzip, and the Node.js builds that
// actions/setup-node installs link against libatomic. gh comes from its release
// tarball, checked like the runner's: Amazon Linux 2023's crypto policy
// rejects the signatures on GitHub's gh packages.
function dockerfile(runner: ReleaseDownload, ghCli: ReleaseDownload, node: ReleaseDownload): string {
  return `FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y --setopt=install_weak_deps=0 \\
      tar gzip unzip git jq libicu krb5-libs zlib lttng-ust \\
      shadow-utils sudo findutils which procps-ng python3 libatomic \\
    && dnf clean all

RUN curl -fsSL -o /tmp/gh.tgz ${ghCli.url} \\
    && echo "${ghCli.sha256}  /tmp/gh.tgz" | sha256sum -c - \\
    && mkdir /tmp/gh && tar -xzf /tmp/gh.tgz -C /tmp/gh --strip-components=1 \\
    && install -m 0755 /tmp/gh/bin/gh /usr/local/bin/gh \\
    && rm -rf /tmp/gh /tmp/gh.tgz

# The runner refuses to run as root. Its home and work directory match the
# EC2 runners and GitHub-hosted runners (/home/runner/work).
RUN useradd --create-home --home-dir /home/runner runner \\
    && mkdir -p /home/runner/actions-runner /home/runner/work \\
    && curl -fsSL -o /tmp/runner.tgz ${runner.url} \\
    && echo "${runner.sha256}  /tmp/runner.tgz" | sha256sum -c - \\
    && tar -xzf /tmp/runner.tgz -C /home/runner/actions-runner \\
    && rm /tmp/runner.tgz \\
    && chown -R runner:runner /home/runner

# Node.js in the runner's tool cache (see node-release.ts), laid out the way
# actions/setup-node looks for it: node/<version>/arm64 under the tool cache,
# which is _tool in the runner's work directory, beside an arm64.complete marker.
RUN mkdir -p /home/runner/work/_tool/node/${node.version}/arm64 \\
    && curl -fsSL -o /tmp/node.tgz ${node.url} \\
    && echo "${node.sha256}  /tmp/node.tgz" | sha256sum -c - \\
    && tar -xzf /tmp/node.tgz -C /home/runner/work/_tool/node/${node.version}/arm64 --strip-components=1 \\
    && touch /home/runner/work/_tool/node/${node.version}/arm64.complete \\
    && rm /tmp/node.tgz \\
    && chown -R runner:runner /home/runner/work

COPY hooks.py /opt/microvm-runner/hooks.py
CMD ["python3", "-u", "/opt/microvm-runner/hooks.py"]
`;
}

// The container's main process: a server for Lambda's lifecycle hooks, which
// Lambda POSTs to /aws/lambda-microvms/runtime/v1/<hook> on HOOK_PORT.
//   ready, validate  Image build. Runs the runner binary, the Node.js builds
//                    the runner runs JavaScript actions on, git, and the cached
//                    Node.js and npm the way actions/setup-node does, once each,
//                    so the snapshot holds their files in the page cache. A
//                    MicroVM reads files outside the page cache from its
//                    snapshot disk on first use: starting actions/checkout took
//                    5 seconds, and setup-node's version checks 5 more.
//   run              Each MicroVM. The body is {"microvmId", "runHookPayload"},
//                    and the payload is the gzipped JIT config (see
//                    runHookPayload in microvm.ts). Starts the runner in the
//                    background and answers at once, inside the hook timeout.
// When the runner exits after its job, the server exits, and Lambda
// terminates the MicroVM. Each log line starts with a Unix timestamp.
const HOOKS_PY = `import base64
import glob
import gzip
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNNER_DIR = "/home/runner/actions-runner"
PREFIX = "/aws/lambda-microvms/runtime/v1/"


def log(msg, **fields):
    print(f"{time.time():.3f} {msg} {json.dumps(fields) if fields else ''}", flush=True)


def warm():
    out = subprocess.run(
        ["sudo", "-u", "runner", f"{RUNNER_DIR}/bin/Runner.Listener", "--version"],
        capture_output=True, text=True, timeout=120,
    )
    log("warmed runner", rc=out.returncode, version=out.stdout.strip())
    commands = [[node, "-e", "0"] for node in glob.glob(f"{RUNNER_DIR}/externals/node*/bin/node")]
    commands.append(["git", "--version"])
    for bin_dir in glob.glob("/home/runner/work/_tool/node/*/arm64/bin"):
        commands += [["env", f"PATH={bin_dir}:/usr/bin:/bin", tool, "--version"] for tool in ("node", "npm")]
    for command in commands:
        out = subprocess.run(["sudo", "-u", "runner", *command], capture_output=True, text=True, timeout=120)
        log("warmed", command=" ".join(command), rc=out.returncode)


def run_job(microvm_id, payload):
    jit = base64.b64encode(gzip.decompress(base64.b64decode(payload))).decode()
    log("starting runner", microvmId=microvm_id)
    # sudo resets the environment, so the config goes on the command line.
    proc = subprocess.Popen(
        ["sudo", "-u", "runner", "-H", f"{RUNNER_DIR}/run.sh", "--jitconfig", jit],
        cwd=RUNNER_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    for line in proc.stdout:
        log("runner: " + line.rstrip())
    log("runner exited", rc=proc.wait())
    os._exit(0)


class Hooks(BaseHTTPRequestHandler):
    def do_POST(self):
        hook = self.path.removeprefix(PREFIX)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        log("hook", hook=hook)
        if hook in ("ready", "validate"):
            warm()
        elif hook == "run":
            req = json.loads(body or b"{}")
            threading.Thread(target=run_job, args=(req.get("microvmId", ""), req.get("runHookPayload", "")), daemon=True).start()
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    log("hook server listening")
    ThreadingHTTPServer(("0.0.0.0", ${HOOK_PORT}), Hooks).serve_forever()
`;

// The image's source files for a runner, gh, and Node.js release, and a
// fingerprint of them together with the memory size, which names the build inputs.
export function imageSource(releases: ImageReleases, memoryMiB: number): { files: Record<string, string>; fingerprint: string } {
  const files = { Dockerfile: dockerfile(releases.runner, releases.ghCli, releases.node), "hooks.py": HOOKS_PY };
  const hash = createHash("sha256").update(JSON.stringify({ files, memoryMiB }));
  return { files, fingerprint: hash.digest("hex").slice(0, 16) };
}

// A zip archive of the files, stored without compression. Lambda reads the
// image source from a zip, and the files are a few kilobytes.
export function zipFiles(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    // Version 2.0, no flags, stored, a fixed 1980-01-01 timestamp so equal
    // files give equal archives.
    const common = (b: Buffer, at: number) => {
      b.writeUInt16LE(20, at);
      b.writeUInt16LE(0, at + 2);
      b.writeUInt16LE(0, at + 4);
      b.writeUInt16LE(0, at + 6);
      b.writeUInt16LE(0x21, at + 8);
      b.writeUInt32LE(crc, at + 10);
      b.writeUInt32LE(data.length, at + 14);
      b.writeUInt32LE(data.length, at + 18);
      b.writeUInt16LE(nameBytes.length, at + 22);
      b.writeUInt16LE(0, at + 24);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    common(local, 4);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    common(central, 6);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The releases the image holds: the actions runner, the gh CLI, and the
// Node.js release in the tool cache.
export interface ImageReleases {
  runner: ReleaseDownload;
  ghCli: ReleaseDownload;
  node: ReleaseDownload;
}

export interface ImageSettings {
  // CreateMicrovmImage takes the name, and the other image calls take the ARN.
  imageName: string;
  imageArn: string;
  region: string;
  memoryMiB: number;
  buildRoleArn: string;
  sourceBucket: string;
  releases: ImageReleases;
  // Image versions are deleted once no MicroVM can still be running on them,
  // which is the runners' maximum lifetime after a newer version took over.
  maxMinutes: number;
  now?: number;
}

export type ImageStatus = "current" | "building" | "build started" | "build failed";

// The description each version is built with. It names the runner, gh, and
// Node.js releases and the fingerprint of the build inputs, so the janitor can
// tell whether the active version matches what it would build now.
const describeBuild = ({ runner, ghCli, node }: ImageReleases, fingerprint: string) =>
  `runner ${runner.version}, gh ${ghCli.version}, node ${node.version}, source ${fingerprint}`;

// Builds or rebuilds the image when needed (see the top of this file), and
// deletes versions no MicroVM can still use. Returns what it found or did, and
// for a failed build the reason Lambda gave, for the caller to alert on.
export async function ensureMicrovmImage(
  microvms: Microvms,
  s3: Pick<S3Client, "send">,
  settings: ImageSettings,
): Promise<{ status: ImageStatus; failure?: { version: string; reason: string; newlyFailed: boolean } }> {
  const now = settings.now ?? Date.now();
  const { files, fingerprint } = imageSource(settings.releases, settings.memoryMiB);
  const description = describeBuild(settings.releases, fingerprint);

  const image = await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: settings.imageArn })).catch((err) => {
    if (err instanceof ResourceNotFoundException) return undefined;
    throw err;
  });
  if (image && ["CREATING", "UPDATING", "DELETING"].includes(image.state ?? "")) return { status: "building" };

  // The image keeps naming its latest failed version after pruneVersions
  // deletes that version, so a version Lambda no longer has counts as absent.
  const version = async (v: string | undefined) =>
    v && image
      ? microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: image.imageArn, imageVersion: v })).catch((err) => {
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        })
      : undefined;
  const active = await version(image?.latestActiveImageVersion);
  if (active?.description === description && now - (active.createdAt?.getTime() ?? 0) < REBUILD_AFTER_MS) {
    await pruneVersions(microvms, image!.imageArn!, active, settings.maxMinutes, now);
    return { status: "current" };
  }

  // A failed build of these same inputs is retried only after a while, so a
  // broken Dockerfile does not start a build every 5 minutes.
  const failed = await version(image?.latestFailedImageVersion);
  const failedAt = failed?.updatedAt?.getTime() ?? failed?.createdAt?.getTime() ?? 0;
  if (failed?.description === description && failed.imageVersion && now - failedAt < RETRY_FAILED_AFTER_MS) {
    return {
      status: "build failed",
      failure: { version: failed.imageVersion, reason: failed.stateReason ?? "no reason given", newlyFailed: now - failedAt < JANITOR_PERIOD_MS },
    };
  }

  const key = `${settings.imageName}/${fingerprint}.zip`;
  await s3.send(new PutObjectCommand({ Bucket: settings.sourceBucket, Key: key, Body: zipFiles(files), ContentType: "application/zip" }));
  const build: Omit<CreateMicrovmImageRequest, "name"> = {
    baseImageArn: `arn:aws:lambda:${settings.region}:aws:microvm-image:al2023-1`,
    buildRoleArn: settings.buildRoleArn,
    codeArtifact: { uri: `s3://${settings.sourceBucket}/${key}` },
    description,
    cpuConfigurations: [{ architecture: "ARM_64" }],
    resources: [{ minimumMemoryInMiB: settings.memoryMiB }],
    hooks: {
      port: HOOK_PORT,
      microvmHooks: { run: "ENABLED", runTimeoutInSeconds: 10 },
      microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 300, validate: "ENABLED", validateTimeoutInSeconds: 300 },
    },
  };
  if (image?.imageArn) await microvms.send(new UpdateMicrovmImageCommand({ imageIdentifier: image.imageArn, ...build }));
  else await microvms.send(new CreateMicrovmImageCommand({ name: settings.imageName, ...build }));
  log("started MicroVM image build", { image: settings.imageName, description, replacing: active?.description });
  return { status: "build started" };
}

// Deletes versions other than the active one once no MicroVM can be running
// on them. Each version costs snapshot storage, and an image holds at most 50.
async function pruneVersions(microvms: Microvms, imageArn: string, active: GetMicrovmImageVersionOutput, maxMinutes: number, now: number) {
  // A version stops getting new MicroVMs when a newer one becomes active.
  const unusedSince = active.updatedAt?.getTime() ?? active.createdAt?.getTime() ?? now;
  const deletable = now - unusedSince > maxMinutes * 60_000;
  let nextToken: string | undefined;
  do {
    const page = await microvms.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn, nextToken }));
    for (const v of page.items ?? []) {
      if (v.imageVersion === active.imageVersion || !["SUCCESSFUL", "FAILED"].includes(v.state ?? "")) continue;
      // A failed version never ran a MicroVM.
      if (v.state === "SUCCESSFUL" && !deletable) continue;
      await microvms
        .send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: v.imageVersion }))
        .then(() => log("deleted MicroVM image version", { version: v.imageVersion, description: v.description }))
        .catch((err) => log("failed to delete MicroVM image version", { version: v.imageVersion, error: errorMessage(err) }));
    }
    nextToken = page.nextToken;
  } while (nextToken);
}
