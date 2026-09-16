import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readHostedPrivateBytes, type HostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { assertReadonlyHostOperator, readonlyIdentityName } from "./hosted-readonly-authority";

// Permanent managed identity is independent of the volatile policy/grant. Never
// delete these records to de-enroll a job, including after host reboot.
export const readonlySupervisorRoot = "/var/lib/subscription-runtime-host-policy";
export const readonlyCustodyRoot = join(readonlySupervisorRoot, "codex-readonly-custody");
export const readonlyServiceRoot = join(readonlySupervisorRoot, "codex-readonly-services");
export const readonlyRevokedRoot = join(readonlySupervisorRoot, "codex-readonly-revoked");

/** Call before an absent grant can select the ordinary profile. Even a partial
 * durable enrollment permanently retains the managed identity. Full host-ledger
 * loss still needs the supervisor's CLOSED recovery gate; absence is not proof
 * that a host was never enrolled.
 */
export function assertReadonlyEnrollmentProfile(jobId: string, managed: boolean): void {
  const name = readonlyIdentityName(jobId);
  if (readHostedPrivateBytes(join(readonlyRevokedRoot, name), 4096)) {
    throw new Error("hosted_readonly_revoked");
  }
  if (!managed && readHostedPrivateBytes(join(readonlyCustodyRoot, name), 4096)) {
    throw new Error("hosted_readonly_managed_grant_required");
  }
}

/** Same-boot crashes retain the lock. Only an actual reboot fences the old
 * submitters; do not infer safety from a stale PID or missing service. */
export function withReadonlyCustodyLock<T>(jobId: string, action: () => T): T {
  const lock = readonlyCurrentBootLock(join(readonlyCustodyRoot, readonlyIdentityName(jobId) + ".lock"));
  mkdirSync(lock, { mode: 0o700 });
  try { return action(); } finally { rmdirSync(lock); }
}

/** Shared only by the fixed epoch/job adapters, never a launch argument. A
 * crash keeps this boot's mutex closed. A real reboot fences every old process
 * and delayed submitter and selects a different mutex without deleting evidence.
 * Durable recovery still validates reservations and exact material before READY.
 * Unversioned locks from an older implementation are not silently migrated. */
export function readonlyCurrentBootLock(legacyPath: string): string {
  assertReadonlyHostOperator();
  // Also validates private ancestry before a lock is created there.
  if (readHostedPrivateBytes(legacyPath, 1)) throw new Error("hosted_custody_legacy_lock_recovery_required");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) {
    throw new Error("hosted_custody_boot_identity_invalid");
  }
  return legacyPath.slice(0, -".lock".length) + `.${boot}.lock`;
}

export function createReadonlyPrivateRecord(path: string, bytes: Buffer): void {
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readHostedPrivateBytes(path, 64 * 1024)?.equals(bytes)) {
      throw new Error("hosted_readonly_conflicting_enrollment");
    }
    // Replay also repairs interrupted durability, never just acknowledges bytes.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncRecordAncestry(path);
    return;
  }
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncRecordAncestry(path);
}
function syncRecordAncestry(path: string): void {
  // The operator may have just created private directories. Persist those names
  // too, not only the final record's link in its immediate parent.
  for (let directory = dirname(path);; directory = dirname(directory)) {
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    if (directory === "/") break;
  }
}

/** Stop requests are not terminal proof. In particular, a recorded service may
 * still be queued behind a live systemd-run proxy. Retain all records and lease.
 */
