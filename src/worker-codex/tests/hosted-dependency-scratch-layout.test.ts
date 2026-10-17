import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { HostedDependencyBinding } from "../hosted-dependency-workspace";
import { DependencyReceiptState, DependencyUnverifiedReason } from "../../worker-core/index";
const f = vi.hoisted(() => ({ stage: {} as Record<string, unknown>, error: false, reads: 0, root: "", replace: false, records: new Map<string, Buffer>(), current: undefined as unknown }));
vi.mock("../../provider-codex/app-server/adapters/hosted-full-backing-stage", () => ({
  FullBackingInstallationContract: { OriginalParentProcV1: "original_full_parent_proc_v1" },
  readOriginalHostedDependencyBackingStage: () => { f.reads++; if (f.error) throw new Error("TEST missing original stage"); return f.stage; },
}));
// Immutable-record ports below are projections, as in the existing mapping
// composition suite. Exercise the actual mapping consumer, not a second parser.
vi.mock("../hosted-dependency-receipts", () => ({ readHostedDependencyCommittedUnverified: () => f.current }));
vi.mock("../hosted-dependency-legacy-reference-records", () => ({ pinReferenceFile: (path: string) => {
  const bytes = f.records.get(path); if (!bytes) throw Error("TEST absent protected record");
  return { bytes, reference: { path, identity: { dev: "7", ino: "25" }, sha256: createHash("sha256").update(bytes).digest("hex") } };
} }));
// The protected stage/absolute-path ports are projected. Linux ROOT cases use
// real directories, modes, inodes, raw links, retained FDs and /proc fdinfo.
// This is not native issuer, custody or FULL launch qualification.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs"), policy = "/var/lib/subscription-runtime-host-policy";
  const map = (value: unknown) => { if (typeof value !== "string" || value !== policy && !value.startsWith(policy + "/")) return value;
    if (!f.root) throw Error("TEST unexpected import-time physical I/O"); return f.root + value.slice(policy.length); };
  return { ...actual,
    lstatSync: (...args: unknown[]) => Reflect.apply(actual.lstatSync, actual, [map(args[0]), ...args.slice(1)]),
    openSync: (...args: unknown[]) => Reflect.apply(actual.openSync, actual, [map(args[0]), ...args.slice(1)]),
    readdirSync: (...args: unknown[]) => Reflect.apply(actual.readdirSync, actual, [map(args[0]), ...args.slice(1)]),
    realpathSync: (path: string) => { const result = actual.realpathSync(map(path) as string); return f.root && result.startsWith(f.root) ? policy + result.slice(f.root.length) : result; },
    fstatSync: (...args: unknown[]) => {
      const result = Reflect.apply(actual.fstatSync, actual, args);
      if (f.replace && actual.readlinkSync("/proc/self/fd/" + args[0]).endsWith("/dependency-test-jobs/dependency-quarantine")) {
        f.replace = false; const path = f.root + "/dependency-test-jobs/dependency-quarantine";
        actual.renameSync(path, path + ".retained"); actual.mkdirSync(path, { mode: 0o700 });
      }
      return result;
    },
  };
});
import { HostedDependencyScratchDirectory as Directory, HostedDependencyScratchLayoutKind as Kind,
  readHostedDependencyScratchDirectoryPin, readHostedDependencyScratchLayout } from "../hosted-dependency-scratch-layout";
import { hostedDependencyPreservationPath, readHostedDependencyPreparedPreservation } from "../hosted-dependency-preservation";
const importReads = f.reads, sha = "a".repeat(40), policy = "/var/lib/subscription-runtime-host-policy", storage = policy + "/dependency-test-jobs";
beforeEach(() => { f.root = mkdtempSync(join(tmpdir(), "TEST-scratch-layout-")); f.error = false; f.reads = 0; f.replace = false; f.records.clear(); f.current = undefined;
  f.stage = { schemaVersion: 2, runtimeDirectory: "/opt/subscription-runtime-dependency-os-TEST", runtimeSha: sha,
    runtimeManifestSha256: "b".repeat(64), backingInterval: "original_full_parent_proc_v1" }; });
