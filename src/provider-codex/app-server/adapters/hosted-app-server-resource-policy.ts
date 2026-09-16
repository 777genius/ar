import { readFileSync } from "node:fs";

const aggregateIoLimits = {
  readBandwidth: "120M",
  readIops: "8000",
  writeBandwidth: "60M",
  writeIops: "4000",
} as const;

type HostedIoLimits = {
  readonly readBandwidth: string;
  readonly readIops: string;
  readonly writeBandwidth: string;
  readonly writeIops: string;
};

function unescapeMountPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => {
    switch (code) {
      case "040":
        return " ";
      case "011":
        return "\t";
      case "012":
        return "\n";
      default:
        return "\\";
    }
  });
}

function pathDepth(value: string): number {
  return value === "/" ? 0 : value.split("/").filter(Boolean).length;
}

export function hostedIoLimitPathsFromMountInfo(value: string): string[] {
  const byDevice = new Map<string, string>();
  for (const line of value.split("\n")) {
    const [left, right] = line.split(" - ", 2);
    if (!left || !right) continue;
    const fields = left.split(" ");
    const filesystemFields = right.split(" ");
    const device = fields[2];
    const mountPath = fields[4];
    const mountOptions = fields[5];
    const source = filesystemFields[1];
    if (
      !device ||
      device.startsWith("0:") ||
      !mountPath ||
      !mountOptions?.split(",").includes("rw") ||
      !source?.startsWith("/dev/")
    ) {
      continue;
    }
    const candidate = unescapeMountPath(mountPath);
    const existing = byDevice.get(device);
    if (
      existing === undefined ||
      pathDepth(candidate) < pathDepth(existing) ||
      (pathDepth(candidate) === pathDepth(existing) &&
        candidate.length < existing.length)
    ) {
      byDevice.set(device, candidate);
    }
  }
  const paths = [...byDevice.values()].sort((left, right) => {
    if (left === "/") return -1;
    if (right === "/") return 1;
    return left.localeCompare(right);
  });
  return paths.length > 0 ? paths : ["/"];
}

export function hostedIoLimitPaths(): readonly string[] {
  try {
    return hostedIoLimitPathsFromMountInfo(
      readFileSync("/proc/self/mountinfo", "utf8"),
    );
  } catch {
    return ["/"];
  }
}

function escapedSystemdPath(value: string): string {
  return value.replace(/\\/g, "\\x5c").replace(/ /g, "\\x20");
}

function ioProperties(
  paths: readonly string[],
  limits: HostedIoLimits,
): string[] {
  return paths.flatMap((path) => {
    const escapedPath = escapedSystemdPath(path);
    return [
      `IOReadBandwidthMax=${escapedPath} ${limits.readBandwidth}`,
      `IOReadIOPSMax=${escapedPath} ${limits.readIops}`,
      `IOWriteBandwidthMax=${escapedPath} ${limits.writeBandwidth}`,
      `IOWriteIOPSMax=${escapedPath} ${limits.writeIops}`,
    ];
  });
}

export function hostedAggregateIoDropIn(
  ioPaths: readonly string[],
): string {
  return [
    "[Slice]",
    ...ioProperties(ioPaths, aggregateIoLimits),
    "",
  ].join("\n");
}
