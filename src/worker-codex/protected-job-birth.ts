import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import type { CodexGoalJobManifest, CodexGoalJobManifestInput } from "./codex-goal-jobs";
import { assertResearchInitialRoot, researchProcessIdentity } from "./research-launch-host";
import { originalHostedProjectControlAllocationPublication, originalHostedProjectControlBirthRootPresent, originalHostedProjectControlAllocationPathPresent, holdOriginalHostedProjectControlAllocationError,
  OriginalControlAllocationRecordKind, OriginalControlAllocationRecordRole, claimOriginalHostedProjectControlBirth, assertOriginalHostedProjectControlBirthClaimCurrent,
  consumeOriginalHostedProjectControlBirthClaim, holdOriginalHostedProjectControlBirthClaim, assertOriginalHostedProjectControlBirthDirectoryDescriptorCurrent, type OriginalHostedProjectControlBirthClaim } from "./hosted-project-control-native-allocation.js";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchCustody,
  researchDirectoryIdentity, researchHash, researchJson, researchPath, researchPrivateDirectory,
  researchPublish, researchRead, type ResearchDirectoryIdentity } from "./research-launch-files";

const birthRoot = join(researchAuthorityRoot, "job-births");
const publicationLock = join(birthRoot, "publication.lock");
const publicationContext = new AsyncLocalStorage<{ active: boolean }>();
// Only the actual protected publisher owns this dynamic extent. Async children
// retain the object but its private active bit is revoked when the callback ends.
const originalBirthEffects = new AsyncLocalStorage<{ active: boolean; claim: OriginalHostedProjectControlBirthClaim;
  jobRootDir: string; manifestPath: string; registryRootDir: string }>();
const runtimeDirectory = (): string => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const invalid = (): never => { throw new Error("protected_job_birth_authority_invalid"); };
function initialHost(): boolean {
  try { assertResearchInitialRoot(true); return true; } catch { return false; }
}
function privateRoot(assertCurrent?: () => void): void {
  for (const path of [researchAuthorityRoot, birthRoot]) {
    try { assertCurrent?.(); researchPrivateDirectory(path, assertCurrent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    researchCustody(path, true);
  }
}
function acquirePublication(assertCurrent?: () => void): () => void {
  privateRoot(assertCurrent);
  // Presence only refuses; the existing atomic link still arbitrates an absent-name race.
  try { lstatSync(publicationLock); throw new Error("protected_job_birth_publication_busy"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const nonce = randomUUID(), ownerPath = join(birthRoot, `.publication-${nonce}.owner.json`);
  const owner = { schemaVersion: 1, nonce, process: researchProcessIdentity() };
  // Fully write/fsync BEFORE publishing the name. An old mkdir owner remains
  // mutually exclusive; no crash can publish an anonymous new lock.
  researchPublish(ownerPath, owner, true, assertCurrent);
  try { assertCurrent?.(); linkSync(ownerPath, publicationLock); syncDirectory(birthRoot, assertCurrent); }
  catch (error) {
    // Publication could have succeeded before fsync failed: retain uncertainty.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") { assertCurrent?.(); unlinkSync(ownerPath); syncDirectory(birthRoot, assertCurrent); }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("protected_job_birth_publication_busy");
    throw error;
  }
  const identity = publicationFile(publicationLock), bytes = readFileSync(publicationLock);
  return () => {
    const current = publicationFile(publicationLock), staged = publicationFile(ownerPath);
    if (current.device !== identity.device || current.inode !== identity.inode ||
        staged.device !== identity.device || staged.inode !== identity.inode || !readFileSync(publicationLock).equals(bytes)) invalid();
    assertCurrent?.(); unlinkSync(publicationLock); syncDirectory(birthRoot, assertCurrent);
    assertCurrent?.(); unlinkSync(ownerPath); syncDirectory(birthRoot, assertCurrent);
  };
}
function publicationFile(path: string): ResearchDirectoryIdentity {
  researchCustody(path, true);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || stat.size < 1 || stat.nlink !== 2) invalid();
  return { path, device: stat.dev, inode: stat.ino };
}

const recoverPublication = String.raw`import fcntl,hashlib,json,os,re,stat,sys
def ident(s): return (s.st_dev,s.st_ino)
expected=(int(sys.argv[1]),int(sys.argv[2])); sha=sys.argv[3]
fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)
s=os.fstat(3)
assert ident(s)==expected and ident(os.stat('publication.lock',dir_fd=4,follow_symlinks=False))==expected
assert s.st_uid==0 and s.st_mode & 0o7777==0o600 and s.st_nlink==2 and 0<s.st_size<=16384
data=os.pread(3,16385,0); assert len(data)==s.st_size and hashlib.sha256(data).hexdigest()==sha
owner=json.loads(data); assert set(owner)=={'schemaVersion','nonce','process'} and owner['schemaVersion']==1
assert re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',owner['nonce'])
p=owner['process']; assert set(p)=={'pid','birthTicks','bootId','machineId','controlGroup','namespaces'}
assert type(p['pid']) is int and p['pid']>0 and re.fullmatch(r'[1-9][0-9]*',p['birthTicks'])
assert re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',p['bootId'])
assert p['machineId']==open('/etc/machine-id').read().strip()
ns=p['namespaces']; assert set(ns)=={'user','mnt','pid','net'}
for kind in ns: assert re.fullmatch(kind+r':\[[1-9][0-9]*\]',ns[kind])
group=p['controlGroup']; assert re.fullmatch(r'/(?:[A-Za-z0-9_.@+-]+/)*[A-Za-z0-9_.@+-]+|/',group)
assert all(part not in ('.','..') for part in group.split('/'))
boot=open('/proc/sys/kernel/random/boot_id').read().strip()
if boot==p['bootId']:
    for kind in ns: assert ns[kind]==os.readlink('/proc/1/ns/'+kind)
    try:
        proc_stat=open('/proc/'+str(p['pid'])+'/stat').read(); fields=proc_stat[proc_stat.rfind(')')+2:].split()
        assert fields[19]!=p['birthTicks'], 'owner_alive'
    except FileNotFoundError: pass
    group_path='/sys/fs/cgroup'+group.rstrip('/')
    try: group_info=os.stat(group_path)
    except FileNotFoundError: group_info=None
    if group_info is not None:
        assert stat.S_ISDIR(group_info.st_mode)
        events=[row.split() for row in open(group_path+'/cgroup.events').read().splitlines()]
        assert all(len(row)==2 and re.fullmatch(r'[a-z_]+',row[0]) and re.fullmatch(r'[0-9]+',row[1]) for row in events)
        populated=[row[1] for row in events if row[0]=='populated']
        assert populated==['0'], 'owner_cgroup_populated_or_unknown'
stage='.publication-'+owner['nonce']+'.owner.json'
assert ident(os.stat(stage,dir_fd=4,follow_symlinks=False))==expected
assert ident(os.stat('publication.lock',dir_fd=4,follow_symlinks=False))==expected and os.pread(3,16385,0)==data
os.unlink('publication.lock',dir_fd=4); os.fsync(4)
`;

/** Explicit operator recovery only. No callback, eviction timer, or admission
 * change; anonymous legacy directories and unknown owners remain untouched. */
export function recoverProtectedCodexGoalJobBirthPublication(expected: Readonly<{
  device: number; inode: number; ownerSha256: string;
}>): void {
  assertResearchInitialRoot(true); privateRoot();
  if (!Number.isSafeInteger(expected.device) || expected.device < 0 || !Number.isSafeInteger(expected.inode) ||
      expected.inode < 1 || !/^[a-f0-9]{64}$/.test(expected.ownerSha256)) invalid();
  const identity = publicationFile(publicationLock);
  if (identity.device !== expected.device || identity.inode !== expected.inode) invalid();
  researchCustody(realpathSync("/usr/bin/python3"));
  const fd = openSync(publicationLock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const parent = openSync(birthRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    execFileSync("/usr/bin/python3", ["-I", "-c", recoverPublication, String(expected.device), String(expected.inode), expected.ownerSha256],
      { env: {}, stdio: ["ignore", "ignore", "ignore", fd, parent], timeout: 5000 });
  } catch { throw new Error("protected_job_birth_publication_recovery_refused"); }
  finally { closeSync(parent); closeSync(fd); }
}
async function awaitPublication(assertCurrent?: () => void): Promise<() => void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    try { return acquirePublication(assertCurrent); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "protected_job_birth_publication_busy") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, remaining)));
      if (performance.now() >= deadline) throw error;
    }
  }
}

