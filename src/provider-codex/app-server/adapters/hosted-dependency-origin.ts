import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyCustodyEvidenceKind, isDependencyCustodyObject, isDependencyProtectedReference,
  parseDependencyCustodyEvidence, sameDependencyWorkspace, type DependencyProtectedReference,
  type DependencyReadonlyAdoptionEvidence, type DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, readHostedActivationBytes, type HostedActivationFence } from "./hosted-process-activation";

const root = "/var/lib/subscription-runtime-host-policy";
export const hostedReadonlyDependencyAssociationRoot = `${root}/readonly-dependency-bindings`;
const maxBytes = 16384;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type HostedReadonlyDependencyStart = {
  readonly version: 1; readonly installationId: string; readonly runtimeSha: string; readonly inventoryDigest: string;
  readonly hostId: string; readonly bootId: string; readonly supervisorId: string;
  readonly generation: number; readonly startId: string; readonly creatorId: string; readonly unit: string;
  readonly association: DependencyProtectedReference; readonly candidateJobId: string; readonly readonlyJobId: string;
  readonly jobRootDir: string; readonly workspace: DependencyWorkspaceIdentity;
  readonly grantDigest: string; readonly policyDigest: string; readonly reviewDigest: string; readonly stageDigest: string; readonly leaseDigest: string;
};
function invalid(): never { throw new Error("hosted_readonly_dependency_origin_unresolved"); }
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const job = (v: unknown): v is string => typeof v === "string" && /^TEST-[A-Za-z0-9_.-]{1,123}$/.test(v);
export function readonlyDependencyAssociationName(workspace: DependencyWorkspaceIdentity): string {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(workspace.dev) || !/^[1-9][0-9]{0,19}$/.test(workspace.ino)) invalid();
  return `readonly-dependency-bindings/${workspace.dev}-${workspace.ino}.json`;
}
export function readonlyDependencyStartName(startId: string): string {
  if (!uuid.test(startId)) invalid(); return `readonly-dependency-starts/${startId}.json`;
}
/** Closed transport data only. Parsing never proves a live origin or permits a
 * frame, package read, owner claim, Ready publication or successor selection. */
export function parseHostedReadonlyDependencyStart(value: unknown): HostedReadonlyDependencyStart {
  if (!isDependencyCustodyObject(value, "association,bootId,candidateJobId,creatorId,generation,grantDigest,hostId,installationId,inventoryDigest,jobRootDir,leaseDigest,policyDigest,readonlyJobId,reviewDigest,runtimeSha,stageDigest,startId,supervisorId,unit,version,workspace") ||
      value.version !== 1 || typeof value.startId !== "string" || !uuid.test(value.startId) || value.creatorId !== value.startId ||
      value.unit !== `subscription-runtime-outer-${value.startId}.service` || typeof value.installationId !== "string" || !uuid.test(value.installationId) ||
      typeof value.bootId !== "string" || !uuid.test(value.bootId) || typeof value.hostId !== "string" || !/^[a-f0-9]{32}$/.test(value.hostId) ||
      typeof value.supervisorId !== "string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(value.supervisorId) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      typeof value.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(value.runtimeSha) ||
      ![value.inventoryDigest,value.grantDigest,value.policyDigest,value.reviewDigest,value.stageDigest,value.leaseDigest].every(digest) ||
      !job(value.candidateJobId) || !job(value.readonlyJobId) || value.candidateJobId === value.readonlyJobId ||
      typeof value.jobRootDir !== "string" || value.jobRootDir !== `${root}/dependency-test-jobs/jobs/${value.candidateJobId}` ||
      !isDependencyCustodyObject(value.workspace, "canonicalPath,dev,ino") || typeof value.workspace.canonicalPath !== "string" || value.workspace.canonicalPath !== `${value.jobRootDir}/workspace` ||
      typeof value.workspace.dev !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value.workspace.dev) ||
      typeof value.workspace.ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.workspace.ino) ||
      !isDependencyProtectedReference(value.association) ||
      value.association.path !== `${root}/${readonlyDependencyAssociationName({ canonicalPath: value.workspace.canonicalPath, dev: value.workspace.dev, ino: value.workspace.ino })}`) invalid();
  const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > maxBytes) invalid();
  return JSON.parse(bytes) as HostedReadonlyDependencyStart;
}
/** Finite retained file facts. Authority ancestry is independently checked by
 * the existing initial-host reader; sizes/mode precede IO, and the returned
 * reference names the actual retained FD, never merely a named lstat result. */
