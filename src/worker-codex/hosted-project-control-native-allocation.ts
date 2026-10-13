import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, readSync, writeSync, readdirSync, rmdirSync, statfsSync, type BigIntStats } from "node:fs";
import { dirname, basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { researchAuthorityRoot, researchHash, researchJson, researchRead } from "./research-launch-files.js";
import type { LocalOwnedWorkspaceLockDirectory, LocalOwnedWorkspaceLockTemporary,
  LocalWorkspaceLockDirectoryLifecycle } from "../store-local-file/safe-execution/adapters/local-safe-execution-state-store.js";
import { assertOriginalFullProjectControlSetupCurrent, runOriginalFullProjectControlGitChild } from "./hosted-project-control-native-origin.js";

import { OriginalControlGitOperation, OriginalControlGitRole, originalControlGitArguments, type OriginalControlGitFrame } from "./hosted-project-control-git-recipe.js";

/** These are copied selectors. Only the original private NativeEntryLive
 * association and held create-only directory custody can use the allocation. */
export type OriginalHostedProjectControlAllocation = Readonly<{
  jobId: string; jobRootDir: string; source: string; auth: string; controllerId: string;
  controllerRoot: string; registry: string; workspace: string; durableHandoffs: string;
}>;
enum AllocationPhase { Creating = "creating", Reserved = "reserved", Held = "held", Closed = "closed" }
type Directory = { readonly path: string; readonly fd: number; stat: BigIntStats; readonly mount: string; readonly private: boolean };
const jobs = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs";
let issued = false;
enum CreatorEffect { LockLeaseCreation = "lock_lease_creation", LockTempCreation = "lock_temp_creation",
  LockTempRemoval = "lock_temp_removal", LockLeaseRemoval = "lock_lease_removal" }
let creatorEffect: Readonly<{ kind: CreatorEffect; sequence: number }> | undefined;
let creatorSequence = 0;
// Partial creation retains its exact original FD custody even before selectors
// can be published. It is never inferred released or reconstructed on retry.
let creatingDirectories: Directory[] | undefined;
let allocation: { phase: AllocationPhase; selectors: OriginalHostedProjectControlAllocation;
  directories: Directory[]; parent: Directory; ownerBirth: string } | undefined;
let sourceFixtureIssued = false;
const sourceFixtureDescriptors = new Set<number>();
function check(value: unknown): asserts value { if (!value) throw new Error("hosted_original_control_allocation_held"); }
function mount(fd: number): string {
  const bytes = readFileSync("/proc/self/fdinfo/" + fd); check(bytes.length <= 4096);
  const rows = [...bytes.toString("ascii").matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  check(rows.length === 1); return rows[0]![1]!;
}
function ownerBirth(): string {
  const bytes = readFileSync("/proc/self/stat"); check(bytes.length <= 4096);
  const raw = bytes.toString("utf8"), fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/);
  check(raw.startsWith(process.pid + " (") && !["Z", "X", "x"].includes(fields[0] ?? "") && /^[1-9][0-9]*$/.test(fields[19] ?? ""));
  return process.pid + ":" + fields[19];
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
}
function validate(directory: Directory): void {
  const { path, fd, stat, private: privateLeaf } = directory, held = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
  check(held.isDirectory() && !named.isSymbolicLink() && stable(stat, held) && stable(stat, named) &&
    held.uid === 0n && held.gid === 0n && (held.mode & 0o022n) === 0n &&
    (!privateLeaf || (held.mode & 0o7777n) === 0o700n) && realpathSync(path) === path && mount(fd) === directory.mount);
  const fs = statfsSync("/proc/self/fd/" + fd, { bigint: true });
  check(fs.type !== 0x9fa0n && fs.type !== 0x63677270n && fs.type !== 0x62656572n);
  const raw = readFileSync("/proc/self/mountinfo"); check(raw.length <= 1024 * 1024);
  const rows = raw.toString("utf8").trim().split("\n").filter(row => row.split(" ")[0] === directory.mount);
  check(rows.length === 1);
  const options = rows[0]!.split(" ")[5]!.split(",");
  check(options.includes("rw") || options.includes("ro"));
  if (privateLeaf) check(options.includes("rw"));
}
function retain(path: string, privateLeaf: boolean): Directory {
  assertOriginalFullProjectControlSetupCurrent();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directory = { path, fd, stat: fstatSync(fd, { bigint: true }), mount: mount(fd), private: privateLeaf };
    validate(directory); return directory;
  } catch (error) { closeSync(fd); throw error; }
}
function current(): NonNullable<typeof allocation> {
  try {
    assertOriginalFullProjectControlSetupCurrent(); check(allocation && allocation.phase === AllocationPhase.Reserved && creatorEffect === undefined && allocation.ownerBirth === ownerBirth());
    assertPublicationWitnessesCurrent();
    for (const directory of allocation.directories) validate(directory);
    if (gitWorkspace) validate(gitWorkspace);
    check(gitEffect === undefined);
    assertOriginalFullProjectControlSetupCurrent(); return allocation;
  } catch (error) {
    if (allocation) allocation.phase = AllocationPhase.Held;
    throw error;
  }
}
function create(parent: Directory, leaf: string, directories: Directory[]): Directory {
  assertOriginalFullProjectControlSetupCurrent(); validate(parent); check(/^[A-Za-z0-9_.-]{1,128}$/.test(leaf));
  // Exclusive creation THROUGH the retained actual parent, with no EEXIST
  // adoption, recursive mkdir, chmod, cleanup or replacement.
  mkdirSync("/proc/self/fd/" + parent.fd + "/" + leaf, { mode: 0o700 });
  const child = retain(parent.path + "/" + leaf, true); directories.push(child);
  check(child.stat.dev === parent.stat.dev && child.mount === parent.mount);
  const after = fstatSync(parent.fd, { bigint: true }), before = parent.stat;
  check(before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid &&
    before.gid === after.gid && after.nlink === before.nlink + 1n);
  parent.stat = after; // Only this positively joined exclusive mkdir advances it.
  validate(parent); validate(child); assertOriginalFullProjectControlSetupCurrent(); fsyncSync(child.fd);
  assertOriginalFullProjectControlSetupCurrent(); fsyncSync(parent.fd);
  assertOriginalFullProjectControlSetupCurrent(); return child;
}

