import type { DependencyParentRecipeReader } from "../../../core/dependency-environment/dependency-parent-recipe-reader";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { decodeHostedInventoryBytes } from "../../../core/host-infrastructure/host-inventory";
import { hostedSelectedFileName, hostedSelectionRecordName, parseHostedInstallationSelection, type HostedSelectedRecordName } from "../../../core/host-infrastructure/host-installation-successor";

// Canonical private implementation shared by activation adapters. Internal path
// helpers are not exported from the provider's public entry point.
export const hostedActivationPolicyRoot = "/var/lib/subscription-runtime-host-policy";
const activeFences = new WeakSet<object>();
const acquisitionBusy = new WeakSet<object>();
export function isHostedActivationFenceBusy(error: unknown): boolean {
  return !!error && typeof error === "object" && acquisitionBusy.has(error);
}
// Not a configurable policy root or a public arbitrary filesystem reader.
const recordName = /^(?:readonly-dependency-bindings\/[0-9]{1,20}-[0-9]{1,20}\.json|readonly-dependency-starts\/[a-f0-9-]{36}\.json|dependency-owners\/[0-9]{1,20}-[0-9]{1,20}\.(?:json|lock)|dependency-bindings\/[a-f0-9]{64}\.json|dependency-provider-attempts\/[a-f0-9-]{36}\.json|dependency-attempt-fences\/[a-f0-9-]{36}\.json|installation-successors\/[a-f0-9]{64}(?:\.json|\/(?:host-installation|readonly-inventory)\.json)|readonly-inventory\.json|host-installation\.json|host-activation\.(?:json|next)|ordinary-origins\.json|ordinary-origins\.next|readonly-(?:enrollment\.json|epoch\.(?:json|next|lock))|ordinary-origins\/[a-f0-9]{64}\.json|ordinary-(?:starts|completed|correlations|invocations|submitters|submitter-exits|actor-chains)\/[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}\.json|scoped-(?:terminating|operations|observations|receipts)\/[a-f0-9-]{36}\.json|child-slots\/[a-f0-9]{64}\.json|codex-readonly-(?:custody|revoked)\/[a-f0-9]{64}\.json)$/;
export function isHostedActivationRecordName(name: string): boolean { return recordName.test(name); }
export type HostedActivationFence = Readonly<{ readonly held: true; readonly parentRecipeReader?: DependencyParentRecipeReader }>;

/** Initial host root is trusted; namespace-local root is not that principal. */
export function assertHostedActivationOperator(): void {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 ||
        !/^0\s+0\s+4294967295$/.test(readFileSync("/proc/self/uid_map", "utf8").trim())) invalid();
    for (const ns of ["user", "mnt", "pid"]) {
      if (readlinkSync(`/proc/self/ns/${ns}`) !== readlinkSync(`/proc/1/ns/${ns}`)) invalid();
    }
  } catch { throw new Error("hosted_readonly_host_operator_required"); }
}

/** Missing final record is distinguishable from unsafe/missing ancestry. Reads
 * do not create authority, initialize directories or recover partial state. */
export function readHostedActivationBytes(name: string): Buffer | null {
  assertHostedActivationOperator();
  if (!recordName.test(name)) invalid();
  const bytes = name === "host-installation.json" || name === "readonly-inventory.json" ? selectedInstallationRecord(name).bytes : readHostedActivationPath(join(hostedActivationPolicyRoot, name));
  if (bytes && name === "readonly-inventory.json") decodeHostedInventoryBytes(bytes);
  return bytes;
}
/**
 * The ONE resolver of the installation and inventory records. Without `installationSelectionSha256` in the committed
 * activation these are the original fixed records. With it, only the content-addressed selection record named by that digest
 * (digest verified here) can select the versioned copies, and each copy must match the digest the selection records. There is
 * no newest-file rule and no caller selector; a missing or mismatching record refuses (never falls back to the old one).
 */
function selectedInstallationRecord(name: HostedSelectedRecordName): { path: string; bytes: Buffer | null } {
  return resolveSelectedInstallationRecord(name, relative => readHostedActivationPath(join(hostedActivationPolicyRoot, relative)));
}
/** The resolver over an injected raw reader of private records (relative names beneath the Host-policy root). */
export function resolveSelectedInstallationRecord(name: HostedSelectedRecordName, read: (relative: string) => Buffer | null): { path: string; bytes: Buffer | null } {
  const activationBytes = read("host-activation.json");
  const activation = activationBytes ? decodeHostedActivationBytes(activationBytes) as Record<string, unknown> | null : null;
  const selection = activation && typeof activation === "object" ? activation.installationSelectionSha256 : undefined;
  if (selection === undefined) return { path: name, bytes: read(name) };
  if (typeof selection !== "string" || !/^[a-f0-9]{64}$/.test(selection)) invalid();
  const recordBytes = read(hostedSelectionRecordName(selection));
  if (!recordBytes || createHash("sha256").update(recordBytes).digest("hex") !== selection) invalid();
  const record = parseHostedInstallationSelection(decodeHostedActivationBytes(recordBytes));
  const path = hostedSelectedFileName(selection, name), bytes = read(path);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== (name === "host-installation.json" ? record.installationSha256 : record.inventorySha256)) invalid();
  return { path, bytes };
}
/** Relative record name (beneath the private Host-policy root) for readers that open the file themselves. */
export function selectedHostedInstallationRecordName(name: HostedSelectedRecordName): string {
  assertHostedActivationOperator();
  return selectedInstallationRecord(name).path;
}
export function readHostedActivationPath(path: string, privateFile = true): Buffer | null {
  const parent = dirname(path);
  const parents: string[] = [];
  for (let current = parent;; current = dirname(current)) {
    parents.unshift(current);
    if (current === "/") break;
  }
  for (const current of parents) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (privateFile && current === parent && (stat.mode & 0o077))) invalid();
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd), max = 4 * 1024 * 1024;
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & (privateFile ? 0o077 : 0o022)) || before.size > max) invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs || after.uid !== 0 || after.nlink !== 1 || (after.mode & (privateFile ? 0o077 : 0o022))) invalid();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
export function decodeHostedActivationBytes(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid(); }
}

/** Same boot-specific mkdir mutex as the managed epoch. No stale lock removal,
 * second lock or missing-epoch fallback. Acquisition can precede enrollment. */
export function withHostedActivationFence<T>(action: (fence: HostedActivationFence) => T, parentRecipeReader?: DependencyParentRecipeReader): T {
  if (readHostedActivationBytes("readonly-epoch.lock")) throw new Error("hosted_custody_legacy_lock_recovery_required");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) {
    throw new Error("hosted_custody_boot_identity_invalid");
  }
  const lock = join(hostedActivationPolicyRoot, `readonly-epoch.${boot}.lock`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const busy = new Error("hosted_activation_fence_busy"); acquisitionBusy.add(busy); throw busy;
  }
  const fence = Object.freeze({ held: true as const, ...(parentRecipeReader ? { parentRecipeReader } : {}) });
  activeFences.add(fence);
  try {
    const result = action(fence);
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
      throw new Error("hosted_custody_synchronous_fence_required");
    }
    return result;
  } finally {
    activeFences.delete(fence);
    rmdirSync(lock);
  }
}
export function assertHostedActivationFence(fence: HostedActivationFence): void {
  if (!activeFences.has(fence)) throw new Error("hosted_custody_common_fence_required");
}

function invalid(): never { throw new Error("hosted_activation_evidence_invalid"); }