/** Short owner publication mutex, shared by final census/claim publication and
 * every first effect. It is never held for provider/manager work. A crashed
 * publisher retains uncertainty; bounded async acquisition never evicts it.
 * Only acquisition retries, before the effect is invoked exactly once.
 * Reentrancy is an in-process capability, never a caller-supplied flag. */
export async function withProtectedCodexGoalJobBirthPublication<T>(effect: () => Promise<T>): Promise<T> {
  let assertCurrent: (() => void) | undefined;
  if (!initialHost()) {
    // A genuine FULL allocation owns its separate original publication phase.
    // Failure never supplies ordinary initial-host/operator authority.
    try { originalHostedProjectControlAllocationPublication(); assertCurrent = () => { originalHostedProjectControlAllocationPublication(); }; }
    catch { return await effect(); }
  }
  assertCurrent?.();
  if (publicationContext.getStore()?.active) return await effect();
  const release = await awaitPublication(assertCurrent), context = { active: true };
  let failed = false, originalError: unknown;
  try { return await publicationContext.run(context, effect); }
  catch (error) { failed = true; originalError = error; throw error; }
  finally { context.active = false; try { release(); } catch (error) { if (failed) throw originalError; throw error; } }
}
/** Host composition must prepare foreign modules before entering publication. */
export function protectedCodexGoalJobBirthPublicationActive(): boolean {
  return publicationContext.getStore()?.active === true;
}
function synchronized<T>(effect: () => T, assertCurrent?: () => void): T {
  assertCurrent?.();
  if (publicationContext.getStore()?.active) return effect();
  const release = acquirePublication(assertCurrent);
  let failed = false, originalError: unknown;
  try { return effect(); } catch (error) { failed = true; originalError = error; throw error; }
  finally { try { release(); } catch (error) { if (failed) throw originalError; throw error; } }
}
function paths(jobRootDir: string): { birth: string; effect: string } {
  if (!isAbsolute(jobRootDir) || resolve(jobRootDir) !== jobRootDir || jobRootDir === "/" || jobRootDir.includes("\0")) invalid();
  const key = researchHash(jobRootDir);
  return { birth: join(birthRoot, key + ".json"), effect: join(birthRoot, key + ".first-effect.json") };
}

