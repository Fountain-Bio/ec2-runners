// The Node.js release the MicroVM image puts in the runner's tool cache.
//
// actions/setup-node uses a cached Node.js that matches the requested version
// before it downloads one, and a MicroVM starts with an empty tool cache, so
// every setup-node step would otherwise download Node.js. The image caches the
// newest release of the newest LTS line, which matches a job that asks for
// that line's major (such as "26" in a .node-version). A job that asks for
// another version still gets it from setup-node's download.

import type { ReleaseDownload } from "./github.ts";

const DIST = "https://nodejs.org/dist";

// One entry of nodejs.org's release index. lts is the LTS line's codename,
// or false for a release outside an LTS line.
interface IndexEntry {
  version: string;
  lts: string | false;
}

// Looks up the newest LTS release of Node.js for Linux on ARM64 and its
// SHA-256 checksum, which nodejs.org publishes in each release's SHASUMS256.txt.
export async function nodeDownload(): Promise<ReleaseDownload> {
  const index = (await getOk(`${DIST}/index.json`).then((r) => r.json())) as IndexEntry[];
  // The index lists releases newest first.
  const release = index.find((r) => r.lts !== false && /^v\d+\.\d+\.\d+$/.test(r.version));
  if (!release) throw new Error(`${DIST}/index.json lists no LTS release`);
  const filename = `node-${release.version}-linux-arm64.tar.gz`;
  const sums = await getOk(`${DIST}/${release.version}/SHASUMS256.txt`).then((r) => r.text());
  const sha256 = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`))
    ?.slice(0, 64);
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Node.js ${release.version} SHASUMS256.txt has no checksum for ${filename}`);
  return { version: release.version.slice(1), url: `${DIST}/${release.version}/${filename}`, sha256 };
}

async function getOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res;
}
