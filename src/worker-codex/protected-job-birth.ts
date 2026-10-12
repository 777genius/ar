import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, unlinkSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import type { CodexGoalJobManifest, CodexGoalJobManifestInput } from "./codex-goal-jobs";
import { assertResearchInitialRoot, researchProcessIdentity } from "./research-launch-host";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchCustody,
  researchDirectoryIdentity, researchHash, researchJson, researchPath, researchPrivateDirectory,
  researchPublish, researchRead, type ResearchDirectoryIdentity } from "./research-launch-files";

const birthRoot = join(researchAuthorityRoot, "job-births");
const publicationLock = join(birthRoot, "publication.lock");
const publicationContext = new AsyncLocalStorage<{ active: boolean }>();
const runtimeDirectory = (): string => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const invalid = (): never => { throw new Error("protected_job_birth_authority_invalid"); };
function initialHost(): boolean {
  try { assertResearchInitialRoot(true); return true; } catch { return false; }
}
function privateRoot(): void {
  for (const path of [researchAuthorityRoot, birthRoot]) {
    try { researchPrivateDirectory(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    researchCustody(path, true);
  }
}
function acquirePublication(): () => void {
  privateRoot();
  const nonce = randomUUID(), ownerPath = join(birthRoot, `.publication-${nonce}.owner.json`);
  const owner = { schemaVersion: 1, nonce, process: researchProcessIdentity() };
  // Fully write/fsync BEFORE publishing the name. An old mkdir owner remains
  // mutually exclusive; no crash can publish an anonymous new lock.
  researchPublish(ownerPath, owner, true);
  try { linkSync(ownerPath, publicationLock); syncDirectory(birthRoot); }
  catch (error) {
    // Publication could have succeeded before fsync failed: retain uncertainty.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") { unlinkSync(ownerPath); syncDirectory(birthRoot); }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("protected_job_birth_publication_busy");
    throw error;
  }
  const identity = publicationFile(publicationLock), bytes = readFileSync(publicationLock);
  return () => {
    const current = publicationFile(publicationLock), staged = publicationFile(ownerPath);
    if (current.device !== identity.device || current.inode !== identity.inode ||
        staged.device !== identity.device || staged.inode !== identity.inode || !readFileSync(publicationLock).equals(bytes)) invalid();
    unlinkSync(publicationLock); syncDirectory(birthRoot);
    unlinkSync(ownerPath); syncDirectory(birthRoot);
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
async function awaitPublication(): Promise<() => void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    try { return acquirePublication(); }
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
  if (!initialHost()) return await effect();
  if (publicationContext.getStore()?.active) return await effect();
  const release = await awaitPublication(), context = { active: true };
  try { return await publicationContext.run(context, effect); }
  finally { context.active = false; release(); }
}
/** Host composition must prepare foreign modules before entering publication. */
export function protectedCodexGoalJobBirthPublicationActive(): boolean {
  return publicationContext.getStore()?.active === true;
}
function synchronized<T>(effect: () => T): T {
  if (publicationContext.getStore()?.active) return effect();
  const release = acquirePublication();
  try { return effect(); } finally { release(); }
}
function paths(jobRootDir: string): { birth: string; effect: string } {
  if (!isAbsolute(jobRootDir) || resolve(jobRootDir) !== jobRootDir || jobRootDir === "/" || jobRootDir.includes("\0")) invalid();
  const key = researchHash(jobRootDir);
  return { birth: join(birthRoot, key + ".json"), effect: join(birthRoot, key + ".first-effect.json") };
}
function physicalPaths(identity: ResearchDirectoryIdentity): { birth: string; effect: string } {
  if (!Number.isSafeInteger(identity.device) || identity.device < 0 || !Number.isSafeInteger(identity.inode) || identity.inode < 1) invalid();
  const key = `physical-${identity.device}-${identity.inode}`;
  return { birth: join(birthRoot, key + ".json"), effect: join(birthRoot, key + ".first-effect.json") };
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
    if (present(lexical.birth) || present(lexical.effect)) return true;
    let identity: ResearchDirectoryIdentity;
    try { identity = firstEffectDirectoryIdentity(jobRootDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const physical = physicalPaths(identity);
    return present(physical.birth) || present(physical.effect);
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
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

declare const preparationBrand: unique symbol;
export type ProtectedCodexGoalJobBirthPreparation = Readonly<{ [preparationBrand]: true }>;
type PreparedBirth = Readonly<{
  manifest: unknown; manifestPath: string; jobDirectory: ResearchDirectoryIdentity; artifactSha256: string;
  registryDirectory: ResearchDirectoryIdentity; workspaceDirectory?: ResearchDirectoryIdentity;
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
    assertResearchInitialRoot(true);
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
    assertResearchInitialRoot(true);
    if (assertPreparedBirthCurrent(preparations.get(input.preparation), input.manifest, manifestPath) !== prepared ||
        optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined) return false;
    for (const directory of directories) { researchCustody(directory.path); assertResearchDirectory(directory); }
    return true;
  } catch { return false; }
}

/** The trusted refill owner must create the root before prompt/admission writes.
 * Only this exclusive mkdir issues an opaque, single-use in-process capability.
 * Existing roots and incomplete/unsupported preparations cannot be adopted. */
export async function prepareProtectedCodexGoalJobBirth(input: {
  readonly manifest: CodexGoalJobManifestInput;
  readonly registryRootDir: string;
}): Promise<ProtectedCodexGoalJobBirthPreparation | undefined> {
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
  if (!input.preparation && (!eligiblePaths(input.manifestInput, registryRootDir) ||
      !eligibleDirectory(input.job.workspacePath) || !eligibleDirectory(registryRootDir))) return await input.publish(false);
  const capability = input.preparation ?? await prepareProtectedCodexGoalJobBirth({
    manifest: input.manifestInput, registryRootDir,
  });
  if (!capability) return await input.publish(false);
  return await withProtectedCodexGoalJobBirthPublication(async () => {
    const candidate = preparations.get(capability);
    preparations.delete(capability); // A failed/uncertain publication is never replayed.
    const prepared = assertPreparedBirthCurrent(candidate, input.manifestInput, input.manifestPath);
    if (prepared.jobDirectory.path !== input.job.jobRootDir) return invalid();
    const { job } = input, records = paths(job.jobRootDir), physical = physicalPaths(prepared.jobDirectory);
    // Refill may prepare the root before its future worktree exists. An absent
    // first workspace witness degrades before publication; captured drift does not.
    const workspaceDirectory = prepared.workspaceDirectory ?? eligibleDirectory(job.workspacePath);
    if (!workspaceDirectory) return await input.publish(false);
    const value = await input.publish(true);
    // A real first effect during prompt/worktree preparation permanently removes
    // the no-start proof. Manifest publication may finish but cannot grant release.
    if (optionalRecord(records.effect) !== undefined || optionalRecord(physical.effect) !== undefined) return value;
    const birth: Birth = { schemaVersion: 1, jobId: job.jobId, createdAt: job.createdAt,
      manifestPath: input.manifestPath, runtimeDirectory: runtimeDirectory(), artifactSha256: prepared.artifactSha256,
      manifest: manifestWitness(input.manifestPath, job), jobDirectory: prepared.jobDirectory,
      workspaceDirectory, registryDirectory: prepared.registryDirectory };
    assertResearchDirectory(prepared.jobDirectory);
    assertResearchDirectory(workspaceDirectory); assertResearchDirectory(prepared.registryDirectory);
    const fd = openSync(input.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    for (const path of [job.jobRootDir, dirname(job.jobRootDir), dirname(input.manifestPath), birth.registryDirectory.path]) syncDirectory(path);
    researchPublish(records.birth, birth, true);
    researchPublish(physical.birth, birth, true);
    return value;
  });
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
    return synchronized<ProjectAdmissionWriterObservation>(() => {
      const records = paths(job.jobRootDir);
      if (optionalRecord(records.effect) !== undefined) return { status: "unknown" };
      const bytes = researchRead(records.birth), birth = researchJson(bytes) as Birth;
      const physical = physicalPaths(birth.jobDirectory);
      if (optionalRecord(physical.effect) !== undefined || !researchRead(physical.birth).equals(bytes)) return { status: "unknown" };
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