export function requestReadonlyServiceStops(jobId: string): number {
  const root = join(readonlyServiceRoot, readonlyIdentityName(jobId));
  let names: string[];
  try { names = readdirSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  for (const name of names) {
    if (!/^subscription-runtime-hosted-[a-f0-9-]{36}\.service\.json$/.test(name)) invalid();
    const bytes = readHostedPrivateBytes(join(root, name), 4096);
    const unit = name.slice(0, -5);
    if (!bytes || bytes.toString("utf8") !== JSON.stringify({ schemaVersion: 1, jobId, unit }) + "\n") invalid();
    for (const args of [["kill", "--signal=SIGTERM", "--kill-whom=all", unit], ["stop", "--no-block", unit]]) {
      spawnSync("/usr/bin/systemctl", args, { stdio: "ignore", timeout: 5_000 });
    }
  }
  return names.length;
}

export function readonlyCustodySnapshot(policy: HostedReadonlyPolicy): string {
  assertReadonlyMountLayout(policy);
  const paths = new Set<string>();
  for (let parent = policy.workspacePath;; parent = dirname(parent)) {
    paths.add(parent);
    if (parent === "/") break;
  }
  for (const root of policy.readonlyPaths) {
    paths.add(root);
    for (let parent = dirname(root);; parent = dirname(parent)) {
      paths.add(parent);
      if (parent === policy.workspacePath) break;
    }
  }
  const values = [...paths].sort().map(path => {
    const stat = lstatSync(path);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
        (stat.isFile() && stat.nlink !== 1)) throw new Error("hosted_readonly_input_custody_invalid");
    return [path, stat.dev, stat.ino, stat.mode, stat.isFile() ? stat.nlink : null];
  });
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** Issuer owns reviewed byte/provenance verification. Runtime checks the bounded
 * physical arrangement and preserves its root-held lease across every service.
 */
export function inspectReadonlyInputs(policy: HostedReadonlyPolicy,
  shim: { readonly path: string; readonly target: string } | null): void {
  const initialSnapshot = readonlyCustodySnapshot(policy);
  let entries = 0;
  let shimSeen = false;
  const inspect = (path: string): void => {
    if (++entries > 100_000) throw new Error("hosted_readonly_inventory_limit");
    const stat = lstatSync(path);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) invalid();
    if (stat.isSymbolicLink()) {
      if (!shim || path !== shim.path || readlinkSync(path) !== shim.target || stat.nlink !== 1) invalid();
      shimSeen = true;
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) inspect(join(path, name));
    } else if (!stat.isFile() || stat.nlink !== 1) invalid();
  };
  for (const root of policy.readonlyPaths) inspect(root);
  if (shim !== null && !shimSeen) invalid();
  if (readonlyCustodySnapshot(policy) !== initialSnapshot) invalid();
}

function assertReadonlyMountLayout(policy: HostedReadonlyPolicy): void {
  // Disk filesystem prerequisite for this bounded first implementation.
  // This is a structural prerequisite, not evidence that systemd mounts ran.
  if (![0xef53, 0x58465342, 0x9123683e].includes(statfsSync(policy.workspacePath).type)) {
    throw new Error("hosted_readonly_filesystem_unsupported");
  }
  const contains = (parent: string, child: string): boolean => parent === "/" || child === parent || child.startsWith(parent + "/");
  const decode = (value: string): string => value.replace(/\\(040|011|012|134)/g,
    (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map(line => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4 || !/^\d+:\d+$/.test(fields[2] ?? "") ||
        !fields[3]?.startsWith("/") || !fields[4]?.startsWith("/")) invalid();
    const mounted = decode(fields[4]!);
    if (mounted.startsWith(policy.workspacePath + "/")) invalid();
    return { device: fields[2]!, root: decode(fields[3]!), mounted };
  });
  const ancestors = mounts.filter(mount => contains(mount.mounted, policy.workspacePath))
    .sort((a, b) => b.mounted.length - a.mounted.length);
  const source = ancestors[0];
  if (!source || new Set(ancestors.map(mount => mount.mounted)).size !== ancestors.length) invalid();
  const backingWorkspace = join(source.root, policy.workspacePath.slice(source.mounted === "/" ? 1 : source.mounted.length));
  for (const mount of mounts) {
    if (mount === source || mount.device !== source.device) continue;
    // Permit the normal ancestor view only when it names the same backing path.
    // Reject alternate exposures even if currently readonly: this admission
    // does not own their remount lifecycle. No host mounts are changed here.
    if (contains(mount.mounted, policy.workspacePath) &&
        join(mount.root, policy.workspacePath.slice(mount.mounted === "/" ? 1 : mount.mounted.length)) === backingWorkspace) continue;
    if (contains(mount.root, backingWorkspace) || contains(backingWorkspace, mount.root)) invalid();
  }
}

function invalid(): never { throw new Error("hosted_readonly_input_custody_invalid"); }
