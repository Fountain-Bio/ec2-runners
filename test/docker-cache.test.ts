// Runs the docker-cache action's script the way the Actions runner does: with
// the action's inputs and the job's environment in env, and GITHUB_OUTPUT
// pointing at a file the script appends `key=value` lines to.
import { expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "../actions/docker-cache/cache-spec.sh");

function run(env: Record<string, string>) {
  const output = join(mkdtempSync(join(tmpdir(), "docker-cache-")), "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "example-org/monorepo", CACHE_MODE: "max", ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status, stdout: result.stdout, outputs };
}

const onRunner = { EC2_RUNNER_CACHE_BUCKET: "cache-bucket", EC2_RUNNER_REGION: "us-west-2" };

test("on a stack runner, the outputs point at the repository's prefix in the cache bucket", () => {
  const { status, outputs } = run({ ...onRunner, CACHE_NAME: "api" });
  expect(status).toBe(0);
  const spec = "type=s3,region=us-west-2,bucket=cache-bucket,prefix=buildkit/example-org/monorepo/,name=api";
  expect(outputs).toEqual({ "cache-from": spec, "cache-to": `${spec},mode=max,ignore-error=true` });
});

test("mode=min reaches cache-to", () => {
  const { outputs } = run({ ...onRunner, CACHE_NAME: "worker", CACHE_MODE: "min" });
  expect(outputs["cache-to"]).toMatch(/,mode=min,ignore-error=true$/);
});

test("on a runner without the cache variables, both outputs are empty and the step succeeds", () => {
  const { status, outputs } = run({ CACHE_NAME: "app" });
  expect(status).toBe(0);
  expect(outputs).toEqual({ "cache-from": "", "cache-to": "" });
});

test("a name that would change the cache spec's other fields fails the step", () => {
  for (const name of ["app,mode=max", "a=b", "", "app name"]) {
    const { status, stdout, outputs } = run({ ...onRunner, CACHE_NAME: name });
    expect(status).toBe(1);
    expect(stdout).toContain("::error::");
    expect(outputs).toEqual({});
  }
});

test("a mode other than min or max fails the step", () => {
  const { status, outputs } = run({ ...onRunner, CACHE_NAME: "app", CACHE_MODE: "maximum" });
  expect(status).toBe(1);
  expect(outputs).toEqual({});
});
