import {
  DependencyManifestEntryKind as Kind, DependencyTreeAllocationBasis as Basis,
  type DependencyTreeAllocationCategory, type DependencyTreeMeasurement,
} from "./dependency-tree-manifest";

export enum DependencyTreeMeasurementParseStatus { Valid = "valid", Invalid = "invalid" }
export type DependencyTreeMeasurementParseResult =
  | { readonly status: DependencyTreeMeasurementParseStatus.Valid; readonly measurement: DependencyTreeMeasurement }
  | { readonly status: DependencyTreeMeasurementParseStatus.Invalid };

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: RecordValue, fields: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
// Representation bound shared with N6 report facts, not an allocation or time policy.
function decimal(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^(?:0|[1-9][0-9]*)$/.test(value);
}
function category(value: unknown): DependencyTreeAllocationCategory | null {
  if (!record(value) || !exact(value, ["inodeCount", "allocatedBytesEstimate"])) return null;
  const { inodeCount, allocatedBytesEstimate } = value;
  if (!decimal(inodeCount) || !decimal(allocatedBytesEstimate)) return null;
  const bytes = BigInt(allocatedBytesEstimate);
  if (bytes % 512n !== 0n || (inodeCount === "0" && bytes !== 0n)) return null;
  return Object.freeze({ inodeCount, allocatedBytesEstimate });
}

// Structural validation is not measurement provenance, Ready admission or
// reclaim authority. Protected receipt publication supplies the external binding.
// Never include rejected payloads in diagnostics.
export function parseDependencyTreeMeasurement(value: unknown): DependencyTreeMeasurementParseResult {
  const invalid = { status: DependencyTreeMeasurementParseStatus.Invalid } as const;
  if (!record(value) || !exact(value, ["allocationBasis", "allocatedBytesEstimate", "allocationByKind", "observedScanDurationMs"]) ||
      value.allocationBasis !== Basis.RetainedInodeBlocks512 || !decimal(value.allocatedBytesEstimate) ||
      !decimal(value.observedScanDurationMs) || !record(value.allocationByKind) ||
      !exact(value.allocationByKind, [Kind.Directory, Kind.File, Kind.Symlink])) return invalid;
  const directory = category(value.allocationByKind[Kind.Directory]);
  const file = category(value.allocationByKind[Kind.File]);
  const symlink = category(value.allocationByKind[Kind.Symlink]);
  if (!directory || !file || !symlink || BigInt(directory.inodeCount) < 1n) return invalid;
  const total = BigInt(value.allocatedBytesEstimate);
  if (total % 512n !== 0n || total !== BigInt(directory.allocatedBytesEstimate) +
      BigInt(file.allocatedBytesEstimate) + BigInt(symlink.allocatedBytesEstimate)) return invalid;
  return { status: DependencyTreeMeasurementParseStatus.Valid, measurement: Object.freeze({
    allocationBasis: Basis.RetainedInodeBlocks512,
    allocatedBytesEstimate: value.allocatedBytesEstimate,
    allocationByKind: Object.freeze({ [Kind.Directory]: directory, [Kind.File]: file, [Kind.Symlink]: symlink }),
    observedScanDurationMs: value.observedScanDurationMs,
  }) };
}
