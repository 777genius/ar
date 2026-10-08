import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync,
  realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostedInstallation, type HostedInstallation } from "../worker-core/hosted-custody/domain/hosted-installation-activation";
import type { DependencyManifestBlobStore } from "../worker-core/dependency-environment/ports/dependency-manifest-blob-store";
import { LocalDependencyManifestBlobStore } from "../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { createReadonlyPrivateRecord, readonlySupervisorRoot as policyRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";

export enum HostedManifestLimitsRevision { TestUnqualifiedV1 = "registry_test_manifest_bounds_v1_unqualified" }
export enum HostedManifestPlacementFailure { Unsupported = "unsupported", Retained = "retained", Drift = "drift", Unsafe = "unsafe", Closed = "closed" }
export class HostedManifestPlacementError extends Error {
  constructor(readonly reason: HostedManifestPlacementFailure) { super(`dependency_manifest_placement:${reason}`); }
}
function fail(reason = HostedManifestPlacementFailure.Unsafe): never { throw new HostedManifestPlacementError(reason); }
const policyPath = join(policyRoot, "dependency-manifest-storage-policy.json");
const placementPath = join(policyRoot, "dependency-manifest-placement.json");
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const hash = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
// Existing TEST budgets, versioned explicitly without a production measurement
// claim. Qualification/headroom evidence and reboot migration remain separate.
const testBounds = Object.freeze({ maxManifestBytes: 32 * 1024 * 1024, maxStoredBytes: 512 * 1024 * 1024, maxBlobs: 2048 });
type Pin = { canonicalPath: string; dev: string; ino: string; mountId: string };
type Policy = { version: 1; scratchRoot: Pin; bootId: string; limitsRevision: HostedManifestLimitsRevision.TestUnqualifiedV1 };
type Placement = { version: 1; installation: HostedInstallation; policySha256: string; limitsRevision: HostedManifestLimitsRevision;
  scratchRoot: Pin; family: Pin; blobs: Pin; bootId: string };
type Mount = { id: string; device: string; root: string; point: string };
const retainedDirectories = ["dependency-receipts", "dependency-receipt-history", "dependency-manifests", "dependency-bindings",
  "dependency-owners", "dependency-fresh-absence", "dependency-provider-attempts", "dependency-attempt-fences", "dependency-installers",
  "dependency-provider-roots", "dependency-transactions", "dependency-trash", "ordinary-origins", "ordinary-starts", "ordinary-completed",
  "ordinary-correlations", "ordinary-invocations", "ordinary-submitter-exits", "ordinary-submitters", "ordinary-actor-chains",
  "scoped-terminating", "scoped-operations", "scoped-observations", "scoped-receipts", "child-slots",
  "codex-readonly-custody", "codex-readonly-revoked", "codex-readonly-services"];
const retainedRecords = ["host-installation.json", "host-activation.json", "host-activation.next", "ordinary-origins.json", "ordinary-origins.next",
  "readonly-enrollment.json", "readonly-epoch.json", "readonly-epoch.next", "readonly-epoch.lock", "dependency-manifest-placement.json"];