/** Absence is checked by the original birth producer under its publication mutex. */
export function assertProtectedCodexGoalJobBirthUnpublished(jobRootDir: string): void {
  assertResearchInitialRoot(true);
  if (!publicationContext.getStore()?.active) invalid();
  const logical = paths(jobRootDir), physical = physicalPaths(researchDirectoryIdentity(jobRootDir));
  for (const path of [logical.birth, logical.effect, physical.birth, physical.effect])
    if (optionalRecord(path) !== undefined) invalid();
}
function physicalPaths(identity: ResearchDirectoryIdentity): { birth: string; effect: string } {
  if (!Number.isSafeInteger(identity.device) || identity.device < 0 || !Number.isSafeInteger(identity.inode) || identity.inode < 1) invalid();
  const key = `physical-${identity.device}-${identity.inode}`;
  return { birth: join(birthRoot, key + ".json"), effect: join(birthRoot, key + ".first-effect.json") };
}
function controlAllocationPath(birth: string): string {
  return birth.replace(/\.json$/, ".control-allocation-v2.json");
}
let originalControlAllocationPublished = false;
/** New original allocation provenance in the existing protected-birth owner
 * namespace. No record DTO, root selector or private preparation escapes.
 * Retained bytes never replace the live private native allocation association. */
export function publishOriginalHostedProjectControlAllocation(): void {
  const original = originalHostedProjectControlAllocationPublication();
  if (originalControlAllocationPublished) return invalid();
  originalControlAllocationPublished = true; // Uncertain partial publication never retries.
  try { synchronized(() => {
    const current = originalHostedProjectControlAllocationPublication();
    if (!isDeepStrictEqual(current, original)) return invalid();
    const roles = [
      { path: original.selectors.jobRootDir, role: OriginalControlAllocationRecordRole.Job },
      { path: original.selectors.controllerRoot, role: OriginalControlAllocationRecordRole.Controller },
    ].map(role => {
      const root = original.directories.find(row => row.path === role.path); if (!root) return invalid();
      const identity: ResearchDirectoryIdentity = { path: root.path, device: Number(root.device), inode: Number(root.inode) };
      if (!Number.isSafeInteger(identity.device) || !Number.isSafeInteger(identity.inode) || identity.inode < 1) return invalid();
      assertResearchDirectory(identity); const lexical = paths(root.path), physical = physicalPaths(identity);
      for (const row of [lexical, physical]) {
        if (optionalRecord(row.birth) !== undefined || optionalRecord(row.effect) !== undefined ||
            optionalRecord(controlAllocationPath(row.birth)) !== undefined) return invalid();
      }
      return { identity, role: role.role, lexical, physical };
    });
    const record = { schemaVersion: 2, kind: OriginalControlAllocationRecordKind.Allocation,
      runtimeDirectory: runtimeDirectory(), artifactSha256: researchArtifactDigest(runtimeDirectory()),
      originalAllocation: original };
    originalHostedProjectControlAllocationPublication();
    for (const role of roles) {
      originalHostedProjectControlAllocationPublication(); assertResearchDirectory(role.identity);
      researchPublish(controlAllocationPath(role.lexical.birth), { ...record, role: role.role }, true, () => { originalHostedProjectControlAllocationPublication(); });
      researchPublish(controlAllocationPath(role.physical.birth), { ...record, role: role.role }, true, () => { originalHostedProjectControlAllocationPublication(); });
    }
    if (!isDeepStrictEqual(originalHostedProjectControlAllocationPublication(), original)) return invalid();
    for (const role of roles) assertResearchDirectory(role.identity);
  }, () => { originalHostedProjectControlAllocationPublication(); }); } catch (error) { holdOriginalHostedProjectControlAllocationError(); throw error; }
}
function optionalRecord(path: string): Buffer | undefined {
  try { return researchRead(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

/** Routing only: any retained birth/first-effect namespace keeps its controlled
 * route, including corrupt bytes. Presence never proves release or grants a
 * profile; only the cold owner reader below can supply positive authority. */
export function protectedCodexGoalJobBirthNamespacePresent(jobRootDir: string): boolean {
  const present = (path: string): boolean => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  try {
    const lexical = paths(jobRootDir);
    if (present(lexical.birth) || present(lexical.effect) || present(controlAllocationPath(lexical.birth))) return true;
    let identity: ResearchDirectoryIdentity;
    try { identity = firstEffectDirectoryIdentity(jobRootDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const physical = physicalPaths(identity);
    return present(physical.birth) || present(physical.effect) || present(controlAllocationPath(physical.birth));
  } catch { return true; }
}

/** Negative history must also cover legacy lexical spellings, including bind
 * aliases of a protected root. It never turns the observed directory into proof. */
function firstEffectDirectoryIdentity(path: string): ResearchDirectoryIdentity {
  if (realpathSync(path) !== path) invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), named = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(named);
      if (!stat.isDirectory() || stat.dev !== current.dev || stat.ino !== current.ino || realpathSync(path) !== path) invalid();
    } finally { closeSync(named); }
    return { path, device: stat.dev, inode: stat.ino };
  } finally { closeSync(fd); }
}

/** Permanent negative history, before a raw/controlled launch can write or
 * publish executable authority. A different job id or a public JSON rewrite
 * cannot restore the positive birth for this physical root's original path. */
export function recordProtectedCodexGoalJobFirstEffect(jobRootDir: string): void {
  if (!initialHost()) return;
  const effectRecords = () => {
    const records = [paths(jobRootDir)];
    try { records.push(physicalPaths(firstEffectDirectoryIdentity(jobRootDir))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return records;
  };
  // The original authorized claim already invalidated both exact roots under
  // publication. Later preparation needs no global mutex: negative history is
  // permanent, and every replay freshly resolves the named physical root.
  if (effectRecords().every(({ effect }) => optionalRecord(effect) !== undefined)) return;
  synchronized(() => {
    for (const { effect } of effectRecords()) {
      if (optionalRecord(effect) === undefined) {
        researchPublish(effect, { schemaVersion: 1, jobRootDir, firstEffectObserved: true }, true);
      }
    }
  });
}

type ManifestWitness = Readonly<{ signature: string; sha256: string }>;
type Birth = Readonly<{
  schemaVersion: 1; jobId: string; createdAt: string; manifestPath: string;
  runtimeDirectory: string; artifactSha256: string; manifest: ManifestWitness;
  jobDirectory: ResearchDirectoryIdentity; workspaceDirectory: ResearchDirectoryIdentity;
  registryDirectory: ResearchDirectoryIdentity;
}>;
function signature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");
}
function manifestWitness(path: string, expected: CodexGoalJobManifest): ManifestWitness {
  researchPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) ||
        before.size > 1024n * 1024n || realpathSync(path) !== path) invalid();
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    if (BigInt(size) !== before.size || signature(fstatSync(fd, { bigint: true })) !== signature(before) ||
        !isDeepStrictEqual(researchJson(bytes), expected)) invalid();
    const named = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (signature(fstatSync(named, { bigint: true })) !== signature(before)) invalid(); }
    finally { closeSync(named); }
    return { signature: signature(before), sha256: researchHash(bytes) };
  } finally { closeSync(fd); }
}
function syncDirectory(path: string, assertCurrent?: () => void): void {
  assertCurrent?.();
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { assertCurrent?.(); fsyncSync(fd); } finally { closeSync(fd); }
}

