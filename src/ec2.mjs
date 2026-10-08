import {
  CreateFleetCommand,
  CreateLaunchTemplateVersionCommand,
  DeleteLaunchTemplateVersionsCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { instanceRequirements } from "./labels.mjs";

export const TAG_STACK = "ec2-runners:stack";
export const TAG_RUNNER = "ec2-runners:runner-name";

const amiCache = new Map();
const AMI_CACHE_MS = 60 * 60_000;

// "image=ami-0123..." is used as-is. Any other value is an image name looked up
// as <prefix><image>-* under the configured owner, newest first.
export async function resolveAmi(ec2, image, { owner, namePrefix }) {
  const cached = amiCache.get(image);
  if (cached && Date.now() - cached.at < AMI_CACHE_MS) return cached.ami;

  const params = image.startsWith("ami-")
    ? { ImageIds: [image] }
    : {
        Owners: [owner],
        Filters: [
          { Name: "name", Values: [`${namePrefix}${image}-*`] },
          { Name: "state", Values: ["available"] },
        ],
      };
  const { Images = [] } = await ec2.send(new DescribeImagesCommand(params));
  if (Images.length === 0) throw new Error(`No AMI found for image=${image}`);
  Images.sort((a, b) => (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""));
  const image0 = Images[0];
  const rootDeviceName = image0.RootDeviceName ?? "/dev/sda1";
  const rootMapping = (image0.BlockDeviceMappings ?? []).find((m) => m.DeviceName === rootDeviceName);
  const ami = { imageId: image0.ImageId, rootDeviceName, snapshotSizeGiB: rootMapping?.Ebs?.VolumeSize ?? 0 };
  amiCache.set(image, { ami, at: Date.now() });
  return ami;
}

// One subnet per request. EC2 Fleet rejects a request whose overrides repeat
// the same InstanceRequirements, and an instant fleet override takes a single
// subnet, so subnets are tried one call at a time.
function fleetRequest({ launchTemplateId, version, subnetId, spec, spot }) {
  return {
    Type: "instant",
    TargetCapacitySpecification: {
      TotalTargetCapacity: 1,
      DefaultTargetCapacityType: spot ? "spot" : "on-demand",
    },
    ...(spot
      ? { SpotOptions: { AllocationStrategy: "price-capacity-optimized" } }
      : { OnDemandOptions: { AllocationStrategy: "lowest-price" } }),
    LaunchTemplateConfigs: [
      {
        LaunchTemplateSpecification: { LaunchTemplateId: launchTemplateId, Version: String(version) },
        Overrides: [{ SubnetId: subnetId, InstanceRequirements: instanceRequirements(spec) }],
      },
    ],
  };
}

// Launches one instance for one job. Each launch gets its own launch template
// version, because EC2 Fleet cannot override user data and the user data
// carries the job's JIT runner config. The version is deleted after launch.
// Spreads launches across availability zones. Exported for tests.
export function shuffled(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function launchRunner(ec2, opts) {
  const { launchTemplateId, sourceVersion, subnetIds, spec, ami, userData, tags, log = console.log, random } = opts;
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value: String(Value) }));

  const { LaunchTemplateVersion } = await ec2.send(
    new CreateLaunchTemplateVersionCommand({
      LaunchTemplateId: launchTemplateId,
      SourceVersion: String(sourceVersion),
      VersionDescription: tags[TAG_RUNNER],
      LaunchTemplateData: {
        ImageId: ami.imageId,
        UserData: userData,
        BlockDeviceMappings: [
          {
            DeviceName: ami.rootDeviceName,
            Ebs: { VolumeSize: Math.max(spec.disk, ami.snapshotSizeGiB ?? 0), VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
          },
        ],
        TagSpecifications: [
          { ResourceType: "instance", Tags: tagList },
          { ResourceType: "volume", Tags: tagList },
        ],
      },
    }),
  );
  const version = LaunchTemplateVersion.VersionNumber;

  try {
    const errors = [];
    // Spot in every subnet first, then on-demand in every subnet.
    for (const spot of spec.spot ? [true, false] : [false]) {
      for (const subnetId of shuffled(subnetIds, random)) {
        const res = await ec2.send(
          new CreateFleetCommand(fleetRequest({ launchTemplateId, version, subnetId, spec, spot })),
        );
        const instance = res.Instances?.find((i) => i.InstanceIds?.length);
        if (instance) {
          return {
            instanceId: instance.InstanceIds[0],
            instanceType: instance.InstanceType,
            lifecycle: instance.Lifecycle ?? (spot ? "spot" : "on-demand"),
            subnetId,
          };
        }
        const summary = (res.Errors ?? []).map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`).join("; ");
        errors.push(`${spot ? "spot" : "on-demand"} ${subnetId}: ${summary || "no instance returned"}`);
        log(JSON.stringify({ msg: "fleet attempt failed", spot, subnetId, errors: res.Errors }));
      }
    }
    throw new Error(`Could not launch an instance. ${errors.join(" | ")}`);
  } finally {
    await ec2
      .send(new DeleteLaunchTemplateVersionsCommand({ LaunchTemplateId: launchTemplateId, Versions: [String(version)] }))
      .catch((err) => log(JSON.stringify({ msg: "failed to delete launch template version", version, error: err.message })));
  }
}

export async function listRunnerInstances(ec2, stackName, states = ["pending", "running"]) {
  const instances = [];
  let NextToken;
  do {
    const res = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: `tag:${TAG_STACK}`, Values: [stackName] },
          { Name: "instance-state-name", Values: states },
        ],
        NextToken,
      }),
    );
    for (const r of res.Reservations ?? []) {
      for (const i of r.Instances ?? []) {
        const tags = Object.fromEntries((i.Tags ?? []).map((t) => [t.Key, t.Value]));
        instances.push({
          instanceId: i.InstanceId,
          state: i.State?.Name,
          launchTime: new Date(i.LaunchTime),
          runnerName: tags[TAG_RUNNER],
        });
      }
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return instances;
}

export async function terminateInstances(ec2, instanceIds) {
  if (instanceIds.length === 0) return;
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: instanceIds }));
}
