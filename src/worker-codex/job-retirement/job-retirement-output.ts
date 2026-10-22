import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { handoffPreservationBudget } from "../codex-goal-handoff-preservation-budget";
import { researchHash, researchRead } from "../research-launch-files";
import { JobRetirementOutputKind, JobRetirementRefusal, refuseRetirement, type DirectoryIdentityRecord,
  type JobRetirementOutput } from "./job-retirement-contract";
import { assertNoStash, assertNoUnpublishedCommits, canonicalRetirementPath, existingRefs, inspectRetirementRepository,
  retirementDiffFlags, withContentRefreshedIndex, type RetirementGit, type RetirementRepository } from "./job-retirement-git";

const packetSchema = "subscription-runtime-durable-terminal-handoff-v1";
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export type PlannedOutput = Readonly<{ kind: JobRetirementOutputKind.Handoff; manifestSha256: string } | { kind: JobRetirementOutputKind.Clean }>;
export type ObservedWorkspace = Readonly<{ identity: DirectoryIdentityRecord; repository: RetirementRepository }>;

/** The exact directory a tombstone will name: canonical, not a link, a Git checkout. */
export function observeRetirementWorkspace(path: string): ObservedWorkspace {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") refuseRetirement(JobRetirementRefusal.WorkspaceMissing); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalRetirementPath(path) !== path) refuseRetirement(JobRetirementRefusal.ManifestInvalid);
  return { identity: retirementDirectoryIdentity(path), repository: inspectRetirementRepository(path) };
}
/** Exact device and inode; a value JSON cannot carry exactly is refused, not rounded. */
export function retirementDirectoryIdentity(path: string): DirectoryIdentityRecord {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuseRetirement(JobRetirementRefusal.ManifestInvalid);
  if (stat.dev > BigInt(Number.MAX_SAFE_INTEGER) || stat.ino > BigInt(Number.MAX_SAFE_INTEGER)) refuseRetirement(JobRetirementRefusal.RecordInvalid);
  return { path, device: Number(stat.dev), inode: Number(stat.ino) };
}
/** On replay a tombstoned workspace is either gone or still the exact directory. */
export function assertSameWorkspaceIdentity(expected: DirectoryIdentityRecord): void {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(expected.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.device || stat.ino !== expected.inode)
    refuseRetirement(JobRetirementRefusal.TombstoneIdentityMismatch);
}

