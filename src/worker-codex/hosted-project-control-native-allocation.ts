import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, readSync, readdirSync, rmdirSync, statfsSync, type BigIntStats } from "node:fs";
import { dirname, basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { researchAuthorityRoot, researchHash, researchJson, researchRead } from "./research-launch-files.js";
import type { LocalOwnedWorkspaceLockDirectory, LocalOwnedWorkspaceLockTemporary,
  LocalWorkspaceLockDirectoryLifecycle } from "../store-local-file/safe-execution/adapters/local-safe-execution-state-store.js";
import { assertOriginalFullProjectControlSetupCurrent } from "./hosted-project-control-native-origin.js";

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
    for (const directory of allocation.directories) validate(directory);
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
  check(pendingLockLeases.size === 0 && creatorEffect === undefined);
  check(publicationWitnesses.size === 2 && claimedBirthRoles.size === 2 &&
    [OriginalBirthRole.Controller, OriginalBirthRole.Child].every(role => publicationWitnesses.has(role)));
  for (const witness of publicationWitnesses.values()) {
    check(witness.bytes.equals(researchRead(witness.lexical)) && witness.bytes.equals(researchRead(witness.physical)) &&
      witness.manifest.equals(publicationManifest(witness.manifestPath, witness.manifestFd, witness.manifestStat)));
  }
  own.phase = AllocationPhase.Held;
  check(publicationDescriptors.length === 2);
  for (const fd of [...publicationDescriptors].reverse().concat([...own.directories].reverse().map(row => row.fd))) {
    closeSync(fd);
    let positivelyClosed = false;
    try { fstatSync(fd); }
    catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); positivelyClosed = true; }
    check(positivelyClosed);
  }
  assertOriginalFullProjectControlSetupCurrent(); own.phase = AllocationPhase.Closed;
  } catch (error) { own.phase = AllocationPhase.Held; throw error; }
}