declare const preparationBrand: unique symbol;
export type ProtectedCodexGoalJobBirthPreparation = Readonly<{ [preparationBrand]: true }>;
type PreparedBirth = Readonly<{
  manifest: unknown; manifestPath: string; jobDirectory: ResearchDirectoryIdentity; artifactSha256: string;
  registryDirectory: ResearchDirectoryIdentity; workspaceDirectory?: ResearchDirectoryIdentity;
  originalControl?: Readonly<{ claim: OriginalHostedProjectControlBirthClaim;
    allocation: ReturnType<typeof originalHostedProjectControlAllocationPublication>;
    lexicalAllocation: Buffer; physicalAllocation: Buffer }>;
}>;
function eligibleDirectory(path: string): ResearchDirectoryIdentity | undefined {
  try { return researchDirectoryIdentity(path); } catch { return undefined; }
}
function eligiblePaths(manifest: CodexGoalJobManifestInput, registryRootDir: string): boolean {
  try {
    for (const path of [manifest.jobRootDir, manifest.workspacePath, registryRootDir, join(registryRootDir, manifest.jobId, "job.json")]) researchPath(path);
    return true;
  } catch { return false; }
}
const preparations = new WeakMap<ProtectedCodexGoalJobBirthPreparation, PreparedBirth>();
const manifestInputSnapshot = (manifest: CodexGoalJobManifestInput): unknown => JSON.parse(JSON.stringify(manifest));
function assertPreparedBirthCurrent(prepared: PreparedBirth | undefined, manifest: CodexGoalJobManifestInput,
  manifestPath: string): PreparedBirth {
  if (!prepared || prepared.manifestPath !== manifestPath ||
      !isDeepStrictEqual(prepared.manifest, manifestInputSnapshot(manifest)) ||
      prepared.jobDirectory.path !== manifest.jobRootDir) return invalid();
  if (prepared.originalControl) {
    assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
    if (!isDeepStrictEqual(originalHostedProjectControlAllocationPublication(), prepared.originalControl.allocation)) return invalid();
    const lexical = controlAllocationPath(paths(prepared.jobDirectory.path).birth);
    const physical = controlAllocationPath(physicalPaths(prepared.jobDirectory).birth);
    if (!researchRead(lexical).equals(prepared.originalControl.lexicalAllocation) ||
        !researchRead(physical).equals(prepared.originalControl.physicalAllocation)) return invalid();
  }
  assertResearchDirectory(prepared.jobDirectory);
  assertResearchDirectory(prepared.registryDirectory);
  if (prepared.workspaceDirectory) assertResearchDirectory(prepared.workspaceDirectory);
  const records = paths(manifest.jobRootDir), physical = physicalPaths(prepared.jobDirectory);
  if (optionalRecord(records.birth) !== undefined || optionalRecord(physical.birth) !== undefined) invalid();
  return prepared;
}

/** Original create-only staging capability, read without consuming it. A public
 * prompt/root shape cannot replace its exact owner snapshot or grant release. */
