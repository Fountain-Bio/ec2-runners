import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateVersionsCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  GetInstanceTypesFromInstanceRequirementsCommand,
  TerminateInstancesCommand,
  type CreateFleetRequest,
  type DescribeImagesRequest,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { JobConfigError, instanceRequirements, type LaunchSpec } from "./labels.ts";
import { errorMessage, log } from "./log.ts";

// Tags on every runner instance and its volumes. The stack tag scopes the
// janitor's TerminateInstances permission in template.yaml, and the runner
// name ties an instance to its GitHub registration. The repository and run
// ID are for people reading the EC2 console.
const TAG_STACK = "ec2-runners:stack";
const TAG_RUNNER = "ec2-runners:runner-name";
const TAG_REPO = "ec2-runners:repo";
const TAG_RUN = "ec2-runners:run-id";

// The send() method is all this module needs from EC2Client, so tests can pass
// a plain object in its place.
export type Ec2 = Pick<EC2Client, "send">;

export interface Ami {
  imageId: string;
  architecture: "x86_64" | "arm64";
  rootDeviceName: string;
  // Size of the AMI's root snapshot. The root volume is never smaller than this.
  snapshotSizeGiB: number;
}

const amiCache = new Map<string, { ami: Ami; at: number }>();
const AMI_CACHE_MS = 60 * 60_000;

// "image=ami-0123..." names one AMI, which must belong to the configured owner
// or to this account. Any other value is an image name looked up as
// <prefix><image>-* under the configured owner, newest first.
//
// The owner check matters because a runner registers with its job's labels
// and GitHub gives it any queued job those labels cover, from any repository
// the runner group allows. An AMI from an untrusted account could run a
// modified runner and capture other repositories' jobs and secrets.
export async function resolveAmi(ec2: Ec2, image: string, { owner, namePrefix }: { owner: string; namePrefix: string }): Promise<Ami> {
  const cached = amiCache.get(image);
  if (cached && Date.now() - cached.at < AMI_CACHE_MS) return cached.ami;

  const byId = image.startsWith("ami-");
  const params: DescribeImagesRequest = byId
    ? { ImageIds: [image], Owners: [owner, "self"] }
    : {
        Owners: [owner],
        Filters: [
          { Name: "name", Values: [`${namePrefix}${image}-*`] },
          { Name: "state", Values: ["available"] },
        ],
      };
  // EC2 rejects an unknown or malformed AMI ID in ImageIds outright, where a
  // name filter that matches nothing returns an empty list.
  const { Images = [] } = await ec2.send(new DescribeImagesCommand(params)).catch((err: unknown) => {
    if (err instanceof Error && (err.name === "InvalidAMIID.NotFound" || err.name === "InvalidAMIID.Malformed")) {
      throw new JobConfigError(`image=${image}: ${err.message}`);
    }
    throw err;
  });
  Images.sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""));
  const image0 = Images[0];
  if (!image0?.ImageId) {
    throw new JobConfigError(
      byId ? `image=${image}: no such AMI owned by account ${owner} (the AmiOwner parameter) or by this account` : `No AMI found for image=${image}`,
    );
  }
  const architecture = image0.Architecture;
  if (architecture !== "x86_64" && architecture !== "arm64") {
    throw new JobConfigError(`AMI ${image0.ImageId} for image=${image} has unsupported architecture ${architecture}`);
  }
  const rootDeviceName = image0.RootDeviceName ?? "/dev/sda1";
  const rootMapping = (image0.BlockDeviceMappings ?? []).find((m) => m.DeviceName === rootDeviceName);
  const ami = { imageId: image0.ImageId, architecture, rootDeviceName, snapshotSizeGiB: rootMapping?.Ebs?.VolumeSize ?? 0 };
  amiCache.set(image, { ami, at: Date.now() });
  return ami;
}