/** Sole canonical allocation issuer. Its path recipe and random TEST id come
 * from this original producer, never a caller's root, registration or DTO. */
export function prepareOriginalHostedProjectControlAllocation(): OriginalHostedProjectControlAllocation {
  assertOriginalFullProjectControlSetupCurrent(); check(!issued); issued = true;
  const directories: Directory[] = [];
  creatingDirectories = directories;
  try {
    const ancestors: string[] = [];
    for (let path = jobs;; path = dirname(path)) { ancestors.unshift(path); if (path === "/") break; }
    for (const path of ancestors) directories.push(retain(path, path.startsWith("/var/lib/subscription-runtime-host-policy")));
    const parent = directories[directories.length - 1]!;
    const jobId = "TEST-sdk-" + randomUUID(), root = create(parent, jobId, directories);
    const source = create(root, "source", directories), auth = create(root, "auth", directories), state = create(root, "state", directories);
    const registry = create(state, "registry", directories);
    const reviewed = create(state, "reviewed-worker-outputs", directories), locks = create(reviewed, ".locks", directories);
    create(locks, "workspace-locks", directories);
    const controller = create(root, "controller", directories), handoffs = create(root, "durable-handoffs", directories);
    create(registry, "TEST-standalone-controller", directories); create(registry, jobId, directories);
    const selectors = Object.freeze({ jobId, jobRootDir: root.path, source: source.path, auth: auth.path,
      controllerId: "TEST-standalone-controller", controllerRoot: controller.path, registry: registry.path,
      workspace: root.path + "/workspace", durableHandoffs: handoffs.path });
    try { lstatSync(selectors.workspace); check(false); }
    catch (error) { check(error instanceof Error && "code" in error && error.code === "ENOENT"); }
    allocation = { phase: AllocationPhase.Reserved, selectors, directories, parent, ownerBirth: ownerBirth() };
    current(); creatingDirectories = undefined; return selectors;
  } catch (error) {
    // Creation history and held descriptors are preserved. Unknown creation can
    // never retry, adopt a root or become a released writer by absence.
    if (allocation) allocation.phase = AllocationPhase.Held;
    throw error;
  }
}

/** Fixed TEST source only. No caller supplies a path, bytes or a replacement
 * root; partial creation retains custody and cannot replay or roll back. */
export function prepareOriginalHostedProjectControlSourceFixture(): void {
  const own = current();
  try {
    check(!sourceFixtureIssued); sourceFixtureIssued = true;
    const source = own.directories.find(row => row.path === own.selectors.source); check(source);
    const before = childCensus(source), bytes = Buffer.from("Original public standalone SDK Source fixture.\n");
    check(before.size === 0);
    const path = "/proc/self/fd/" + source.fd + "/README.md";
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    sourceFixtureDescriptors.add(fd);
    const initial = fstatSync(fd, { bigint: true });
    check(initial.isFile() && initial.uid === 0n && initial.gid === 0n && initial.mode === 0o100600n && initial.nlink === 1n && initial.size === 0n);
    for (let offset = 0; offset < bytes.length;) {
      assertOriginalFullProjectControlSetupCurrent();
      const count = writeSync(fd, bytes, offset, bytes.length - offset); check(count > 0); offset += count;
    }
    fsyncSync(fd); fsyncSync(source.fd);
    const final = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    check(final.dev === initial.dev && final.ino === initial.ino && final.mode === initial.mode && final.uid === 0n && final.gid === 0n && final.nlink === 1n && final.size === BigInt(bytes.length) &&
      named.isFile() && named.dev === final.dev && named.ino === final.ino && named.mode === final.mode && named.size === final.size && named.ctimeNs === final.ctimeNs && readFileSync(path).equals(bytes));
    exactDelta(before, childCensus(source), "README.md", true); check(current() === own);
    closeSync(fd); let closed = false;
    try { fstatSync(fd); } catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); closed = true; }
    check(closed); sourceFixtureDescriptors.delete(fd); check(current() === own);
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}


/** Exact child census for a privately held original parent. It cannot enroll a
 * changed inode; each entry is read through that actual retained directory FD. */