export function protectedCodexGoalJobBirthPreparationCurrent(input: {
  readonly preparation: ProtectedCodexGoalJobBirthPreparation;
  readonly manifest: CodexGoalJobManifestInput;
  readonly registryRootDir: string;
}): boolean {
  try {
    if (originalHostedProjectControlBirthRootPresent(input.manifest.jobRootDir)) {
      originalHostedProjectControlAllocationPublication();
    } else assertResearchInitialRoot(true);
    if (!eligiblePaths(input.manifest, input.registryRootDir)) return false;
    const manifestPath = join(input.registryRootDir, input.manifest.jobId, "job.json");
    const prepared = assertPreparedBirthCurrent(preparations.get(input.preparation), input.manifest, manifestPath);
    const workspace = prepared.workspaceDirectory ?? eligibleDirectory(input.manifest.workspacePath);
    if (!workspace) return false;
    const directories = [prepared.jobDirectory, prepared.registryDirectory, workspace];
    for (const directory of directories) { researchCustody(directory.path); assertResearchDirectory(directory); }
    const records = paths(input.manifest.jobRootDir), physical = physicalPaths(prepared.jobDirectory);
    if (optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined ||
        researchArtifactDigest(runtimeDirectory()) !== prepared.artifactSha256) return false;
    if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
    else assertResearchInitialRoot(true);
    if (assertPreparedBirthCurrent(preparations.get(input.preparation), input.manifest, manifestPath) !== prepared ||
        optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined) return false;
    for (const directory of directories) { researchCustody(directory.path); assertResearchDirectory(directory); }
    return true;
  } catch { return false; }
}

/** Genuine original allocation consumption. It never adopts EEXIST: the
 * exact root was exclusively created by the retained private native producer.
 * Public manifest fields only select between its two fixed physical roles. */