// Fails when no instance type in the region matches the spec, for example
// cpu=3, so the job's labels are reported before any launch is attempted.
export async function assertInstanceTypesExist(ec2: Ec2, spec: LaunchSpec, ami: Ami): Promise<void> {
  const { InstanceTypes = [] } = await ec2.send(
    new GetInstanceTypesFromInstanceRequirementsCommand({
      ArchitectureTypes: [ami.architecture],
      VirtualizationTypes: ["hvm"],
      InstanceRequirements: instanceRequirements(spec),
    }),
  );
  if (InstanceTypes.length === 0) {
    const families = spec.families.length > 0 ? ` family=${spec.families.join("+")}` : "";
    const floor = spec.cpuBaselineFamily ? ` at least as fast as ${spec.cpuBaselineFamily}` : "";
    throw new JobConfigError(
      `No ${ami.architecture} instance type has cpu=${spec.cpu} ram>=${spec.ram}${families}${spec.nvme ? " nvme=true" : ""}${floor}`,
    );
  }
}

// One subnet per request. EC2 Fleet rejects a request whose overrides repeat
// the same InstanceRequirements, and an instant fleet override takes a single
// subnet, so subnets are tried one call at a time.
function fleetRequest({
  launchTemplateId,
  version,
  subnetId,
  spec,
  spot,
}: {
  launchTemplateId: string;
  version: number;
  subnetId: string;
  spec: LaunchSpec;
  spot: boolean;
}): CreateFleetRequest {
  return {
    Type: "instant",
    TargetCapacitySpecification: {
      TotalTargetCapacity: 1,
      DefaultTargetCapacityType: spot ? "spot" : "on-demand",
    },
    ...(spot ? { SpotOptions: { AllocationStrategy: "price-capacity-optimized" } } : { OnDemandOptions: { AllocationStrategy: "lowest-price" } }),
    LaunchTemplateConfigs: [
      {
        LaunchTemplateSpecification: { LaunchTemplateId: launchTemplateId, Version: String(version) },
        Overrides: [{ SubnetId: subnetId, InstanceRequirements: instanceRequirements(spec) }],
      },
    ],
  };
}

// Spreads launches across availability zones. Exported for tests.
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface LaunchOptions {
  launchTemplateId: string;
  // The stack's base launch template version that each per-launch version copies.
  sourceVersion: string;
  subnetIds: string[];
  spec: LaunchSpec;
  ami: Ami;
  // Base64 boot script from buildUserData.
  userData: string;
  // The GitHub registration the instance runs, its stack, and the job it was
  // launched for. These become the instance and volume tags.
  runnerName: string;
  stackName: string;
  repo: string;
  runId: number;
  random?: () => number;
}

export interface LaunchResult {
  instanceId: string;
  instanceType: string | undefined;
  lifecycle: string;
  subnetId: string;
}