type Descriptor = { path: string; byteLength: number; sha256: string };
type PacketManifest = {
  schema?: unknown; schemaVersion?: unknown; workerJobId?: unknown; taskId?: unknown;
  git?: { head?: unknown }; status?: Descriptor;
  layers?: { index?: Descriptor; worktree?: Descriptor; headRelative?: Descriptor };
  untracked?: { archive?: Descriptor; paths?: Descriptor; entries?: { path: string; sha256: string; byteLength: number }[] };
  quarantine?: { manifest?: Descriptor; entries?: unknown[] };
};
/** Locate the reviewed packet by manifest digest inside the job's own sink. */
function findPacket(durableRoot: string, taskId: string, manifestSha256: string) {
  let names: string[];
  try { names = readdirSync(durableRoot); }
  catch { return refuseRetirement(JobRetirementRefusal.HandoffMissing); }
  const pattern = new RegExp(`^${taskId.replace(/[.]/g, "\\.")}\\.[a-f0-9]{64}\\.packet$`);
  for (const name of names.filter(row => pattern.test(row))) {
    const packetPath = join(durableRoot, name), stat = lstatSync(packetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const bytes = researchRead(join(packetPath, "manifest.json"));
    if (researchHash(bytes) === manifestSha256) return { packetPath, manifest: JSON.parse(bytes.toString("utf8")) as PacketManifest };
  }
  return refuseRetirement(JobRetirementRefusal.HandoffMissing);
}
/** Every packet file has the length and digest its manifest records. */
function assertPacketIntact(packetPath: string, manifest: PacketManifest, jobId: string, taskId: string): void {
  const descriptors = [manifest.status, manifest.layers?.index, manifest.layers?.worktree, manifest.layers?.headRelative,
    manifest.untracked?.archive, manifest.untracked?.paths, manifest.quarantine?.manifest];
  if (manifest.schema !== packetSchema || manifest.schemaVersion !== 1 || manifest.workerJobId !== jobId || manifest.taskId !== taskId ||
      typeof manifest.git?.head !== "string" || !/^[a-f0-9]{40}$/.test(manifest.git.head) || !Array.isArray(manifest.untracked?.entries) ||
      !Array.isArray(manifest.quarantine?.entries) || descriptors.some((row, index) => row === undefined && index !== 3))
    refuseRetirement(JobRetirementRefusal.HandoffInvalid);
  for (const row of descriptors.filter((row): row is Descriptor => row !== undefined)) {
    if (typeof row.path !== "string" || row.path.includes("/") || row.path.startsWith(".")) refuseRetirement(JobRetirementRefusal.HandoffInvalid);
    const bytes = researchRead(join(packetPath, row.path), true, handoffPreservationBudget.packetFileBytes);
    if (bytes.length !== row.byteLength || sha256(bytes) !== row.sha256) refuseRetirement(JobRetirementRefusal.HandoffInvalid);
  }
  if (manifest.untracked!.entries!.some(entry => !entry || typeof entry.path !== "string" || !entry.path ||
      entry.path.startsWith("/") || entry.path.split("/").some(part => part === "" || part === "." || part === "..") ||
      typeof entry.sha256 !== "string" || !Number.isSafeInteger(entry.byteLength))) refuseRetirement(JobRetirementRefusal.HandoffInvalid);
  // Symlinks, special files and nested repositories are recorded, not preserved.
  if (manifest.quarantine!.entries!.length) refuseRetirement(JobRetirementRefusal.HandoffIncomplete);
}
const workspaceStatus = (git: RetirementGit) => git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
/** The workspace still holds exactly what the packet preserves: the same HEAD,
 * status, index and worktree patches, and untracked files with the same bytes. */
function assertWorkspaceMatchesPacket(git: RetirementGit, workspace: string, head: string, manifest: PacketManifest): void {
  const layers = manifest.layers!, untracked = manifest.untracked!;
  const recomputed = [
    [manifest.status!, workspaceStatus(git)],
    [layers.index!, git(["diff", "--cached", "--binary", ...retirementDiffFlags, "--no-renames", "HEAD", "--"])],
    [layers.worktree!, git(["diff", "--binary", ...retirementDiffFlags, "--no-renames", "--"])],
  ] as const;
  if (manifest.git!.head !== head || recomputed.some(([descriptor, bytes]) => sha256(bytes) !== descriptor.sha256))
    refuseRetirement(JobRetirementRefusal.HandoffStale);
  const listed = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8")
    .split("\0").filter(Boolean).map(path => path.endsWith("/") ? path.slice(0, -1) : path).sort();
  const entries = [...untracked.entries!].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(listed) !== JSON.stringify(entries.map(entry => entry.path).sort())) refuseRetirement(JobRetirementRefusal.HandoffStale);
  for (const entry of entries) {
    const path = join(workspace, entry.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.byteLength) refuseRetirement(JobRetirementRefusal.HandoffStale);
    if (sha256(workspaceFileBytes(path, entry.byteLength)) !== entry.sha256) refuseRetirement(JobRetirementRefusal.HandoffStale);
  }
}
/** Workspace files are project data, not root-private authority: no custody,
 * but no link following, no special files and the recorded length exactly. */
function workspaceFileBytes(path: string, byteLength: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== byteLength) refuseRetirement(JobRetirementRefusal.HandoffStale);
    const bytes = readFileSync(fd);
    if (bytes.length !== byteLength) refuseRetirement(JobRetirementRefusal.HandoffStale);
    return bytes;
  } finally { closeSync(fd); }
}

export type OutputProofInput = Readonly<{
  jobId: string; taskId: string; workspace: ObservedWorkspace; durableHandoffRootDir: string; planned: PlannedOutput;
  /** Local branches whose commits must already be upstream. */
  branches: readonly string[];
}>;
/** Nothing in the workspace is lost by deleting it: its changes are in a
 * verified packet or there are none, and every commit is on a remote ref. */
export function proveJobOutput(input: OutputProofInput): JobRetirementOutput {
  const { identity, repository } = input.workspace, workspace = identity.path;
  // A standalone clone takes all its local branches with it; a linked worktree
  // only its HEAD, since its branches live on in the main repository.
  assertNoUnpublishedCommits(workspace, ["HEAD", ...existingRefs(workspace, input.branches)], !repository.linked);
  if (!repository.linked) assertNoStash(workspace);
  if (input.planned.kind === JobRetirementOutputKind.Clean) {
    if (withContentRefreshedIndex(workspace, workspaceStatus).length !== 0) refuseRetirement(JobRetirementRefusal.WorkspaceDirty);
    return { kind: JobRetirementOutputKind.Clean, head: repository.head };
  }
  const packet = findPacket(input.durableHandoffRootDir, input.taskId, input.planned.manifestSha256);
  assertPacketIntact(packet.packetPath, packet.manifest, input.jobId, input.taskId);
  withContentRefreshedIndex(workspace, git => assertWorkspaceMatchesPacket(git, workspace, repository.head, packet.manifest));
  return { kind: JobRetirementOutputKind.Handoff, packetPath: packet.packetPath, manifestSha256: input.planned.manifestSha256, head: repository.head };
}
