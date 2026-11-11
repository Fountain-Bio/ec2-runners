// Runners in AWS Lambda MicroVMs, for jobs labelled with the MicroVM label.
//
// A MicroVM starts from a snapshot of the stack's MicroVM image (built by
// microvm-image.ts) in about two seconds, against about half a minute for an
// EC2 instance, which suits jobs that run for seconds. Its /run hook receives
// the job's JIT runner config and starts the runner. When the runner exits
// after its one job, the hook server exits, and Lambda terminates a MicroVM
// whose container exits.
//
// MicroVMs carry no tags, so the reconciler links a runner's GitHub
// registration to its MicroVM by adding a "microvm-id=<id>" label to the
// registration after the launch. Jobs never ask for that label, so it does not
// change which jobs the runner can take. The reconciler and janitor read the
// label to find the MicroVM of an idle registration, and describe only those
// MicroVMs: ListMicrovms keeps terminated MicroVMs, so listing would grow with
// every job ever run.

import { gzipSync } from "node:zlib";
import {
  GetMicrovmCommand,
  ResourceNotFoundException,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  type LambdaMicrovmsClient,
} from "@aws-sdk/client-lambda-microvms";
import type { RunnerInstance } from "./ec2.ts";
import { errorMessage, log } from "./log.ts";
import type { Registration } from "./pool.ts";

// The send() method is all this module needs, so tests can pass a plain object.
export type Microvms = Pick<LambdaMicrovmsClient, "send">;

// The registration label that names a runner's MicroVM: "microvm-id=<id>".
export const MICROVM_ID_LABEL = "microvm-id";

// The longest lifetime RunMicrovm accepts.
const MAX_DURATION_SECONDS = 8 * 60 * 60;

// MicroVM IDs look like "microvm-a2331dd0-f633-3311-bb9f-1147cd60d40a" and EC2
// instance IDs like "i-0123456789abcdef0", so one list can hold both.
export const isMicrovmId = (id: string): boolean => id.startsWith("microvm-");

// The MicroVM a registration's runner runs in, from its microvm-id label.
export function microvmIdOf(registration: Pick<Registration, "labels">): string | undefined {
  const prefix = `${MICROVM_ID_LABEL}=`;
  return registration.labels.find((l) => l.name.startsWith(prefix))?.name.slice(prefix.length);
}

// RunMicrovm limits runHookPayload to 4,096 characters, and an encoded JIT
// config (base64 of a JSON document holding the runner's RSA key) is about
// 4,100. Gzipped and base64-encoded again it is about 2,900. The image's hook
// server reverses the encoding before it starts the runner.
export function runHookPayload(encodedJitConfig: string): string {
  return gzipSync(Buffer.from(encodedJitConfig, "base64"), { level: 9 }).toString("base64");
}

export interface MicrovmLaunch {
  // The stack's MicroVM image. RunMicrovm uses its latest active version.
  imageArn: string;
  executionRoleArn: string;
  region: string;
  // Base64 JIT runner config from GitHub's generate-jitconfig endpoint.
  encodedJitConfig: string;
  // Lambda terminates the MicroVM after this long, in case the runner hangs.
  maxMinutes: number;
}

// Starts one MicroVM runner and returns its ID. The MicroVM accepts no inbound
// connections (the runner only connects out to GitHub) and reaches the
// internet through Lambda's managed egress. It has no idle policy: Lambda
// measures idleness by inbound traffic, which a runner never receives, so an
// idle policy would suspend the MicroVM in the middle of a job.
export async function launchMicrovm(client: Microvms, launch: MicrovmLaunch): Promise<string> {
  const connector = (name: string) => `arn:aws:lambda:${launch.region}:aws:network-connector:aws-network-connector:${name}`;
  const res = await client.send(
    new RunMicrovmCommand({
      imageIdentifier: launch.imageArn,
      executionRoleArn: launch.executionRoleArn,
      runHookPayload: runHookPayload(launch.encodedJitConfig),
      maximumDurationInSeconds: Math.min(Math.round(launch.maxMinutes * 60), MAX_DURATION_SECONDS),
      ingressNetworkConnectors: [connector("NO_INGRESS")],
      egressNetworkConnectors: [connector("INTERNET_EGRESS")],
    }),
  );
  if (!res.microvmId) throw new Error("RunMicrovm returned no MicroVM ID");
  return res.microvmId;
}

// EC2 instance state names for MicroVM states, so the pool and the janitor
// treat both kinds of runner alike: PENDING and RUNNING count as live, and
// everything else as ended. The stack never suspends a MicroVM.
const STATE_NAMES: Record<string, string> = { PENDING: "pending", RUNNING: "running" };

// Describes the MicroVMs of idle registrations, in the shape of the stack's
// EC2 instances. A busy runner needs no look: it is running a job, and its
// MicroVM's maximum duration bounds how long. A MicroVM Lambda no longer knows
// counts as terminated.
export async function describeMicrovmRunners(client: Microvms, registrations: readonly Registration[]): Promise<RunnerInstance[]> {
  const linked = registrations.flatMap((r) => {
    const microvmId = r.busy ? undefined : microvmIdOf(r);
    return microvmId ? [{ name: r.name, microvmId }] : [];
  });
  return Promise.all(
    linked.map(async ({ name, microvmId }) => {
      try {
        const vm = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
        return {
          instanceId: microvmId,
          state: STATE_NAMES[vm.state ?? ""] ?? "terminated",
          launchTime: vm.startedAt ?? new Date(0),
          runnerName: name,
        };
      } catch (err) {
        if (!(err instanceof ResourceNotFoundException)) throw err;
        return { instanceId: microvmId, state: "terminated", launchTime: new Date(0), runnerName: name };
      }
    }),
  );
}

// Terminates MicroVMs, skipping ones Lambda no longer knows. Each failure is
// logged and the rest still terminate; the first failure is rethrown after.
export async function terminateMicrovms(client: Microvms, microvmIds: readonly string[]): Promise<void> {
  let failure: unknown;
  for (const microvmId of microvmIds) {
    try {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) continue;
      log("failed to terminate MicroVM", { microvmId, error: errorMessage(err) });
      failure ??= err;
    }
  }
  if (failure) throw failure;
}