const overlap = (a: string, b: string): boolean => a === "/" || b === "/" || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
function canonical(path: unknown): asserts path is string {
  if (typeof path !== "string" || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || resolve(path) !== path) fail();
}
function fields(value: unknown, expected: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== expected) fail();
}
function pin(value: unknown): asserts value is Pin {
  fields(value, "canonicalPath,dev,ino,mountId"); canonical(value.canonicalPath);
  if (typeof value.dev !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value.dev) ||
    typeof value.ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.ino) ||
    typeof value.mountId !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.mountId)) fail();
}
function decode(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return fail(); }
}
function policy(): { value: Policy; bytes: Buffer } | null {
  const bytes = readHostedPrivateBytes(policyPath, 4096); if (!bytes) return null;
  const value = decode(bytes); fields(value, "bootId,limitsRevision,scratchRoot,version"); pin(value.scratchRoot);
  if (value.version !== 1 || value.limitsRevision !== HostedManifestLimitsRevision.TestUnqualifiedV1 ||
    typeof value.bootId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId)) fail();
  return { value: value as unknown as Policy, bytes };
}
function mountId(fd: number): string {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  const matches = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  const id = matches[0]?.[1]; if (matches.length !== 1 || !id) fail(); return id;
}
function directory(path: string, privateLeaf: boolean): number {
  canonical(path);
  for (let ancestor = path;; ancestor = dirname(ancestor)) {
    const stat = lstatSync(ancestor, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0n || (stat.mode & 0o022n)) fail();
    if (ancestor === "/") break;
  }
  if (realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (!s.isDirectory() || s.uid !== 0n || (s.mode & 0o022n) || current.uid !== 0n || (current.mode & 0o022n) ||
      s.dev !== current.dev || s.ino !== current.ino || (privateLeaf && (s.mode & 0o7777n) !== 0o700n)) fail();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function facts(path: string, fd: number): Pin {
  const stat = fstatSync(fd, { bigint: true });
  return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino), mountId: mountId(fd) };
}
function assertPin(expected: Pin, fd: number, privateLeaf: boolean): void {
  const fresh = directory(expected.canonicalPath, privateLeaf);
  try { if (!encode(facts(expected.canonicalPath, fresh)).equals(encode(expected)) ||
    !encode(facts(expected.canonicalPath, fd)).equals(encode(expected))) fail(HostedManifestPlacementFailure.Drift); }
  finally { closeSync(fresh); }
}
function mountTable(): Mount[] {
  const bytes = readFileSync("/proc/self/mountinfo");
  // Observation bound, not an invented production manifest budget. Unknown
  // oversized/escaped mount inventories cannot prove grant exclusion.
  if (bytes.length > 1024 * 1024) fail(HostedManifestPlacementFailure.Unsupported);
  return bytes.toString("utf8").trimEnd().split("\n").map(line => {
    const parts = line.split(" "), id = parts[0], device = parts[2], root = parts[3], point = parts[4];
    if (parts.length < 10 || !parts.includes("-") || !id || !/^[1-9][0-9]*$/.test(id) || !device || !/^[0-9]+:[0-9]+$/.test(device) ||
      !root || !point || !root.startsWith("/") || !point.startsWith("/") || root.includes("\\") || point.includes("\\")) fail();
    return { id, device, root, point };
  });
}
function outsideGrants(scratch: Pin, installation: HostedInstallation): void {
  const forbidden = ["/usr", "/opt", "/etc", "/var", "/run", "/home", "/tmp", "/dev", "/proc", "/sys", installation.runtimeDirectory];
  if (forbidden.some(path => overlap(scratch.canonicalPath, path))) fail(HostedManifestPlacementFailure.Unsupported);
  const rows = mountTable(), own = rows.filter(row => row.id === scratch.mountId);
  const selected = own[0]; if (own.length !== 1 || !selected ||
    !(scratch.canonicalPath === selected.point || scratch.canonicalPath.startsWith(selected.point === "/" ? "/" : selected.point + "/"))) fail();
  const physical = join(selected.root, relative(selected.point, scratch.canonicalPath));
  for (const row of rows) {
    // Bind aliases into any granted family may expose the same filesystem
    // subtree despite disjoint canonical paths. Device-only checks are insufficient.
    if (row.device === selected.device && forbidden.some(path => overlap(row.point, path))) {
      const exposed = forbidden.filter(path => path === row.point || path.startsWith(row.point === "/" ? "/" : row.point + "/"))
        .map(path => join(row.root, relative(row.point, path)));
      if (forbidden.some(path => row.point.startsWith(path + "/"))) exposed.push(row.root);
      if (exposed.some(path => overlap(physical, path))) fail(HostedManifestPlacementFailure.Unsupported);
    }
  }
}
function installationFacts(installation: HostedInstallation): void {
  const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const stage = readHostedPrivateBytes("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(runtimeDirectory)) + ".json", 4096);
  const inventoryBytes = readHostedPrivateBytes(join(policyRoot, "readonly-inventory.json"), 64 * 1024);
  if (!stage || !inventoryBytes) fail();
  const value = decode(stage); fields(value, "runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion");
  const inventory = readHostedReadonlyHostInventory();
  if (value.schemaVersion !== 1 || value.runtimeDirectory !== runtimeDirectory || installation.runtimeDirectory !== runtimeDirectory ||
    value.runtimeSha !== installation.runtimeSha || value.runtimeManifestSha256 !== installation.runtimeManifestSha256 ||
    inventory.hostId !== installation.hostId || (inventory.schemaVersion !== 2 && inventory.schemaVersion !== 3 && inventory.schemaVersion !== 4) || hash(inventoryBytes) !== installation.inventorySha256) fail();
  const jobPrefix = join(policyRoot, "dependency-test-jobs/jobs");
  for (const c of inventory.ordinaryCreators) {
    if (!/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(c.jobId) || c.jobRootDir !== join(jobPrefix, c.jobId) || c.workspacePath !== c.jobRootDir + "/workspace" ||
      c.childSlotSha256 !== undefined || c.launch.command !== process.execPath || c.launch.cwd !== c.workspacePath ||
      c.launch.args[0] !== runtimeDirectory + "/dist/worker-codex/codex-goal-cli.js" || c.launch.args[1] !== "run" ||
      c.launch.args.some(arg => /^--(?:tmux|tmux-session|dry-run|print-command|hosted-lifecycle|lifecycle(?:-[^=]+)?)(?:=|$)/.test(arg))) fail();
    for (const [index, arg] of c.launch.args.entries()) {
      if (arg === "--registry-root" && c.launch.args[index + 1] !== c.jobRootDir + "/state/registry") fail();
      if (arg.startsWith("--registry-root=")) fail();
    }
  }
  if (!inventory.ordinaryCreators.length || !inventory.ordinaryCreators.some(c => encode(c.launch).equals(encode(inventory.runtimeLaunch)))) fail();
}
function emptyDirectory(path: string): void {
  try {
    const fd = directory(path, true);
    try {
      const before = fstatSync(fd, { bigint: true });
      const entries = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 1 });
      try { if (entries.readSync()) fail(HostedManifestPlacementFailure.Retained); } finally { entries.closeSync(); }
      const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || current.dev !== before.dev || current.ino !== before.ino) fail();
    } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function noReferences(): void {
  for (const name of retainedRecords) if (readHostedPrivateBytes(join(policyRoot, name), 4 * 1024 * 1024)) fail(HostedManifestPlacementFailure.Retained);
  for (const name of retainedDirectories) emptyDirectory(join(policyRoot, name));
  for (const name of ["codex-readonly", "codex-readonly-reviewed", "codex-egress"])
    emptyDirectory("/run/user/0/subscription-runtime-host-policy/" + name);
}
function createDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 }); const fd = directory(path, true);
  try { const parent = directory(dirname(path), false); try { fsyncSync(fd); fsyncSync(parent); } finally { closeSync(parent); } }
  finally { closeSync(fd); }
}

