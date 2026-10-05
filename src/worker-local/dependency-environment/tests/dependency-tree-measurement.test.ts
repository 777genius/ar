import { describe, expect, it } from "vitest";
import {
  DependencyManifestEntryKind as Kind, DependencyTreeAllocationBasis as Basis,
  type DependencyTreeMeasurement,
} from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import {
  parseDependencyTreeMeasurement, DependencyTreeMeasurementParseStatus as Status,
} from "../../../worker-core/dependency-environment/domain/parse-dependency-tree-measurement";

function measurement() {
  return {
    allocationBasis: Basis.RetainedInodeBlocks512,
    allocatedBytesEstimate: "5632",
    allocationByKind: {
      [Kind.Directory]: { inodeCount: "2", allocatedBytesEstimate: "4096" },
      [Kind.File]: { inodeCount: "3", allocatedBytesEstimate: "1024" },
      [Kind.Symlink]: { inodeCount: "1", allocatedBytesEstimate: "512" },
    },
    observedScanDurationMs: "17",
  } satisfies DependencyTreeMeasurement;
}
function parsed(value: unknown): DependencyTreeMeasurement {
  const result = parseDependencyTreeMeasurement(value);
  expect(result.status).toBe(Status.Valid);
  if (result.status !== Status.Valid) throw new Error("TEST expected structurally valid measurement");
  return result.measurement;
}
function rejected(value: unknown): void {
  expect(parseDependencyTreeMeasurement(value)).toEqual({ status: Status.Invalid });
}