afterEach(() => rmSync(f.root, { recursive: true }));
it("imports without reading stage or selecting a root", () => expect(importReads).toBe(0));
it("retains exact schema1 namespaces", () => {
  f.stage = { schemaVersion: 1, runtimeSha: sha };
  expect(readHostedDependencyScratchLayout(sha)).toEqual({ kind: Kind.Existing, parent: policy, quarantine: policy + "/dependency-quarantine", trash: policy + "/dependency-trash" });
});
it("selects both reserved FULL siblings outside the exact jobs namespace", () => {
  const value = readHostedDependencyScratchLayout(sha);
  expect(value).toEqual({ kind: Kind.OriginalFull, parent: storage, quarantine: storage + "/dependency-quarantine", trash: storage + "/dependency-trash" });
  expect(Object.isFrozen(value)).toBe(true);
  for (const path of [value.quarantine, value.trash]) expect(path.startsWith(storage + "/jobs/")).toBe(false);
});
it("refuses absent original stage instead of falling back", () => { f.error = true; expect(() => readHostedDependencyScratchLayout(sha)).toThrow("missing original stage"); });
it("refuses another authenticated source SHA", () => expect(() => readHostedDependencyScratchLayout("c".repeat(40))).toThrow("scratch_layout_held"));
it("refuses malformed source SHA", () => expect(() => readHostedDependencyScratchLayout("a".repeat(39))).toThrow("scratch_layout_held"));
it("refuses unknown schema and FULL contract", () => {
  f.stage.schemaVersion = 3; expect(() => readHostedDependencyScratchLayout(sha)).toThrow("scratch_layout_held");
  f.stage.schemaVersion = 2; f.stage.backingInterval = "unknown"; expect(() => readHostedDependencyScratchLayout(sha)).toThrow("scratch_layout_held");
});
it("retains a conflicting legacy file instead of treating it as absence", () => {
  const path = f.root + "/dependency-quarantine", bytes = Buffer.from([0, 255, 1, 128]); writeFileSync(path, bytes, { mode: 0o600 });
  const before = lstatSync(path); expect(() => readHostedDependencyScratchLayout(sha)).toThrow("legacy_retained");
  expect(readFileSync(path)).toEqual(bytes); expect(lstatSync(path).ino).toBe(before.ino);
});
// Exact existing prior receipt/history and inventory are retained while the
// original mapping reader authenticates the selected fixed FULL destination.
function prepared(destination: string) {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n"), hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const binding = { version: 2, jobId: "TEST-layout", jobRootDir: storage + "/jobs/TEST-layout", workspace: { canonicalPath: storage + "/jobs/TEST-layout/workspace", dev: "7", ino: "9" },
    installationId: "00000000-0000-4000-8000-000000000001", runtimeSha: sha, grantDigest: "b".repeat(64) } as HostedDependencyBinding;
  const previous = { version: 1 as const, revision: 1, generation: "TEST-old", workspace: binding.workspace, coverageRevision: "c".repeat(64),
    state: DependencyReceiptState.Unverified as const, tree: { dev: "7", ino: "11" }, reason: DependencyUnverifiedReason.BaselineMissing };
  const operationId = "00000000-0000-4000-8000-000000000002", inventory = encode({ version: 1, entries: ["TEST opaque inventory"] }), compressed = gzipSync(inventory),
    path = destination + "/" + operationId + ".inventory.json.gz", reference = { path: "/TEST/original", identity: { dev: "7", ino: "24" }, sha256: hash(encode(previous)) };
  const header = { version: 1, binding, attempt: { operationId, epoch: 2, host: { installationId: binding.installationId, bootId: "00000000-0000-4000-8000-000000000003",
    supervisorId: "1:2", runtimeSha: sha, inventoryDigest: "d".repeat(64), grantDigest: binding.grantDigest } }, previous: { receipt: previous, reference },
    trash: { operationId, originalTree: previous.tree, destinationParent: { canonicalPath: destination, dev: "7", ino: "10" }, destinationName: "dependency-" + operationId },
    inventory: { reference: { path, identity: { dev: "7", ino: "25" }, sha256: hash(compressed) }, digest: hash(inventory), logicalBytes: "32", entries: 1 } };
  const record = hostedDependencyPreservationPath(binding, 1) + ".prepared.json";
  f.current = header.previous; f.records.set(path, compressed); f.records.set(record, encode(header));
  return { binding, previous, header, record };
}
it("actual mapping reader accepts the exact selected reserved FULL root", () => {
  const value = prepared(storage + "/dependency-quarantine");
  expect(readHostedDependencyPreparedPreservation(value.binding, value.previous).header).toEqual(value.header);
});
it("actual mapping reader holds an old differing root without hiding or rewriting history", () => {
  const value = prepared(policy + "/dependency-quarantine"), bytes = Buffer.from(f.records.get(value.record)!);
  expect(() => readHostedDependencyPreparedPreservation(value.binding, value.previous)).toThrow("preservation_held");
  expect(f.records.get(value.record)).toEqual(bytes); expect(f.records.has(value.header.inventory.reference.path)).toBe(true);
});
describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("actual Linux ROOT physical layout", () => {
  beforeEach(() => { mkdirSync(f.root + "/dependency-test-jobs", { mode: 0o755 });
    for (const name of ["dependency-quarantine", "dependency-trash"]) mkdirSync(f.root + "/dependency-test-jobs/" + name, { mode: 0o700 }); });
  it("pins both real private siblings to the same actual parent mount", () => {
    const parent = readHostedDependencyScratchDirectoryPin(sha, Directory.Parent);
    for (const directory of [Directory.Quarantine, Directory.Trash]) {
      const pin = readHostedDependencyScratchDirectoryPin(sha, directory), path = f.root + pin.canonicalPath.slice(policy.length), actual = lstatSync(path);
      expect(pin.dev).toBe(String(actual.dev)); expect(pin.ino).toBe(String(actual.ino)); expect(pin.dev).toBe(parent.dev); expect(pin.mountId).toBe(parent.mountId);
    }
  });
  it("permits only genuinely empty private old directories", () => {
    for (const name of ["dependency-quarantine", "dependency-trash"]) mkdirSync(f.root + "/" + name, { mode: 0o700 });
    expect(readHostedDependencyScratchLayout(sha).kind).toBe(Kind.OriginalFull);
  });
  for (const name of ["dependency-quarantine", "dependency-trash"]) it("holds retained old bytes in " + name, () => {
    const path = f.root + "/" + name; mkdirSync(path, { mode: 0o700 }); writeFileSync(path + "/sentinel", Buffer.from([0, 255, 128]));
    const before = lstatSync(path); expect(() => readHostedDependencyScratchLayout(sha)).toThrow("legacy_retained");
    expect(lstatSync(path).ino).toBe(before.ino); expect(readFileSync(path + "/sentinel")).toEqual(Buffer.from([0, 255, 128]));
  });
  it("refuses a symlink alias without following or replacing it", () => {
    const path = f.root + "/dependency-test-jobs/dependency-quarantine"; renameSync(path, path + ".retained"); symlinkSync("dependency-quarantine.retained", path);
    expect(() => readHostedDependencyScratchDirectoryPin(sha, Directory.Quarantine)).toThrow(); expect(readlinkSync(path)).toBe("dependency-quarantine.retained");
  });
  it("refuses nonprivate child mode without repairing it", () => {
    const path = f.root + "/dependency-test-jobs/dependency-quarantine"; chmodSync(path, 0o755);
    expect(() => readHostedDependencyScratchDirectoryPin(sha, Directory.Quarantine)).toThrow("scratch_layout_held"); expect(lstatSync(path).mode & 0o7777).toBe(0o755);
  });
  it("refuses a named replacement while retaining old inode, bytes and raw link", () => {
    const path = f.root + "/dependency-test-jobs/dependency-quarantine", bytes = Buffer.from([0, 255, 128]); writeFileSync(path + "/sentinel", bytes); symlinkSync(Buffer.from([255, 1]), path + "/raw");
    const before = lstatSync(path); f.replace = true; expect(() => readHostedDependencyScratchDirectoryPin(sha, Directory.Quarantine)).toThrow("scratch_layout_held");
    expect(lstatSync(path + ".retained").ino).toBe(before.ino); expect(readFileSync(path + ".retained/sentinel")).toEqual(bytes);
    expect(readlinkSync(path + ".retained/raw", { encoding: "buffer" })).toEqual(Buffer.from([255, 1]));
  });
});
