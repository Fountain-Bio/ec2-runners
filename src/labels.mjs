// Parses GitHub Actions job labels into a launch spec.
//
// A job opts in by including the trigger label (default "ec2"). Settings are
// key=value labels, given either as separate array entries or joined with "/"
// in a single label:
//
//   runs-on: [ec2, cpu=4, image=ubuntu24-full-x64]
//   runs-on: "ec2/cpu=4/image=ubuntu24-full-x64"

export const DEFAULTS = Object.freeze({
  cpu: 2,
  image: "ubuntu24-full-x64",
  disk: 40,
  spot: true,
  nvme: false,
});

const FALSE_VALUES = ["false", "0", "no", "off"];

const INT_KEYS = new Set(["cpu", "ram", "disk"]);

export function parseLabels(labels, triggerLabel = "ec2") {
  const parts = labels.flatMap((l) => String(l).split("/")).map((p) => p.trim()).filter(Boolean);
  // GitHub matches labels case-insensitively.
  if (!parts.some((p) => p.toLowerCase() === triggerLabel.toLowerCase())) return null;

  const spec = { ...DEFAULTS, families: [], ram: undefined };
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = part.slice(eq + 1);
    if (INT_KEYS.has(key)) {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Label ${part}: expected a positive integer`);
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
  if (spec.ram === undefined) spec.ram = spec.cpu * 2;
  if (spec.cpu > 192) throw new Error(`cpu=${spec.cpu} exceeds the 192 vCPU limit`);
  if (spec.disk > 2000) throw new Error(`disk=${spec.disk} exceeds the 2000 GiB limit`);
  return spec;
}

// EC2 attribute-based instance selection for the spec. The AMI decides the
// architecture, so the requirements only describe size and family.
export function instanceRequirements(spec) {
  const req = {
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