// Regression boundary: malformed or arithmetically inconsistent metadata must
// not enter protected receipts; Number rounding must not hide missing blocks.
// Pure synthetic TEST facts prove shape only, never actual observation or authority.
describe("dependency tree measurement structural validation", () => {
  it("preserves independently specified allocation categories and measured elapsed time", () => {
    expect(parsed(measurement())).toEqual({
      allocationBasis: Basis.RetainedInodeBlocks512, allocatedBytesEstimate: "5632",
      allocationByKind: {
        directory: { inodeCount: "2", allocatedBytesEstimate: "4096" },
        file: { inodeCount: "3", allocatedBytesEstimate: "1024" },
        symlink: { inodeCount: "1", allocatedBytesEstimate: "512" },
      }, observedScanDurationMs: "17",
    });
  });

  it("allows a zero-block target directory, sparse files and inline symlinks, including zero elapsed time", () => {
    const zero = { ...measurement(), allocatedBytesEstimate: "0", observedScanDurationMs: "0",
      allocationByKind: {
        directory: { inodeCount: "1", allocatedBytesEstimate: "0" },
        file: { inodeCount: "2", allocatedBytesEstimate: "0" },
        symlink: { inodeCount: "1", allocatedBytesEstimate: "0" },
      } };
    expect(parsed(zero)).toEqual(zero);
    const empty = { ...zero, allocationByKind: { ...zero.allocationByKind,
      file: { inodeCount: "0", allocatedBytesEstimate: "0" },
      symlink: { inodeCount: "0", allocatedBytesEstimate: "0" },
    } };
    expect(parsed(empty)).toEqual(empty);
  });

  it("keeps exact sums beyond Number precision and rejects a missing 512-byte block", () => {
    const large = { ...measurement(), allocatedBytesEstimate: "9223372036854776320",
      allocationByKind: {
        directory: { inodeCount: "1", allocatedBytesEstimate: "9223372036854775808" },
        file: { inodeCount: "9007199254740993", allocatedBytesEstimate: "512" },
        symlink: { inodeCount: "0", allocatedBytesEstimate: "0" },
      } };
    expect(parsed(large)).toEqual(large);
    rejected({ ...large, allocatedBytesEstimate: "9223372036854775808" });
  });

  it("bounds decimal representation without turning measured duration into a future deadline", () => {
    const duration = "9".repeat(128);
    expect(parsed({ ...measurement(), observedScanDurationMs: duration }).observedScanDurationMs).toBe(duration);
    const counts = { ...measurement(), allocationByKind: { ...measurement().allocationByKind,
      file: { inodeCount: "9".repeat(128), allocatedBytesEstimate: "1024" },
    } };
    expect(parsed(counts).allocationByKind.file.inodeCount).toBe("9".repeat(128));
    const bytes = "512" + "0".repeat(125);
    const widest = { ...measurement(), allocatedBytesEstimate: bytes, allocationByKind: {
      directory: { inodeCount: "1", allocatedBytesEstimate: bytes },
      file: { inodeCount: "0", allocatedBytesEstimate: "0" },
      symlink: { inodeCount: "0", allocatedBytesEstimate: "0" },
    } };
    expect(parsed(widest).allocatedBytesEstimate).toBe(bytes);
    rejected({ ...widest, allocatedBytesEstimate: "1536" + "0".repeat(125), allocationByKind: {
      directory: { inodeCount: "1", allocatedBytesEstimate: bytes },
      file: { inodeCount: "1", allocatedBytesEstimate: bytes },
      symlink: { inodeCount: "1", allocatedBytesEstimate: bytes },
    } });
  });

  it.each(["", "00", "01", "-0", "-1", "+1", " 1", "1 ", "1.0", "1e3", "NaN", "Infinity", "9".repeat(129), 0, 512, null, undefined])(
    "refuses noncanonical or unbounded decimal input %s at every numeric field", invalid => {
      rejected({ ...measurement(), allocatedBytesEstimate: invalid });
      rejected({ ...measurement(), observedScanDurationMs: invalid });
      for (const kind of [Kind.Directory, Kind.File, Kind.Symlink]) {
        rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind,
          [kind]: { ...measurement().allocationByKind[kind], inodeCount: invalid },
        } });
        rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind,
          [kind]: { ...measurement().allocationByKind[kind], allocatedBytesEstimate: invalid },
        } });
      }
    },
  );

  it("refuses non-record measurements", () => {
    for (const invalid of [null, undefined, [], "measurement", 0]) rejected(invalid);
  });

  it("requires the exact outer contract and supported allocation basis", () => {
    const { observedScanDurationMs, ...missingDuration } = measurement();
    rejected(missingDuration);
    rejected({ ...measurement(), allocationBasis: "logical_file_size" });
    rejected({ ...measurement(), allocationBasis: undefined });
    rejected({ ...measurement(), installKey: "TEST-not-measurement-authority" });
    rejected({ ...measurement(), guaranteedReclaimedBytes: "5632" });
    const extra = measurement();
    Object.defineProperty(extra, "hidden", { value: true });
    rejected(extra);
    rejected({ ...measurement(), [Symbol("TEST-extra")]: true });
  });

  it("requires all three exact kinds and exact category fields", () => {
    const { symlink, ...missingKind } = measurement().allocationByKind;
    rejected({ ...measurement(), allocationByKind: missingKind });
    rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind, device: symlink } });
    for (const invalid of [null, [], "kind", { inodeCount: "1" },
      { allocatedBytesEstimate: "0" }, { inodeCount: "1", allocatedBytesEstimate: "0", size: "4096" }]) {
      rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind, file: invalid } });
    }
    rejected({ ...measurement(), allocationByKind: null });
    rejected({ ...measurement(), allocationByKind: [] });
    rejected({ ...measurement(), allocationByKind: Object.create(measurement().allocationByKind) });
  });

  it("refuses inconsistent totals and non-block-aligned total or category bytes", () => {
    rejected({ ...measurement(), allocatedBytesEstimate: "5120" });
    rejected({ ...measurement(), allocatedBytesEstimate: "5633" });
    for (const kind of [Kind.Directory, Kind.File, Kind.Symlink]) {
      rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind,
        [kind]: { inodeCount: "1", allocatedBytesEstimate: "513" },
      } });
    }
    // Both totals remain exact and block-aligned: only the per-kind invariant
    // catches allocation split into fractional 512-byte blocks.
    rejected({ ...measurement(), allocationByKind: {
      directory: { inodeCount: "2", allocatedBytesEstimate: "4095" },
      file: { inodeCount: "3", allocatedBytesEstimate: "1025" },
      symlink: { inodeCount: "1", allocatedBytesEstimate: "512" },
    } });
    rejected({ ...measurement(), allocationByKind: {
      directory: { inodeCount: "2", allocatedBytesEstimate: "4096" },
      file: { inodeCount: "3", allocatedBytesEstimate: "1023" },
      symlink: { inodeCount: "1", allocatedBytesEstimate: "513" },
    } });
  });

  it("requires the target root inode and forbids allocation attributed to zero inodes", () => {
    rejected({ ...measurement(), allocatedBytesEstimate: "0", allocationByKind: {
      directory: { inodeCount: "0", allocatedBytesEstimate: "0" },
      file: { inodeCount: "0", allocatedBytesEstimate: "0" },
      symlink: { inodeCount: "0", allocatedBytesEstimate: "0" },
    } });
    for (const kind of [Kind.Directory, Kind.File, Kind.Symlink]) {
      rejected({ ...measurement(), allocationByKind: { ...measurement().allocationByKind,
        [kind]: { ...measurement().allocationByKind[kind], inodeCount: "0" },
      } });
    }
  });

  it("detaches validated metadata from later caller mutations", () => {
    const source = measurement(), retained = parsed(source);
    source.allocatedBytesEstimate = "0";
    source.observedScanDurationMs = "0";
    source.allocationByKind.directory.inodeCount = "0";
    source.allocationByKind.file.allocatedBytesEstimate = "0";
    expect(retained.allocatedBytesEstimate).toBe("5632");
    expect(retained.observedScanDurationMs).toBe("17");
    expect(retained.allocationByKind.directory.inodeCount).toBe("2");
    expect(retained.allocationByKind.file.allocatedBytesEstimate).toBe("1024");
  });
});