/** Called only at the actual fresh installation publication boundary. No config
 * leaves unmanaged installation behavior untouched. Configured retained state
 * requires migration evidence, which this first slice deliberately cannot issue.
 */
export function issueFreshHostedManifestPlacement(fence: HostedActivationFence, candidate: HostedInstallation): void {
  assertHostedActivationFence(fence); assertHostedActivationOperator(); const selected = policy(); if (!selected) return;
  const installation = parseHostedInstallation(candidate), kernel = new HostedReadonlyHostKernel();
  const session = kernel.operatorSession(); kernel.verifyExclusiveInventory(); kernel.verifyDescriptorBoundary();
  installationFacts(installation); noReferences();
  if (session.hostId !== installation.hostId || session.bootId !== selected.value.bootId) fail();
  outsideGrants(selected.value.scratchRoot, installation);
  const fd = directory(selected.value.scratchRoot.canonicalPath, false);
  try {
    assertPin(selected.value.scratchRoot, fd, false);
    const family = join(selected.value.scratchRoot.canonicalPath, "dependency-manifests"); emptyDirectory(family);
    try { createDirectory(family); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const blobs = join(family, installation.installationId); createDirectory(blobs);
    const familyFd = directory(family, true); let blobsFd: number | undefined;
    try {
      blobsFd = directory(blobs, true);
      const record: Placement = { version: 1, installation, policySha256: hash(selected.bytes), limitsRevision: selected.value.limitsRevision,
        scratchRoot: selected.value.scratchRoot, family: facts(family, familyFd), blobs: facts(blobs, blobsFd), bootId: session.bootId };
      if (record.family.mountId !== record.scratchRoot.mountId || record.blobs.mountId !== record.scratchRoot.mountId) fail();
      kernel.verifyExclusiveInventory(); assertHostedActivationFence(fence); noReferences();
      if (!policy()?.bytes.equals(selected.bytes)) fail(HostedManifestPlacementFailure.Drift);
      assertPin(record.scratchRoot, fd, false); outsideGrants(record.scratchRoot, installation);
      createReadonlyPrivateRecord(placementPath, encode(record));
    } finally { closeSync(familyFd); if (blobsFd !== undefined) closeSync(blobsFd); }
  } finally { closeSync(fd); }
}

/** Strict scratch reader, not a legacy-root fallback or migration API. Callers
 * must assert the same placement again before publishing Ready or GC receipts.
 */
export async function openHostedDependencyManifestPlacement(): Promise<DependencyManifestBlobStore & {
  readonly placementRevision: string; readonly limitsRevision: HostedManifestLimitsRevision;
  assertCurrent(fence: HostedActivationFence): void; close(): Promise<void>;
}> {
  assertHostedActivationOperator(); const selected = policy(), bytes = readHostedPrivateBytes(placementPath, 16384);
  if (!selected || !bytes) fail(HostedManifestPlacementFailure.Unsupported);
  const value = decode(bytes); fields(value, "blobs,bootId,family,installation,limitsRevision,policySha256,scratchRoot,version");
  pin(value.scratchRoot); pin(value.family); pin(value.blobs);
  const installation = parseHostedInstallation(value.installation), installed = readHostedPrivateBytes(join(policyRoot, "host-installation.json"), 4096);
  if (!installed || value.version !== 1 || !encode(decode(installed)).equals(encode(installation)) || value.bootId !== selected.value.bootId ||
    value.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || value.policySha256 !== hash(selected.bytes) ||
    value.limitsRevision !== selected.value.limitsRevision || !encode(value.scratchRoot).equals(encode(selected.value.scratchRoot)) ||
    value.family.canonicalPath !== join(value.scratchRoot.canonicalPath, "dependency-manifests") ||
    value.blobs.canonicalPath !== join(value.family.canonicalPath, installation.installationId) ||
    value.family.mountId !== value.scratchRoot.mountId || value.blobs.mountId !== value.scratchRoot.mountId) fail();
  const record = value as unknown as Placement; installationFacts(installation); outsideGrants(record.scratchRoot, installation);
  const pins = [record.scratchRoot, record.family, record.blobs], descriptors: number[] = [];
  let closed = false, closeSucceeded = false, closePromise: Promise<void> | undefined, store: LocalDependencyManifestBlobStore | undefined;
  const assertPlacement = () => {
    assertHostedActivationOperator(); installationFacts(installation);
    if (!readHostedPrivateBytes(placementPath, 16384)?.equals(bytes) || !policy()?.bytes.equals(selected.bytes) ||
      !readHostedPrivateBytes(join(policyRoot, "host-installation.json"), 4096)?.equals(installed)) fail(HostedManifestPlacementFailure.Drift);
    outsideGrants(record.scratchRoot, installation);
    pins.forEach((p, i) => {
      // Closing before the final origin read preserves its descriptor boundary.
      // A later comparison reacquires exact pins under the caller's actual fence.
      const fd = closed ? directory(p.canonicalPath, i > 0) : descriptors[i]; if (fd === undefined) fail();
      try { assertPin(p, fd, i > 0); } finally { if (closed) closeSync(fd); }
    });
  };
  const assertOpen = () => { if (closed) fail(HostedManifestPlacementFailure.Closed); assertPlacement(); };
  try {
    pins.forEach((p, i) => descriptors.push(directory(p.canonicalPath, i > 0))); assertOpen();
    const opened = await LocalDependencyManifestBlobStore.open({ rootPath: record.blobs.canonicalPath, ...testBounds }); store = opened; assertOpen();
    return { placementRevision: hash(bytes), limitsRevision: record.limitsRevision,
      assertCurrent(fence) {
        assertHostedActivationFence(fence);
        if (!closeSucceeded) fail(HostedManifestPlacementFailure.Closed);
        assertPlacement();
      },
      async put(manifest) { assertOpen(); const digest = await opened.put(manifest); assertOpen(); return digest; },
      async get(digest) { assertOpen(); const manifest = await opened.get(digest); assertOpen(); return manifest; },
      close() {
        if (!closePromise) {
          closed = true;
          closePromise = (async () => {
            let failed = false, failure: unknown;
            try { await opened.close(); } catch (error) { failed = true; failure = error; }
            for (const fd of descriptors) {
              try { closeSync(fd); } catch (error) { if (!failed) { failed = true; failure = error; } }
            }
            if (failed) throw failure;
            closeSucceeded = true;
          })();
        }
        return closePromise;
      },
    };
  } catch (error) { try { await store?.close(); } finally { descriptors.forEach(closeSync); } throw error; }
}
