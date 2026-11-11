// Parses GitHub Actions job labels into a launch spec.
//
// A job opts in by including the trigger label (default "ec2"), or the MicroVM
// label (default "microvm") for a Lambda MicroVM runner (see jobKind). An EC2
// job's settings are key=value labels, given either as separate array entries
// or joined with "/" in a single label:
//
//   runs-on: [ec2, cpu=4, image=ubuntu24-full-x64]
//   runs-on: "ec2/cpu=4/image=ubuntu24-full-x64"

import type { InstanceRequirementsRequest } from "@aws-sdk/client-ec2";

// What one job asked for, after defaults are applied.
export interface LaunchSpec {
  cpu: number;
  // Minimum memory in GiB.
  ram: number;
  // A RunsOn image name such as "ubuntu24-full-x64", or an AMI ID.
  image: string;
  // Root volume size in GiB.
  disk: number;
  spot: boolean;
  nvme: boolean;
  // Instance families ("c7i") or full instance types ("c7i.2xlarge"). Empty allows any.
  families: string[];
  // The slowest CPU allowed, as an instance family whose CPU performance is the
  // floor ("m6i"). Set from the stack's CpuBaselineFamily, not from labels.
  cpuBaselineFamily?: string;
}

// A job's labels ask for something that can never launch, such as cpu=abc or
// an image with no AMI. Retrying such a job cannot succeed.
export class JobConfigError extends Error {
  override name = "JobConfigError";
}

const DEFAULTS = Object.freeze({
  cpu: 2,
  image: "ubuntu24-full-x64",
  disk: 40,
  spot: true,
  nvme: false,
});

const FALSE_VALUES = ["false", "0", "no", "off"];

const INT_KEYS = ["cpu", "ram", "disk"] as const;
type IntKey = (typeof INT_KEYS)[number];
const isIntKey = (key: string): key is IntKey => (INT_KEYS as readonly string[]).includes(key);

function labelParts(labels: readonly string[]): string[] {
  return labels
    .flatMap((l) => l.split("/"))
    .map((p) => p.trim())
    .filter(Boolean);
}

// Whether a job opted in. GitHub matches labels case-insensitively.
export function hasTriggerLabel(labels: readonly string[], triggerLabel = "ec2"): boolean {
  return labelParts(labels).some((p) => p.toLowerCase() === triggerLabel.toLowerCase());
}

// The two kinds of runner the stack launches. An "ec2" job (trigger label,
// default "ec2") gets an EC2 instance sized from its labels. A "microvm" job
// (MicroVM label, default "microvm") gets a Lambda MicroVM of the image's
// fixed size, or an EC2 instance of the default size when no MicroVM launches.
export type RunnerKind = "ec2" | "microvm";

export interface KindLabels {
  ec2Label: string;
  microvmLabel: string;
}

// Whether a job asked for one of the stack's runners.
export function isStackJob(labels: readonly string[], { ec2Label, microvmLabel }: KindLabels): boolean {
  return hasTriggerLabel(labels, ec2Label) || hasTriggerLabel(labels, microvmLabel);
}

// The settings that size or place an EC2 instance. A MicroVM's size is fixed
// by the image, so a MicroVM job that sets one is a mistake worth reporting.
const EC2_ONLY_KEYS = ["cpu", "ram", "disk", "family", "image", "spot", "nvme"];

// Which kind of runner a stack job asked for. Throws JobConfigError for labels
// that can never launch: both kinds at once (no runner has both labels), a
// MicroVM job with EC2 settings, or an EC2 job whose settings parseLabels
// rejects.
export function jobKind(labels: readonly string[], { ec2Label, microvmLabel }: KindLabels): RunnerKind {
  const microvm = hasTriggerLabel(labels, microvmLabel);
  if (microvm && hasTriggerLabel(labels, ec2Label)) {
    throw new JobConfigError(`A job can ask for ${ec2Label} or ${microvmLabel}, not both: no runner has both labels`);
  }
  if (!microvm) {
    parseLabels(labels);
    return "ec2";
  }
  const ec2Setting = labelParts(labels).find((p) => EC2_ONLY_KEYS.includes(p.split("=")[0]!.toLowerCase()) && p.includes("="));
  if (ec2Setting) {
    throw new JobConfigError(`Label ${ec2Setting} applies only to ${ec2Label} jobs. A ${microvmLabel} runner has the MicroVM image's fixed size.`);
  }
  return "microvm";
}

// Reads the settings from an opted-in job's labels. Callers check
// hasTriggerLabel first. Throws JobConfigError for a label value that cannot
// be satisfied.
export function parseLabels(labels: readonly string[]): LaunchSpec {
  const parts = labelParts(labels);

  const spec: Omit<LaunchSpec, "ram"> & { ram?: number } = { ...DEFAULTS, families: [] };
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = part.slice(eq + 1);
    if (isIntKey(key)) {
      // Accepts whole digits only, so values such as "4.5" and "100GB" are errors.
      const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(n) || n <= 0) throw new JobConfigError(`Label ${part}: expected a positive integer`);
      spec[key] = n;
    } else if (key === "family") {
      spec.families = value
        .split("+")
        .map((f) => f.trim())
        .filter(Boolean);
    } else if (key === "image") {
      spec.image = value;
    } else if (key === "spot") {
      spec.spot = !FALSE_VALUES.includes(value.toLowerCase());
    } else if (key === "nvme") {
      spec.nvme = !FALSE_VALUES.includes(value.toLowerCase());
    }
    // Unknown keys (for example run=<id>) are kept on the runner as labels but ignored here.
  }
  if (spec.cpu > 192) throw new JobConfigError(`cpu=${spec.cpu} exceeds the 192 vCPU limit`);
  if (spec.disk > 2000) throw new JobConfigError(`disk=${spec.disk} exceeds the 2000 GiB limit`);
  return { ...spec, ram: spec.ram ?? spec.cpu * 2 };
}

// EC2 attribute-based instance selection for the spec. The AMI decides the
// architecture, so the requirements only describe size and family.
export function instanceRequirements(spec: LaunchSpec): InstanceRequirementsRequest {
  const req: InstanceRequirementsRequest = {
    VCpuCount: { Min: spec.cpu, Max: spec.cpu },
    MemoryMiB: { Min: spec.ram * 1024 },
    InstanceGenerations: ["current"],
    BurstablePerformance: "excluded",
    BareMetal: "excluded",
    AcceleratorCount: { Max: 0 },
  };
  if (spec.nvme) {
    // Instance types with local NVMe SSDs (the "d" families, such as c7id or m7gd).
    req.LocalStorage = "required";
    req.LocalStorageTypes = ["ssd"];
  }
  if (spec.families.length > 0) {
    req.AllowedInstanceTypes = spec.families.map((f) => (f.includes(".") ? f : `${f}.*`));
  }
  if (spec.cpuBaselineFamily) {
    // Excludes instance types whose CPUs are slower than this family's, which
    // "current generation" alone still allows (i3 or m5d, for example).
    req.BaselinePerformanceFactors = { Cpu: { References: [{ InstanceFamily: spec.cpuBaselineFamily }] } };
  }
  return req;
}