function childCensus(parent: Directory): ReadonlyMap<string, string> {
  assertOriginalFullProjectControlSetupCurrent();
  const names = readdirSync("/proc/self/fd/" + parent.fd); check(names.length <= 256);
  const rows = new Map<string, string>();
  for (const name of names.sort()) {
    assertOriginalFullProjectControlSetupCurrent(); check(name !== "." && name !== ".." && !name.includes("/"));
    const stat = lstatSync("/proc/self/fd/" + parent.fd + "/" + name, { bigint: true });
    rows.set(name, [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(":"));
  }
  assertOriginalFullProjectControlSetupCurrent(); return rows;
}
function joinedChildren(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, leaf: Directory, created: boolean): void {
  const name = basename(leaf.path), expected = [leaf.stat.dev, leaf.stat.ino, leaf.stat.mode, leaf.stat.uid, leaf.stat.gid].join(":");
  check(created ? !before.has(name) && after.get(name) === expected : before.get(name) === expected && !after.has(name));
  check(after.size === before.size + (created ? 1 : -1));
  for (const [other, value] of before) if (other !== name) check(after.get(other) === value);
}
function creatorCurrent(own: NonNullable<typeof allocation>, excluding?: Directory): void {
  assertOriginalFullProjectControlSetupCurrent();
  check(own === allocation && own.phase === AllocationPhase.Reserved && own.ownerBirth === ownerBirth() && creatorEffect);
  for (const row of own.directories) if (row !== excluding) validate(row);
  assertOriginalFullProjectControlSetupCurrent();
}
function createLockDirectory(own: NonNullable<typeof allocation>, parent: Directory, leaf: string, kind: CreatorEffect): Directory {
  check(current() === own); creatorEffect = Object.freeze({ kind, sequence: ++creatorSequence });
  try {
    const before = childCensus(parent), child = create(parent, leaf, own.directories);
    joinedChildren(before, childCensus(parent), child, true); creatorCurrent(own);
    creatorEffect = undefined; check(current() === own); return child;
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}
function removeLockDirectory(own: NonNullable<typeof allocation>, parent: Directory, child: Directory, kind: CreatorEffect): void {
  check(current() === own); creatorEffect = Object.freeze({ kind, sequence: ++creatorSequence });
  try {
    const before = childCensus(parent); check(childCensus(child).size === 0);
    creatorCurrent(own); const parentBefore = parent.stat;
    assertOriginalFullProjectControlSetupCurrent(); rmdirSync("/proc/self/fd/" + parent.fd + "/" + basename(child.path));
    const after = fstatSync(parent.fd, { bigint: true });
    check(after.dev === parentBefore.dev && after.ino === parentBefore.ino && after.mode === parentBefore.mode &&
      after.uid === parentBefore.uid && after.gid === parentBefore.gid && after.nlink === parentBefore.nlink - 1n);
    joinedChildren(before, childCensus(parent), child, false); parent.stat = after;
    // The removed original FD is still held here; no named absence supplies a
    // release witness or permits a replacement child to be adopted.
    const retained = fstatSync(child.fd, { bigint: true });
    check(retained.dev === child.stat.dev && retained.ino === child.stat.ino && retained.nlink === 0n && mount(child.fd) === child.mount);
    creatorCurrent(own, child); assertOriginalFullProjectControlSetupCurrent(); fsyncSync(parent.fd);
    creatorCurrent(own, child); assertOriginalFullProjectControlSetupCurrent(); closeSync(child.fd);
    let closed = false; try { fstatSync(child.fd); }
    catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); closed = true; }
    const index = own.directories.indexOf(child); check(closed && index >= 0); own.directories.splice(index, 1);
    creatorEffect = undefined; check(current() === own);
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}
const originalLockLeases = new WeakMap<object, Readonly<{ current(): void; temporary(): LocalOwnedWorkspaceLockTemporary; remove(): void }>>();
const originalLockTemps = new WeakMap<object, Readonly<{ current(): void; remove(): void }>>();
const pendingLockLeases = new Set<Directory>();
/** Consumers provide selection DATA only. This port exists solely for the
 * originally issued live allocation; absence or held history cannot fall back
 * to an ordinary creator for the same selected registry. */
export function originalHostedProjectControlLockLifecycle(registryRootDir: string): LocalWorkspaceLockDirectoryLifecycle | undefined {
  if (!allocation || registryRootDir !== allocation.selectors.registry) return undefined;
  const own = current(), selected = own.selectors;
  const parent = own.directories.find(row => row.path === dirname(selected.registry) + "/reviewed-worker-outputs/.locks/workspace-locks"); check(parent);
  return Object.freeze({
    hold() { check(own === allocation); own.phase = AllocationPhase.Held; },
    createLease(workspacePath: string): LocalOwnedWorkspaceLockDirectory {
      try {
        check(current() === own && [selected.source, selected.workspace, selected.registry, selected.registry + "/.manifest-mutation"].includes(workspacePath));
        const directory = createLockDirectory(own, parent, researchHash(workspacePath), CreatorEffect.LockLeaseCreation);
        pendingLockLeases.add(directory); let active = true; const temps = new Set<Directory>();
        const assertCurrent = () => { check(active && pendingLockLeases.has(directory) && current() === own); validate(directory); };
        const receiver: LocalOwnedWorkspaceLockDirectory = Object.freeze({ path: directory.path,
          assertCurrent() { const state = originalLockLeases.get(this); check(state); state.current(); },
          createTemporary() { const state = originalLockLeases.get(this); check(state); return state.temporary(); },
          remove() { const state = originalLockLeases.get(this); check(state); state.remove(); },
        });
        originalLockLeases.set(receiver, Object.freeze({ current: assertCurrent,
          temporary() {
            try {
              assertCurrent(); const temp = createLockDirectory(own, directory, ".tmp-" + randomUUID(), CreatorEffect.LockTempCreation);
              temps.add(temp); let tempActive = true;
              const tempCurrent = () => { check(tempActive && temps.has(temp)); assertCurrent(); validate(temp); };
              const temporary: LocalOwnedWorkspaceLockTemporary = Object.freeze({ path: temp.path,
                assertCurrent() { const state = originalLockTemps.get(this); check(state); state.current(); },
                remove() { const state = originalLockTemps.get(this); check(state); state.remove(); },
              });
              originalLockTemps.set(temporary, Object.freeze({ current: tempCurrent, remove() {
                try { tempCurrent(); removeLockDirectory(own, directory, temp, CreatorEffect.LockTempRemoval); tempActive = false;
                  temps.delete(temp); originalLockTemps.delete(temporary); }
                catch (error) { own.phase = AllocationPhase.Held; throw error; }
              } })); return temporary;
            } catch (error) { own.phase = AllocationPhase.Held; throw error; }
          },
          remove() {
            try { assertCurrent(); check(temps.size === 0); removeLockDirectory(own, parent, directory, CreatorEffect.LockLeaseRemoval);
              active = false; pendingLockLeases.delete(directory); originalLockLeases.delete(receiver); }
            catch (error) { own.phase = AllocationPhase.Held; throw error; }
          },
        })); return receiver;
      } catch (error) { own.phase = AllocationPhase.Held; throw error; }
    },
  });
}

/** Negative invalidation only; no caller facts can restore this original owner. */
export function holdOriginalHostedProjectControlAllocationError(): void {
  if (allocation) allocation.phase = AllocationPhase.Held;
}

/** Exact original in-process applicability; copied selectors confer nothing.
 * This read never changes a phase, creates a root or releases a writer. */
export function assertOriginalHostedProjectControlAllocationCurrent(): void { current(); }

/** Factual original allocation projection for its protected-birth publisher.
 * No caller supplies the root/epoch/identity. Publication bytes alone cannot
 * reconstruct the private live allocation or its NativeEntryLive premise. */
export function originalHostedProjectControlAllocationPublication(): Readonly<{
  schemaVersion: 2; ownerBirth: string; selectors: OriginalHostedProjectControlAllocation;
  directories: readonly Readonly<{ path: string; device: string; inode: string; mountId: string }>[];
}> {
  const own = current();
  return Object.freeze({ schemaVersion: 2, ownerBirth: own.ownerBirth, selectors: own.selectors,
    directories: Object.freeze(own.directories.filter(row => row.path === own.selectors.jobRootDir || row.path.startsWith(own.selectors.jobRootDir + "/"))
      .map(row => Object.freeze({ path: row.path, device: String(row.stat.dev), inode: String(row.stat.ino), mountId: row.mount }))) });
}


export enum OriginalControlAllocationRecordKind { Allocation = "original_control_allocation_v2", Publication = "original_control_publication_v2" }
export enum OriginalControlAllocationRecordRole { Job = "job", Controller = "controller" }
enum OriginalBirthRole { Controller = "controller", Child = "child" }
declare const originalBirthClaimBrand: unique symbol;
export type OriginalHostedProjectControlBirthClaim = Readonly<{ [originalBirthClaimBrand]: true }>;
type BirthClaimState = { readonly role: OriginalBirthRole; readonly owner: NonNullable<typeof allocation>; active: boolean };
const birthClaims = new WeakMap<object, BirthClaimState>();
const claimedBirthRoles = new Set<OriginalBirthRole>();
// Unknown publication descriptors are retained even if no role can complete.
const publicationDescriptors: number[] = [];
const publicationWitnesses = new Map<OriginalBirthRole, Readonly<{
  lexical: string; physical: string; bytes: Buffer; manifestPath: string; manifest: Buffer; manifestFd: number; manifestStat: BigIntStats;
}>>();
function assertPublicationWitnessesCurrent(): void {
  try {
    for (const witness of publicationWitnesses.values()) {
      check(witness.bytes.equals(researchRead(witness.lexical)) && witness.bytes.equals(researchRead(witness.physical)) &&
        witness.manifest.equals(publicationManifest(witness.manifestPath, witness.manifestFd, witness.manifestStat)));
    }
  } catch (error) { if (allocation) allocation.phase = AllocationPhase.Held; throw error; }
}
/** A public manifest is selection DATA. Only the actual original private
 * allocation can consume its exact once-only controller or child reservation.
 * This capability does not grant a Git operation or assert writer release. */
export function claimOriginalHostedProjectControlBirth(input: Readonly<{
  jobId: string; taskId: string; jobRootDir: string; workspacePath: string;
  authRootDir?: string; registryRootDir: string;
}>): OriginalHostedProjectControlBirthClaim {
  const own = current(), selected = own.selectors;
  check(input.registryRootDir === selected.registry && input.authRootDir === selected.auth && input.taskId === input.jobId);
  const role = input.jobId === selected.controllerId && input.jobRootDir === selected.controllerRoot && input.workspacePath === selected.source
    ? OriginalBirthRole.Controller : input.jobId === selected.jobId && input.jobRootDir === selected.jobRootDir && input.workspacePath === selected.workspace
      ? OriginalBirthRole.Child : undefined;
  check(role && !claimedBirthRoles.has(role));
  claimedBirthRoles.add(role); // Failed/uncertain preparation is not replayable.
  const claim = Object.freeze({}) as OriginalHostedProjectControlBirthClaim;
  birthClaims.set(claim, { role, owner: own, active: true }); return claim;
}
/** Negative route selection only, including an already held allocation. A
 * caller path never supplies the retained allocation or a preparation claim. */
export function originalHostedProjectControlBirthRootPresent(path: string): boolean {
  return allocation !== undefined && [allocation.selectors.jobRootDir, allocation.selectors.controllerRoot].includes(path);
}
/** Negative canonical route selection, including held/closed history. It grants
 * no scope and never adopts a caller path or a discovered inode. */
export function originalHostedProjectControlAllocationPathPresent(path: string): boolean {
  return allocation !== undefined && (path === allocation.selectors.jobRootDir || path.startsWith(allocation.selectors.jobRootDir + "/"));
}
/** Factual role selection under current original custody. The returned enum
 * grants no effect; the producer independently revalidates the private owner
 * and the actual protected child-publication witness before execution. */
export function originalHostedProjectControlGitRoleForPath(path: string): OriginalControlGitRole {
  const own = current();
  if (path === own.selectors.source) return OriginalControlGitRole.Source;
  check(path === own.selectors.workspace && gitWorkspace);
  return publicationWitnesses.has(OriginalBirthRole.Child) ? OriginalControlGitRole.PublishedChild : OriginalControlGitRole.CreatedChild;
}
/** Exact private registry budget veto. Existing writer authorization remains
 * independent; no caller registry root can construct an allocation. */
export function assertOriginalHostedProjectControlRegistryBudgetCurrent(registryRootDir: string): void {
  if (allocation && registryRootDir === allocation.selectors.registry) current();
}
export function assertOriginalHostedProjectControlBirthClaimCurrent(claim: OriginalHostedProjectControlBirthClaim): void {
  const state = birthClaims.get(claim);
  try { check(state && state.active && current() === state.owner && claimedBirthRoles.has(state.role)); }
  catch (error) { if (state && state.owner === allocation) state.owner.phase = AllocationPhase.Held; throw error; }
}
/** Negative-only invalidation of an actually issued claim, including one
 * already consumed. It cannot create authority, reset a phase or close custody. */
export function holdOriginalHostedProjectControlBirthClaim(claim: OriginalHostedProjectControlBirthClaim): void {
  const state = birthClaims.get(claim); check(state && state.owner === allocation);
  state.active = false; state.owner.phase = AllocationPhase.Held;
}
/** Descriptor comparison only against an already retained original directory.
 * Neither an fd number nor a caller path can enroll new directory custody. */
export function assertOriginalHostedProjectControlBirthDirectoryDescriptorCurrent(
  claim: OriginalHostedProjectControlBirthClaim, path: string, fd: number,
): void {
  assertOriginalHostedProjectControlBirthClaimCurrent(claim);
  const state = birthClaims.get(claim)!;
  try {
    const selected = state.owner.directories.find(row => row.path === path); check(selected);
    const actual = fstatSync(fd, { bigint: true });
    check(actual.isDirectory() && stable(actual, selected.stat) && mount(fd) === selected.mount &&
      realpathSync("/proc/self/fd/" + fd) === path);
    assertOriginalHostedProjectControlBirthClaimCurrent(claim);
  } catch (error) { state.owner.phase = AllocationPhase.Held; throw error; }
}
function publicationSignature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");
}
function publicationManifest(path: string, fd: number, selected: BigIntStats): Buffer {
  check(publicationSignature(fstatSync(fd, { bigint: true })) === publicationSignature(selected) &&
    publicationSignature(lstatSync(path, { bigint: true })) === publicationSignature(selected) && realpathSync(path) === path);
  const buffer = Buffer.alloc(Number(selected.size)); let position = 0;
  while (position < buffer.length) { const size = readSync(fd, buffer, position, buffer.length - position, position); check(size > 0); position += size; }
  check(publicationSignature(fstatSync(fd, { bigint: true })) === publicationSignature(selected) &&
    publicationSignature(lstatSync(path, { bigint: true })) === publicationSignature(selected));
  return buffer;
}
export function consumeOriginalHostedProjectControlBirthClaim(claim: OriginalHostedProjectControlBirthClaim): void {
  assertOriginalHostedProjectControlBirthClaimCurrent(claim);
  const state = birthClaims.get(claim)!, own = state.owner, selectors = own.selectors;
  // Consumption starts before any publication read; an uncertain attempt cannot
  // re-read a replacement witness or retry the same claim.
  state.active = false;
  try {
  const root = state.role === OriginalBirthRole.Controller ? selectors.controllerRoot : selectors.jobRootDir;
  const workspace = state.role === OriginalBirthRole.Controller ? selectors.source : selectors.workspace;
  const jobId = state.role === OriginalBirthRole.Controller ? selectors.controllerId : selectors.jobId;
  const identity = own.directories.find(row => row.path === root); check(identity);
  const prefix = researchAuthorityRoot + "/job-births/", lexicalBase = prefix + researchHash(root),
    physicalBase = prefix + "physical-" + identity.stat.dev + "-" + identity.stat.ino;
  const lexical = lexicalBase + ".control-publication-v2.json", physical = physicalBase + ".control-publication-v2.json";
  const data = researchRead(lexical); check(data.equals(researchRead(physical)));
  const record: unknown = researchJson(data); check(record && typeof record === "object" && !Array.isArray(record));
  const row = record as Record<string, unknown>;
  check(row.schemaVersion === 2 && row.kind === OriginalControlAllocationRecordKind.Publication && row.jobId === jobId &&
    row.manifestPath === selectors.registry + "/" + jobId + "/job.json" &&
    isDeepStrictEqual(row.originalAllocation, originalHostedProjectControlAllocationPublication()) &&
    isDeepStrictEqual(row.jobDirectory, { path: root, device: Number(identity.stat.dev), inode: Number(identity.stat.ino) }));
  const allocationBytes = researchRead(lexicalBase + ".control-allocation-v2.json");
  check(allocationBytes.equals(researchRead(physicalBase + ".control-allocation-v2.json")));
  const allocationRecord: unknown = researchJson(allocationBytes); check(allocationRecord && typeof allocationRecord === "object" && !Array.isArray(allocationRecord));
  const initial = allocationRecord as Record<string, unknown>;
  check(initial.schemaVersion === 2 && initial.kind === OriginalControlAllocationRecordKind.Allocation &&
    initial.role === (state.role === OriginalBirthRole.Controller ? OriginalControlAllocationRecordRole.Controller : OriginalControlAllocationRecordRole.Job) &&
    initial.artifactSha256 === row.artifactSha256 && initial.runtimeDirectory === row.runtimeDirectory &&
    isDeepStrictEqual(initial.originalAllocation, row.originalAllocation));
  const manifestPath = String(row.manifestPath), manifestFd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  publicationDescriptors.push(manifestFd);
  const manifestStat = fstatSync(manifestFd, { bigint: true });
  check(manifestStat.isFile() && manifestStat.uid === 0n && manifestStat.gid === 0n && manifestStat.nlink === 1n &&
    (manifestStat.mode & 0o7777n) === 0o600n && manifestStat.size <= 1024n * 1024n);
  const manifest = publicationManifest(manifestPath, manifestFd, manifestStat);
  const actual: unknown = researchJson(manifest); check(actual && typeof actual === "object" && !Array.isArray(actual));
  const job = actual as Record<string, unknown>;
  check(job.jobId === jobId && job.taskId === jobId && job.jobRootDir === root && job.workspacePath === workspace &&
    job.authRootDir === selectors.auth && job.createdAt === row.createdAt &&
    row.manifest && typeof row.manifest === "object" && "sha256" in row.manifest && row.manifest.sha256 === researchHash(manifest) &&
    "signature" in row.manifest && row.manifest.signature === publicationSignature(manifestStat));
  check(current() === own);
  check(data.equals(researchRead(lexical)) && data.equals(researchRead(physical)) && manifest.equals(publicationManifest(manifestPath, manifestFd, manifestStat)));
  publicationWitnesses.set(state.role, Object.freeze({ lexical, physical, bytes: Buffer.from(data), manifestPath, manifest: Buffer.from(manifest), manifestFd, manifestStat }));
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}

/** Original allocator terminal closure only. Incomplete/unknown publication
 * retains every FD and remains Held; neither a JSON success flag nor absence
 * can trigger this transition. The outer SDKComplete census remains mandatory. */
export function closeOriginalHostedProjectControlAllocation(): void {
  const own = current();
  try {
  check(pendingLockLeases.size === 0 && creatorEffect === undefined && gitEffect === undefined && creatingWorkspaceDirectories === undefined && sourceFixtureDescriptors.size === 0 && workspaceDescriptors.size === (gitWorkspace ? 1 : 0));
  check(publicationWitnesses.size === 2 && claimedBirthRoles.size === 2 &&
    [OriginalBirthRole.Controller, OriginalBirthRole.Child].every(role => publicationWitnesses.has(role)));
  assertPublicationWitnessesCurrent();
  own.phase = AllocationPhase.Held;
  check(publicationDescriptors.length === 2);
  const closeErrors:unknown[]=[];
  for (const fd of [...publicationDescriptors].reverse().concat([...(gitWorkspace ? [gitWorkspace] : []), ...own.directories.slice().reverse()].map(row => row.fd))) {
    try {
      closeSync(fd);let positivelyClosed=false;
      try{fstatSync(fd);}catch(error){check(error instanceof Error&&"code"in error&&error.code==="EBADF");positivelyClosed=true;}
      check(positivelyClosed);workspaceDescriptors.delete(fd);
    }catch(error){closeErrors.push(error);}
  }
  if(closeErrors.length)throw new AggregateError(closeErrors,"hosted_original_allocation_close_held");
  assertOriginalFullProjectControlSetupCurrent(); own.phase = AllocationPhase.Closed;
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}

// Git-created workspace custody is additional to the immutable original
// publication projection. No later directory is enrolled in its sealed roles.
let gitWorkspace: Directory | undefined;
let creatingWorkspaceDirectories: Directory[] | undefined;
const workspaceDescriptors = new Set<number>();
let gitEffectSequence=0;
let gitEffect: Readonly<{sequence:number;owner:NonNullable<typeof allocation>;role:OriginalControlGitRole;operation:OriginalControlGitOperation;revision:string|null;
  affected:Directory;before:ReadonlyMap<string,string>;stat:BigIntStats}> | undefined;
function identity(a:BigIntStats,b:BigIntStats):boolean { return a.dev===b.dev && a.ino===b.ino && a.mode===b.mode && a.uid===b.uid && a.gid===b.gid; }
function gitCurrent(): NonNullable<typeof gitEffect> {
  assertOriginalFullProjectControlSetupCurrent(); const effect=gitEffect;
  check(effect && effect.owner===allocation && effect.owner.phase===AllocationPhase.Reserved && effect.owner.ownerBirth===ownerBirth());
  assertPublicationWitnessesCurrent();
  if (effect.role !== OriginalControlGitRole.Source) check(effect.role ===
    (publicationWitnesses.has(OriginalBirthRole.Child) ? OriginalControlGitRole.PublishedChild : OriginalControlGitRole.CreatedChild));
  for(const directory of [...effect.owner.directories,...(gitWorkspace ? [gitWorkspace] : [])]) {
    if(directory===effect.affected || effect.operation===OriginalControlGitOperation.RemoveLinked && directory===gitWorkspace) {
      const held=fstatSync(directory.fd,{bigint:true}); check(identity(directory.stat,held)&&mount(directory.fd)===directory.mount);
      if(directory!==gitWorkspace || effect.operation!==OriginalControlGitOperation.RemoveLinked) check(identity(held,lstatSync(directory.path,{bigint:true}))&&realpathSync(directory.path)===directory.path);
    } else validate(directory);
  }
  assertOriginalFullProjectControlSetupCurrent(); return effect;
}
/** Only facts from the in-flight actual allocator call. Reading these pins does
 * not begin an operation or provide a caller-selected native authority. */
export function originalHostedProjectControlGitEffectFacts(role:OriginalControlGitRole,operation:OriginalControlGitOperation,revision:string|null):Readonly<{
  sequence:number;id:string;source:string;workspace:string;descriptors:readonly Readonly<{fd:number;dev:string;ino:string;mount:string;directory:boolean}>[];
}> {
  const effect=gitCurrent(); check(effect.role===role&&effect.operation===operation&&effect.revision===revision);
  const own=effect.owner; return Object.freeze({sequence:effect.sequence,id:own.selectors.jobId.slice("TEST-sdk-".length),source:own.selectors.source,workspace:own.selectors.workspace,
    descriptors:Object.freeze([...own.directories,...(gitWorkspace?[gitWorkspace]:[])].map(row=>Object.freeze({fd:row.fd,dev:String(row.stat.dev),ino:String(row.stat.ino),mount:row.mount,directory:true as boolean})).concat(publicationDescriptors.map(fd=>{const stat=fstatSync(fd,{bigint:true});return Object.freeze({fd,dev:String(stat.dev),ino:String(stat.ino),mount:mount(fd),directory:false as boolean});}))) });
}
/** Private in-flight selection only; every pre-gate check still requires the
 * original membership and nlink, before any Git mutation can be authorized. */
export function assertOriginalHostedProjectControlGitPreludeCurrent():void {
  const effect=gitCurrent();check(stable(effect.stat,fstatSync(effect.affected.fd,{bigint:true}))&&isDeepStrictEqual(effect.before,childCensus(effect.affected)));
  if(gitWorkspace)validate(gitWorkspace);
}
/** SDK peer observation is applicable only to this privately reserved effect. */
export function assertOriginalHostedProjectControlGitPeerQueryCurrent():void {gitCurrent();assertOriginalHostedProjectControlGitPreludeCurrent();}
function exactDelta(before:ReadonlyMap<string,string>,after:ReadonlyMap<string,string>,name:string,created:boolean):void {
  check(created ? !before.has(name)&&after.has(name) : before.has(name)&&!after.has(name));
  check(after.size===before.size+(created?1:-1)); for(const [key,value]of before) if(key!==name) check(after.get(key)===value);
}
/** Finite DATA API: its direct await binds the mutation join to the actual
 * original producer's native wait, stream, task/cgroup and queued FD drain. */
export async function runOriginalHostedProjectControlGit(role:OriginalControlGitRole,operation:OriginalControlGitOperation,revision:string|null=null):Promise<Readonly<{stdout:string;code:number;signal:string}>> {
  const own=current();
  try {
  check(!gitEffect); const root=own.directories.find(row=>row.path===own.selectors.jobRootDir),source=own.directories.find(row=>row.path===own.selectors.source); check(root&&source);
  const frame:OriginalControlGitFrame={id:own.selectors.jobId.slice(9),role,operation,revision,deadline:1n}; originalControlGitArguments(frame);
  if(role!==OriginalControlGitRole.Source) check(gitWorkspace && role ===
    (publicationWitnesses.has(OriginalBirthRole.Child) ? OriginalControlGitRole.PublishedChild : OriginalControlGitRole.CreatedChild));
  if(operation===OriginalControlGitOperation.AddLinked) check(!gitWorkspace);
  if(operation===OriginalControlGitOperation.RemoveLinked) check(gitWorkspace);
  const affected=operation===OriginalControlGitOperation.AddLinked||operation===OriginalControlGitOperation.RemoveLinked ? root : role===OriginalControlGitRole.Source?source:gitWorkspace!;
  gitEffect=Object.freeze({sequence:++gitEffectSequence,owner:own,role,operation,revision,affected,before:childCensus(affected),stat:affected.stat});
    gitCurrent(); const result=await runOriginalFullProjectControlGitChild(role,operation,revision); gitCurrent();
    check(result.signal===""&&(result.code===0||operation===OriginalControlGitOperation.Filters&&result.code===1));
    const effect=gitEffect!,after=childCensus(affected),now=fstatSync(affected.fd,{bigint:true}); check(identity(effect.stat,now));
    let nlinkDelta=0n;
    if(operation===OriginalControlGitOperation.InitSource||operation===OriginalControlGitOperation.InitChild) {
      exactDelta(effect.before,after,".git",true); const git=lstatSync("/proc/self/fd/"+affected.fd+"/.git",{bigint:true});
      check(git.isDirectory()&&git.uid===0n&&git.gid===0n&&!(git.mode&0o022n)); nlinkDelta=1n;
    } else if(operation===OriginalControlGitOperation.AddLinked) {
      exactDelta(effect.before,after,"workspace",true); nlinkDelta=1n;
      const fd=openSync(own.selectors.workspace,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);workspaceDescriptors.add(fd);
      gitWorkspace={path:own.selectors.workspace,fd,stat:fstatSync(fd,{bigint:true}),mount:mount(fd),private:false};
      check(gitWorkspace.stat.dev===root.stat.dev&&gitWorkspace.mount===root.mount);validate(gitWorkspace);
    } else if(operation===OriginalControlGitOperation.RemoveLinked) {
      exactDelta(effect.before,after,"workspace",false);nlinkDelta=-1n;check(gitWorkspace);
      const held=fstatSync(gitWorkspace.fd,{bigint:true}); check(identity(gitWorkspace.stat,held)&&held.nlink===0n&&mount(gitWorkspace.fd)===gitWorkspace.mount);
      closeSync(gitWorkspace.fd);let closed=false;try{fstatSync(gitWorkspace.fd);}catch(error){check(error instanceof Error&&"code"in error&&error.code==="EBADF");closed=true;}check(closed);workspaceDescriptors.delete(gitWorkspace.fd);gitWorkspace=undefined;
    } else if(operation===OriginalControlGitOperation.CheckoutChild) {
      exactDelta(effect.before,after,"README.md",true); const path="/proc/self/fd/"+affected.fd+"/README.md",file=lstatSync(path,{bigint:true});
      check(file.isFile()&&file.uid===0n&&file.gid===0n&&file.nlink===1n&&file.size<=65536n&&!(file.mode&0o022n));
      const expected=lstatSync(source.path+"/README.md",{bigint:true});check(expected.isFile()&&expected.size===file.size&&readFileSync(path).equals(readFileSync(source.path+"/README.md")));
    } else { check(isDeepStrictEqual(effect.before,after)); }
    check(now.nlink===effect.stat.nlink+nlinkDelta);affected.stat=now;gitEffect=undefined;check(current()===own);return result;
  } catch(error) {own.phase=AllocationPhase.Held;throw error;}
}
/** The standalone materializer selects this no-input creator only for the
 * genuine original allocation. Its effect cannot adopt an existing workspace. */
export function createOriginalHostedProjectControlWorkspace():string {
  const own=current(),root=own.directories.find(row=>row.path===own.selectors.jobRootDir);check(root&&!gitWorkspace);
  try {
    const before=childCensus(root);const rows:Directory[]=[];creatingWorkspaceDirectories=rows;gitWorkspace=create(root,"workspace",rows);workspaceDescriptors.add(gitWorkspace.fd);
    joinedChildren(before,childCensus(root),gitWorkspace,true);check(current()===own);creatingWorkspaceDirectories=undefined;return gitWorkspace.path;
  }catch(error){own.phase=AllocationPhase.Held;throw error;}
}
/** Empty rollback only. A failed/uncertain Git effect has already fenced this
 * path; it cannot be recursively removed or restored by caller absence. */
export function removeOriginalHostedProjectControlEmptyWorkspace():void {
  const own=current(),root=own.directories.find(row=>row.path===own.selectors.jobRootDir);check(root&&gitWorkspace&&childCensus(gitWorkspace).size===0);
  try {
    const before=childCensus(root),selected=gitWorkspace,stat=root.stat;rmdirSync("/proc/self/fd/"+root.fd+"/workspace");
    const after=fstatSync(root.fd,{bigint:true});check(identity(stat,after)&&after.nlink===stat.nlink-1n);
    joinedChildren(before,childCensus(root),selected,false);check(fstatSync(selected.fd,{bigint:true}).nlink===0n);
    closeSync(selected.fd);let closed=false;try{fstatSync(selected.fd);}catch(error){check(error instanceof Error&&"code"in error&&error.code==="EBADF");closed=true;}check(closed);
    root.stat=after;workspaceDescriptors.delete(selected.fd);gitWorkspace=undefined;check(current()===own);
  }catch(error){own.phase=AllocationPhase.Held;throw error;}
}