function prepareOriginalControlBirth(input: {
  readonly manifest: CodexGoalJobManifestInput; readonly registryRootDir: string;
}): ProtectedCodexGoalJobBirthPreparation {
  const original = originalHostedProjectControlAllocationPublication();
  if (!eligiblePaths(input.manifest, input.registryRootDir)) return invalid();
  const claim = claimOriginalHostedProjectControlBirth({ jobId: input.manifest.jobId, taskId: input.manifest.taskId,
    jobRootDir: input.manifest.jobRootDir, workspacePath: input.manifest.workspacePath,
    ...(input.manifest.authRootDir === undefined ? {} : { authRootDir: input.manifest.authRootDir }),
    registryRootDir: input.registryRootDir });
  try { return synchronized(() => {
    assertOriginalHostedProjectControlBirthClaimCurrent(claim);
    const jobDirectory = researchDirectoryIdentity(input.manifest.jobRootDir), registryDirectory = researchDirectoryIdentity(input.registryRootDir);
    const records = paths(input.manifest.jobRootDir), physical = physicalPaths(jobDirectory);
    if ([records, physical].some(row => optionalRecord(row.birth) !== undefined || optionalRecord(row.effect) !== undefined ||
      optionalRecord(row.birth.replace(/\.json$/, ".control-publication-v2.json")) !== undefined)) return invalid();
    const lexicalAllocation = researchRead(controlAllocationPath(records.birth)), physicalAllocation = researchRead(controlAllocationPath(physical.birth));
    if (!lexicalAllocation.equals(physicalAllocation)) return invalid();
    const record = researchJson(lexicalAllocation);
    const role = input.manifest.jobRootDir === original.selectors.controllerRoot ? OriginalControlAllocationRecordRole.Controller : OriginalControlAllocationRecordRole.Job;
    const expected = { schemaVersion: 2, kind: OriginalControlAllocationRecordKind.Allocation,
      runtimeDirectory: runtimeDirectory(), artifactSha256: researchArtifactDigest(runtimeDirectory()), originalAllocation: original, role };
    if (!isDeepStrictEqual(record, expected)) return invalid();
    let workspaceDirectory: ResearchDirectoryIdentity | undefined;
    try { workspaceDirectory = researchDirectoryIdentity(input.manifest.workspacePath); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    // Controller Source exists; only the fixed child W may still be absent.
    if (role === OriginalControlAllocationRecordRole.Controller && !workspaceDirectory) return invalid();
    assertOriginalHostedProjectControlBirthClaimCurrent(claim);
    const capability = Object.freeze({}) as ProtectedCodexGoalJobBirthPreparation;
    preparations.set(capability, { manifest: manifestInputSnapshot(input.manifest), manifestPath: join(input.registryRootDir, input.manifest.jobId, "job.json"),
      artifactSha256: expected.artifactSha256, jobDirectory, registryDirectory,
      ...(workspaceDirectory ? { workspaceDirectory } : {}), originalControl: { claim, allocation: original, lexicalAllocation, physicalAllocation } });
    return capability;
  }, () => assertOriginalHostedProjectControlBirthClaimCurrent(claim)); } catch (error) { holdOriginalHostedProjectControlBirthClaim(claim); throw error; }
}

/** The trusted refill owner must create the root before prompt/admission writes.
 * Only this exclusive mkdir issues an opaque, single-use in-process capability.
 * Existing roots and incomplete/unsupported preparations cannot be adopted. */
export async function prepareProtectedCodexGoalJobBirth(input: {
  readonly manifest: CodexGoalJobManifestInput;
  readonly registryRootDir: string;
}): Promise<ProtectedCodexGoalJobBirthPreparation | undefined> {
  if (originalHostedProjectControlBirthRootPresent(input.manifest.jobRootDir)) return prepareOriginalControlBirth(input);
  if (!initialHost() || !eligiblePaths(input.manifest, input.registryRootDir)) return undefined;
  const registryDirectory = eligibleDirectory(input.registryRootDir);
  if (!registryDirectory) return undefined;
  let workspaceDirectory: ResearchDirectoryIdentity | undefined;
  try { workspaceDirectory = researchDirectoryIdentity(input.manifest.workspacePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
  let artifactSha256: string;
  try { artifactSha256 = researchArtifactDigest(runtimeDirectory()); }
  catch { return undefined; }
  return await withProtectedCodexGoalJobBirthPublication(async () => {
    const records = paths(input.manifest.jobRootDir);
    if (optionalRecord(records.birth) !== undefined || optionalRecord(records.effect) !== undefined) return undefined;
    mkdirSync(dirname(input.manifest.jobRootDir), { recursive: true, mode: 0o700 });
    try { mkdirSync(input.manifest.jobRootDir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
    const jobDirectory = researchDirectoryIdentity(input.manifest.jobRootDir), physical = physicalPaths(jobDirectory);
    if (optionalRecord(physical.birth) !== undefined || optionalRecord(physical.effect) !== undefined) return undefined;
    const capability = Object.freeze({}) as ProtectedCodexGoalJobBirthPreparation;
    preparations.set(capability, { manifest: manifestInputSnapshot(input.manifest), artifactSha256, jobDirectory,
      registryDirectory, ...(workspaceDirectory ? { workspaceDirectory } : {}),
      manifestPath: join(input.registryRootDir, input.manifest.jobId, "job.json") });
    return capability;
  });
}

/** Exact manifest publication consumes only the original create capability.
 * This is not a caller/public 'fresh root' assertion and cannot cross processes.
 * Direct create uses the same preparation owner before publishing its manifest. */
export async function publishCodexGoalJobWithProtectedBirth<T>(input: {
  readonly job: CodexGoalJobManifest;
  readonly manifestInput: CodexGoalJobManifestInput;
  readonly manifestPath: string;
  readonly preparation?: ProtectedCodexGoalJobBirthPreparation;
  readonly publish: (freshJobRoot: boolean) => Promise<T>;
}): Promise<T> {
  const registryRootDir = dirname(dirname(input.manifestPath));
  // Direct legacy creation may name a future workspace. Qualify every positive
  // prerequisite before the fresh-root owner or the original manifest write.
  const originalControlRoot = originalHostedProjectControlBirthRootPresent(input.manifestInput.jobRootDir);
  if (!originalControlRoot && !input.preparation && (!eligiblePaths(input.manifestInput, registryRootDir) ||
      !eligibleDirectory(input.job.workspacePath) || !eligibleDirectory(registryRootDir))) return await input.publish(false);
  const capability = input.preparation ?? await prepareProtectedCodexGoalJobBirth({
    manifest: input.manifestInput, registryRootDir,
  });
  if (!capability) {
    if (originalControlRoot) return invalid();
    return await input.publish(false);
  }
  const originalClaim = preparations.get(capability)?.originalControl?.claim;
  try { return await withProtectedCodexGoalJobBirthPublication(async () => {
    const candidate = preparations.get(capability);
    preparations.delete(capability); // A failed/uncertain publication is never replayed.
    const prepared = assertPreparedBirthCurrent(candidate, input.manifestInput, input.manifestPath);
    if (prepared.jobDirectory.path !== input.job.jobRootDir) return invalid();
    const { job } = input, records = paths(job.jobRootDir), physical = physicalPaths(prepared.jobDirectory);
    // Refill may prepare the root before its future worktree exists. An absent
    // first workspace witness degrades before publication; captured drift does not.
    const workspaceDirectory = prepared.workspaceDirectory ?? eligibleDirectory(job.workspacePath);
    if (!workspaceDirectory) {
      if (prepared.originalControl) return invalid();
      return await input.publish(false);
    }
    if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
    const effectExtent = prepared.originalControl ? { active: true, claim: prepared.originalControl.claim,
      jobRootDir: job.jobRootDir, manifestPath: input.manifestPath, registryRootDir } : undefined;
    let value: T;
    try { value = effectExtent ? await originalBirthEffects.run(effectExtent, () => input.publish(true)) : await input.publish(true); }
    finally { if (effectExtent) effectExtent.active = false; }
    if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
    // A real first effect during prompt/worktree preparation permanently removes
    // the no-start proof. Manifest publication may finish but cannot grant release.
    if (optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined) {
      if (prepared.originalControl) return invalid();
      return value;
    }
    const birth: Birth = { schemaVersion: 1, jobId: job.jobId, createdAt: job.createdAt,
      manifestPath: input.manifestPath, runtimeDirectory: runtimeDirectory(), artifactSha256: prepared.artifactSha256,
      manifest: manifestWitness(input.manifestPath, job), jobDirectory: prepared.jobDirectory,
      workspaceDirectory, registryDirectory: prepared.registryDirectory };
    assertResearchDirectory(prepared.jobDirectory);
    assertResearchDirectory(workspaceDirectory); assertResearchDirectory(prepared.registryDirectory);
    if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
    const fd = openSync(input.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim); fsyncSync(fd); } finally { closeSync(fd); }
    for (const path of [job.jobRootDir, dirname(job.jobRootDir), dirname(input.manifestPath), birth.registryDirectory.path]) {
      if (prepared.originalControl) assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
      syncDirectory(path, prepared.originalControl ? () => assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl!.claim) : undefined);
    }
    if (prepared.originalControl) {
      assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
      assertPreparedBirthCurrent(prepared, input.manifestInput, input.manifestPath);
      const publication = { ...birth, schemaVersion: 2, kind: OriginalControlAllocationRecordKind.Publication,
        originalAllocation: prepared.originalControl.allocation };
      for (const row of [records, physical]) {
        assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl.claim);
        researchPublish(row.birth.replace(/\.json$/, ".control-publication-v2.json"), publication, true, () => assertOriginalHostedProjectControlBirthClaimCurrent(prepared.originalControl!.claim));
      }
      assertPreparedBirthCurrent(prepared, input.manifestInput, input.manifestPath);
      consumeOriginalHostedProjectControlBirthClaim(prepared.originalControl.claim);
    } else {
      researchPublish(records.birth, birth, true);
      researchPublish(physical.birth, birth, true);
    }
    return value;
  }); } catch (error) {
    if (originalClaim) holdOriginalHostedProjectControlBirthClaim(originalClaim);
    throw error;
  }
}

/** Per-enqueue veto for the existing public durable writers. Path spelling
 * only selects a controlled target; it cannot issue or restore a claim. */
export function assertOriginalProtectedBirthPublicationPathsCurrent(pathsToWrite: readonly string[]): boolean {
  const extent = originalBirthEffects.getStore();
  const original = pathsToWrite.some(originalHostedProjectControlAllocationPathPresent);
  if (!extent) { if (original) return invalid(); return false; }
  try {
    if (!extent.active) return invalid();
    assertOriginalHostedProjectControlBirthClaimCurrent(extent.claim);
    const selected = originalHostedProjectControlAllocationPublication(), roleRoot = extent.jobRootDir;
    if (roleRoot !== selected.selectors.jobRootDir && roleRoot !== selected.selectors.controllerRoot) return invalid();
    if (extent.registryRootDir !== selected.selectors.registry) return invalid();
    const directories = [roleRoot, extent.registryRootDir, dirname(extent.registryRootDir), dirname(extent.manifestPath)];
    for (let parent = dirname(roleRoot);; parent = dirname(parent)) { directories.push(parent); if (parent === "/") break; }
    const leaves = [extent.manifestPath, join(roleRoot, ".controller-state-origin.json")];
    for (const path of pathsToWrite) {
      if (resolve(path) !== path || !isAbsolute(path)) return invalid();
      if (directories.includes(path) || leaves.includes(path)) continue;
      const temporary = leaves.some(leaf => dirname(path) === dirname(leaf) &&
        new RegExp("^\\." + leaf.slice(dirname(leaf).length + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\." + process.pid + "\\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.tmp$").test(path.slice(dirname(path).length + 1)));
      if (!temporary) return invalid();
    }
    assertOriginalHostedProjectControlBirthClaimCurrent(extent.claim); return true;
  } catch (error) { holdOriginalHostedProjectControlBirthClaim(extent.claim); throw error; }
}

/** A factual descriptor veto within the private publication extent. It issues
 * no handle/FD capability and compares directories only to original held pins. */
export function assertOriginalProtectedBirthPublicationDescriptorCurrent(path: string, fd: number): void {
  if (!assertOriginalProtectedBirthPublicationPathsCurrent([path])) return;
  const extent = originalBirthEffects.getStore(); if (!extent) return invalid();
  try {
    const held = fstatSync(fd, { bigint: true });
    if (held.isDirectory()) { assertOriginalHostedProjectControlBirthDirectoryDescriptorCurrent(extent.claim, path, fd); return; }
    const named = lstatSync(path, { bigint: true });
    if (!held.isFile() || held.uid !== 0n || held.gid !== 0n || (held.mode & 0o7777n) !== 0o600n ||
      realpathSync(path) !== path || signature(held) !== signature(named) || (held.nlink !== 1n && held.nlink !== 2n)) return invalid();
    if (held.nlink === 2n) {
      const counterpart = [extent.manifestPath, join(extent.jobRootDir, ".controller-state-origin.json")]
        .find(leaf => path !== leaf && dirname(path) === dirname(leaf) && path.startsWith(join(dirname(leaf), "." + leaf.slice(dirname(leaf).length + 1) + "." + process.pid + ".")));
      if (!counterpart || signature(lstatSync(counterpart, { bigint: true })) !== signature(held)) return invalid();
    }
    assertOriginalHostedProjectControlBirthClaimCurrent(extent.claim);
  } catch (error) { holdOriginalHostedProjectControlBirthClaim(extent.claim); throw error; }
}

/** Negative invalidation only. It resolves the actual private dynamic extent,
 * never a caller claim, target, success flag or registration. */
export function holdOriginalProtectedBirthPublicationError(): void {
  const extent = originalBirthEffects.getStore();
  if (extent) holdOriginalHostedProjectControlBirthClaim(extent.claim);
}
const originalBirthManifestDescriptors = new Set<number>();
/** Exact first manifest write within the private public-publisher extent.
 * Ordinary callers retain their existing writer; a selected path is only DATA. */
export function publishOriginalProtectedBirthManifest(path: string, manifest: unknown): boolean {
  if (!assertOriginalProtectedBirthPublicationPathsCurrent([path])) return false;
  const extent = originalBirthEffects.getStore(); if (!extent || path !== extent.manifestPath) return invalid();
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  if (bytes.length > 1024 * 1024) return invalid();
  assertOriginalProtectedBirthPublicationPathsCurrent([path]);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  originalBirthManifestDescriptors.add(fd);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      assertOriginalProtectedBirthPublicationPathsCurrent([path]);
      assertOriginalProtectedBirthPublicationDescriptorCurrent(path, fd);
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return invalid(); offset += count;
    }
    assertOriginalProtectedBirthPublicationDescriptorCurrent(path, fd); fsyncSync(fd);
    assertOriginalProtectedBirthPublicationPathsCurrent([path]);
    const held = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!held.isFile() || held.uid !== 0n || held.gid !== 0n || held.nlink !== 1n ||
      (held.mode & 0o7777n) !== 0o600n || held.size !== BigInt(bytes.length) || signature(held) !== signature(named)) return invalid();
    assertOriginalProtectedBirthPublicationPathsCurrent([path]); closeSync(fd);
    let closed = false; try { fstatSync(fd); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error; closed = true;
    }
    if (!closed) return invalid(); originalBirthManifestDescriptors.delete(fd); return true;
  } catch (error) { holdOriginalProtectedBirthPublicationError(); throw error; }
}

/** Exact private birth witnesses select module composition only, not writer
 * authority. No publication lock may span an original runtime's operation. */
export function protectedCodexGoalJobRuntimeProvenance(job: CodexGoalJobManifest, registryRootDir: string):
  Readonly<{ runtimeDirectory: string; artifactSha256: string; assertCurrent(): void }> | undefined {
  try {
    assertResearchInitialRoot(true);
    const records = paths(job.jobRootDir), bytes = researchRead(records.birth), birth = researchJson(bytes) as Birth;
    if (birth.schemaVersion !== 1 || birth.jobId !== job.jobId || birth.createdAt !== job.createdAt ||
        typeof birth.runtimeDirectory !== "string" || !/^[a-f0-9]{64}$/.test(birth.artifactSha256) ||
        birth.jobDirectory.path !== job.jobRootDir || birth.workspaceDirectory.path !== job.workspacePath ||
        birth.registryDirectory.path !== registryRootDir || birth.manifestPath !== join(registryRootDir, job.jobId, "job.json")) return undefined;
    const physical = physicalPaths(birth.jobDirectory);
    const assertCurrent = (): void => {
      assertResearchInitialRoot(true);
      if (!researchRead(records.birth).equals(bytes) || !researchRead(physical.birth).equals(bytes) ||
          !isDeepStrictEqual(manifestWitness(birth.manifestPath, job), birth.manifest)) invalid();
      for (const directory of [birth.registryDirectory, birth.jobDirectory, birth.workspaceDirectory]) assertResearchDirectory(directory);
      if (!researchRead(records.birth).equals(bytes) || !researchRead(physical.birth).equals(bytes)) invalid();
    };
    assertCurrent();
    // Routing provenance only. First-effect history remains untouched and the
    // selected original runtime must perform its own writer/admission checks.
    return Object.freeze({ runtimeDirectory: birth.runtimeDirectory, artifactSha256: birth.artifactSha256, assertCurrent });
  } catch { return undefined; }
}

/** This cold read is useful only under the admission publication section. The
 * shared owner mutex keeps first effects out through the caller's final claim.
 * Without an enclosing section it is a point-in-time observation, never a permit.
 * Public origin, role and absent active/grant files confer no positive authority. */
export async function observeProtectedCodexGoalJobBirth(job: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  return observeBirth(job, false);
}
/** Explicit v1 read compatibility, not adoption of a foreign writer profile.
 * Immutable provenance and every release witness remain authoritative. The
 * current owner reads under its own mutex, never a foreign module's lock. */
export async function observeCompatibleProtectedCodexGoalJobBirth(job: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  return observeBirth(job, true);
}
async function observeBirth(job: CodexGoalJobManifest, compatible: boolean): Promise<ProjectAdmissionWriterObservation> {
  try {
    if (!initialHost()) return { status: "unknown" };
    return await withProtectedCodexGoalJobBirthPublication<ProjectAdmissionWriterObservation>(async () => {
      const records = paths(job.jobRootDir);
      // New control allocation history cannot inherit a legacy v1 released
      // answer. Its live/held compatibility requires the original private
      // allocation reader; absent/unknown original custody stays unreadable.
      if (optionalRecord(controlAllocationPath(records.birth)) !== undefined) return { status: "unknown" };
      if (optionalRecord(records.effect) !== undefined) return { status: "unknown" };
      const bytes = researchRead(records.birth), birth = researchJson(bytes) as Birth;
      const physical = physicalPaths(birth.jobDirectory);
      if (optionalRecord(physical.effect) !== undefined || optionalRecord(controlAllocationPath(physical.birth)) !== undefined ||
          !researchRead(physical.birth).equals(bytes)) return { status: "unknown" };
      if (birth.schemaVersion !== 1 || birth.jobId !== job.jobId || birth.createdAt !== job.createdAt ||
          (!compatible && birth.runtimeDirectory !== runtimeDirectory()) || !/^[a-f0-9]{64}$/.test(birth.artifactSha256) ||
          birth.jobDirectory.path !== job.jobRootDir || birth.workspaceDirectory.path !== job.workspacePath ||
          birth.manifestPath !== join(birth.registryDirectory.path, job.jobId, "job.json") ||
          !isDeepStrictEqual(manifestWitness(birth.manifestPath, job), birth.manifest)) return { status: "unknown" };
      if (birth.runtimeDirectory !== runtimeDirectory()) assertQualifiedResearchRuntimeArtifact(birth.runtimeDirectory, birth.artifactSha256);
      assertResearchDirectory(birth.registryDirectory); assertResearchDirectory(birth.jobDirectory);
      assertResearchDirectory(birth.workspaceDirectory);
      if (optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined ||
          !researchRead(records.birth).equals(bytes) || !researchRead(physical.birth).equals(bytes)) return { status: "unknown" };
      return { status: "released" };
    });
  } catch { return { status: "unknown" }; }
}