function pin(name: string) {
  const path = `${root}/${name}`;
  const parents: { path: string; stat: BigIntStats }[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const s = lstatSync(p, { bigint: true });
    if (!s.isDirectory() || s.uid !== 0n || (s.mode & 0o022n) || (p === dirname(path) && (s.mode & 0o7777n) !== 0o700n)) invalid();
    parents.push({ path: p, stat: s }); if (p === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maxBytes)) invalid();
    const bytes = readFileSync(fd), protectedBytes = readHostedActivationBytes(name);
    const after = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (!protectedBytes?.equals(bytes) || BigInt(bytes.length) !== before.size ||
        [after,entry].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.uid !== before.uid ||
          s.nlink !== before.nlink || s.mode !== before.mode || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs)) invalid();
    for (const p of parents) {
      const current = lstatSync(p.path, { bigint: true });
      if (!current.isDirectory() || current.dev !== p.stat.dev || current.ino !== p.stat.ino || current.uid !== p.stat.uid || current.mode !== p.stat.mode) invalid();
    }
    const reference: DependencyProtectedReference = { path, identity: { dev: String(before.dev), ino: String(before.ino) },
      sha256: createHash("sha256").update(bytes).digest("hex") };
    return { bytes, reference };
  } finally { closeSync(fd); }
}
function decode(bytes: Buffer): unknown {
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
  if (!Buffer.from(JSON.stringify(value) + "\n").equals(bytes)) invalid(); return value;
}
export function readHostedReadonlyDependencyAssociation(fence: HostedActivationFence, workspace: DependencyWorkspaceIdentity) {
  assertHostedActivationFence(fence);
  const name = readonlyDependencyAssociationName(workspace);
  // Missing protected parent is an inactive/never-published namespace only. Its
  // installed parent is already authenticated; any present unsafe entry denies.
  if (!readHostedActivationBytes("host-installation.json")) invalid();
  try { lstatSync(hostedReadonlyDependencyAssociationRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { lstatSync(`${root}/${name}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (readHostedActivationBytes(name)) invalid(); return null; } throw error; }
  const pinned = pin(name), evidence = parseDependencyCustodyEvidence(decode(pinned.bytes));
  if (evidence.kind !== DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1 || !sameDependencyWorkspace(evidence.workspace, workspace)) invalid();
  return Object.freeze({ ...pinned, evidence });
}
export function readHostedReadonlyDependencyStart(fence: HostedActivationFence, startId: string) {
  assertHostedActivationFence(fence); const pinned = pin(readonlyDependencyStartName(startId));
  const value = parseHostedReadonlyDependencyStart(decode(pinned.bytes));
  if (value.startId !== startId) invalid(); return Object.freeze({ ...pinned, value });
}
/** Old C authority is monotonically vetoed. Slice D must explicitly select a
 * completed genuine successor; absence/deletion or a new job name is no permit. */
export function assertHostedOrdinaryDependencyNotAdopted(fence: HostedActivationFence, workspacePath: string): void {
  if (!new RegExp(`^${root}/dependency-test-jobs/jobs/TEST-[A-Za-z0-9_.-]{1,123}/workspace$`).test(workspacePath)) return;
  assertHostedActivationFence(fence);
  const s = lstatSync(workspacePath, { bigint: true }); if (!s.isDirectory() || s.uid !== 0n) invalid();
  if (readHostedReadonlyDependencyAssociation(fence, { canonicalPath: workspacePath, dev: String(s.dev), ino: String(s.ino) })) invalid();
}
export type HostedReadonlyDependencyAssociation = Readonly<{ bytes: Buffer; reference: DependencyProtectedReference; evidence: DependencyReadonlyAdoptionEvidence }>;