// Launches one instance for one job. Each launch gets its own launch template
// version, because EC2 Fleet cannot override user data and the user data
// carries the job's JIT runner config. The version is deleted after launch.
export async function launchRunner(ec2: Ec2, opts: LaunchOptions): Promise<LaunchResult> {
  const { launchTemplateId, sourceVersion, subnetIds, spec, ami, userData, runnerName, stackName, repo, runId, random } = opts;
  const tagList = [
    { Key: "Name", Value: runnerName },
    { Key: TAG_STACK, Value: stackName },
    { Key: TAG_RUNNER, Value: runnerName },
    { Key: TAG_REPO, Value: repo },
    { Key: TAG_RUN, Value: String(runId) },
  ];

  const { LaunchTemplateVersion } = await ec2.send(
    new CreateLaunchTemplateVersionCommand({
      LaunchTemplateId: launchTemplateId,
      SourceVersion: sourceVersion,
      // deleteStaleLaunchTemplateVersions recognizes per-launch versions by this.
      VersionDescription: runnerName,
      LaunchTemplateData: {
        ImageId: ami.imageId,
        UserData: userData,
        BlockDeviceMappings: [
          {
            DeviceName: ami.rootDeviceName,
            Ebs: { VolumeSize: Math.max(spec.disk, ami.snapshotSizeGiB), VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
          },
        ],
        TagSpecifications: [
          { ResourceType: "instance", Tags: tagList },
          { ResourceType: "volume", Tags: tagList },
        ],
      },
    }),
  );
  const version = LaunchTemplateVersion?.VersionNumber;
  if (version === undefined) throw new Error("CreateLaunchTemplateVersion returned no version number");

  try {
    const errors: string[] = [];
    // Spot in every subnet first, then on-demand in every subnet.
    for (const spot of spec.spot ? [true, false] : [false]) {
      for (const subnetId of shuffled(subnetIds, random)) {
        const res = await ec2.send(new CreateFleetCommand(fleetRequest({ launchTemplateId, version, subnetId, spec, spot })));
        const instance = res.Instances?.find((i) => i.InstanceIds?.length);
        const instanceId = instance?.InstanceIds?.[0];
        if (instance && instanceId) {
          return {
            instanceId,
            instanceType: instance.InstanceType,
            lifecycle: instance.Lifecycle ?? (spot ? "spot" : "on-demand"),
            subnetId,
          };
        }
        const summary = (res.Errors ?? []).map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`).join("; ");
        errors.push(`${spot ? "spot" : "on-demand"} ${subnetId}: ${summary || "no instance returned"}`);
        log("fleet attempt failed", { spot, subnetId, errors: res.Errors });
      }
    }
    throw new Error(`Could not launch an instance. ${errors.join(" | ")}`);
  } finally {
    await ec2
      .send(new DeleteLaunchTemplateVersionsCommand({ LaunchTemplateId: launchTemplateId, Versions: [String(version)] }))
      .catch((err) => log("failed to delete launch template version", { version, error: errorMessage(err) }));
  }
}

export interface RunnerInstance {
  instanceId: string;
  state: string | undefined;
  launchTime: Date;
  runnerName: string | undefined;
}

// Lists the stack's instances in every state. Ended instances stay listed for
// about an hour after they terminate, which is how the janitor tells a
// registration whose instance ended from one whose launch is in progress.
export async function listRunnerInstances(ec2: Ec2, stackName: string): Promise<RunnerInstance[]> {
  const instances: RunnerInstance[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: `tag:${TAG_STACK}`, Values: [stackName] }],
        NextToken,
      }),
    );
    for (const r of res.Reservations ?? []) {
      for (const i of r.Instances ?? []) {
        const tags = Object.fromEntries((i.Tags ?? []).map((t) => [t.Key, t.Value]));
        if (!i.InstanceId) continue;
        instances.push({
          instanceId: i.InstanceId,
          state: i.State?.Name,
          launchTime: new Date(i.LaunchTime ?? 0),
          runnerName: tags[TAG_RUNNER],
        });
      }
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return instances;
}

export async function terminateInstances(ec2: Ec2, instanceIds: string[]): Promise<void> {
  if (instanceIds.length === 0) return;
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
}

// Deletes per-launch launch template versions older than maxAgeMs. launchRunner
// deletes its version after each launch; versions remain only when the
// reconciler stopped before that cleanup ran. Per-launch versions are recognized by their
// description, which launchRunner sets to the runner name.
export async function deleteStaleLaunchTemplateVersions(
  ec2: Ec2,
  { launchTemplateId, runnerPrefix, maxAgeMs, now = Date.now() }: { launchTemplateId: string; runnerPrefix: string; maxAgeMs: number; now?: number },
): Promise<string[]> {
  const stale: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ec2.send(new DescribeLaunchTemplateVersionsCommand({ LaunchTemplateId: launchTemplateId, NextToken }));
    for (const v of res.LaunchTemplateVersions ?? []) {
      const age = now - (v.CreateTime?.getTime() ?? now);
      if (!v.DefaultVersion && v.VersionDescription?.startsWith(`${runnerPrefix}-`) && age > maxAgeMs) {
        stale.push(String(v.VersionNumber));
      }
    }
    NextToken = res.NextToken;
  } while (NextToken);
  // DeleteLaunchTemplateVersions accepts at most 200 versions per call.
  for (let i = 0; i < stale.length; i += 200) {
    await ec2.send(new DeleteLaunchTemplateVersionsCommand({ LaunchTemplateId: launchTemplateId, Versions: stale.slice(i, i + 200) }));
  }
  return stale;
}
