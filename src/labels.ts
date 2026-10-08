// Parses GitHub Actions job labels into a launch spec.
//
// A job opts in by including the trigger label (default "ec2"). Settings are
// key=value labels, given either as separate array entries or joined with "/"
// in a single label:
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
  return labels.flatMap((l) => l.split("/")).map((p) => p.trim()).filter(Boolean);
}

// Whether a job opted in. GitHub matches labels case-insensitively.
export function hasTriggerLabel(labels: readonly string[], triggerLabel = "ec2"): boolean {
  return labelParts(labels).some((p) => p.toLowerCase() === triggerLabel.toLowerCase());
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
      spec.families = value.split("+").map((f) => f.trim()).filter(Boolean);
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
  return req;
}
