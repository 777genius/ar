import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind,
  DependencyNpmLockName, DependencyPreservationKind, DependencyReceiptState,
  DependencyTreeObservationStatus, sameDependencyTree,
  type DependencyAttempt, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedOrdinaryProcessOrigin } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyManifestBlobStore } from "../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { buildTestNpmDependencyInstallKey } from "../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { readHostedDependencyAttempt, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";
import { dependencyCoverageRevision, readHostedDependencyReceipt, publishHostedDependencyReceipt,
  readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
export { dependencyCoverageRevision, readHostedDependencyReceipt } from "./hosted-dependency-receipts";

export const hostedDependencyObservationLimits = { maxEntries: 100000, maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 32 * 1024 * 1024, maxDurationMs: 30000 } as const;
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function fail(reason = Failure.Unsupported): never { throw new DependencyAdmissionError(reason); }
function directory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o700) fail();
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function assertOwner(binding: HostedDependencyBinding, attempt: DependencyAttempt): void {
  const origin = withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    const held = readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    if (held.attemptId !== attempt.attemptId || held.epoch !== attempt.epoch) fail();
    return origin;
  });
  if (origin.start.workspacePath !== binding.workspace.canonicalPath) fail();
}
function identity(stat: BigIntStats) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function bytes(fd: number, name: string): Buffer {
  const input = openSync(`/proc/self/fd/${fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(input, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n || (before.mode & 0o022n)) fail();
    const value = readFileSync(input), after = fstatSync(input, { bigint: true });
    if (!sameDependencyTree(identity(before), identity(after)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || BigInt(value.length) !== before.size) fail();
    return value;
  } finally { closeSync(input); }
}
export function readHostedDependencyKeyInputs(binding: HostedDependencyBinding) {
  const fd = openSync(binding.workspace.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameDependencyTree(identity(fstatSync(fd, { bigint: true })), binding.workspace)) fail();
    for (const name of ["npm-shrinkwrap.json", ".npmrc"]) {
      try { lstatSync(`/proc/self/fd/${fd}/${name}`); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const packageBytes = bytes(fd, "package.json"), lockBytes = bytes(fd, "package-lock.json");
    const { schemaVersion: _version, networkInputs: _networkInputs, privilegeDropper: _privilegeDropper,
      recipeRevision: _recipeRevision, ...toolchain } = readHostedDependencyInstallerProfile();
    const key = buildTestNpmDependencyInstallKey({ packageBytes, lockBytes, lockName: DependencyNpmLockName.PackageLock,
      toolchain, maxInputBytes: 16 * 1024 * 1024, maxCanonicalBytes: 128 * 1024 });
    return { packageBytes, lockBytes, key };
  } finally { closeSync(fd); }
}

export function hasHostedDependencyFreshAbsence(binding: HostedDependencyBinding): boolean {
  try { lstatSync(`${root}/dependency-fresh-absence`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  return readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096)
    ?.equals(encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) })) ?? false;
}

/** Small hot reuse check: actual current input key, physical root and required
 * read/write capabilities. This is reuse, never a whole-tree unchanged proof. */
export function matchesHostedDependencyReady(binding: HostedDependencyBinding, receipt: DependencyReceipt): boolean {
  if (receipt.state !== DependencyReceiptState.Ready) fail();
  const tree = lstatSync(binding.workspace.canonicalPath + "/node_modules", { bigint: true });
  return tree.isDirectory() && sameDependencyTree(identity(tree), receipt.tree) && tree.uid === 0n &&
    (tree.mode & 0o700n) === 0o700n && receipt.installKey === readHostedDependencyKeyInputs(binding).key.installKey;
}

export async function materializeHostedDependencyAbsence(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<void> {
  assertOwner(binding, attempt);
  const previous = readHostedDependencyReceipt(binding);
  const absence = previous ? null : readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096);
  const expectedAbsence = encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) });
  if (previous ? previous.state !== DependencyReceiptState.Absent : !absence?.equals(expectedAbsence)) fail();
  const committed = previous ? readHostedDependencyCommittedAbsent(binding, previous.revision) : null;
  const inputs = readHostedDependencyKeyInputs(binding), generation = attempt.attemptId;
  directory(`${root}/dependency-manifests`);
  const base = { version: 1 as const, revision: (previous?.revision ?? 0) + 1, generation, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) };
  const installing: DependencyReceipt = { ...base, state: DependencyReceiptState.Installing, operationId: generation,
    requestedKey: inputs.key.installKey, preservation: committed ? { kind: DependencyPreservationKind.CommittedAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      prior: { generation: committed.receipt.generation, revision: committed.receipt.revision, operationId: committed.receipt.operationId,
        installKey: committed.receipt.installKey, tree: committed.receipt.evictionCommit.tree,
        manifestDigest: committed.receipt.evictionCommit.manifestDigest, commitEvidenceId: committed.receipt.evictionCommit.commitEvidenceId,
        receipt: committed.reference } } : { kind: DependencyPreservationKind.KnownFreshAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      absenceEvidenceId: hash(absence ?? fail()) } };
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    try { lstatSync(binding.workspace.canonicalPath + "/node_modules"); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    publishHostedDependencyReceipt(binding, previous?.revision ?? null, installing);
  });
  const completed = await new HostedDependencyInstaller().install({ workspace: binding.workspace, attempt,
    lockName: DependencyNpmLockName.PackageLock, packageBytes: inputs.packageBytes, lockBytes: inputs.lockBytes });
  assertOwner(binding, attempt); assertHostedDependencyInstallerAttemptDrained(attempt);
  const staged = await observeDependencyTree({ workspacePath: dirname(completed.output.canonicalPath), treeName: "node_modules",
    expectedTree: completed.output, limits: hostedDependencyObservationLimits });
  if (staged.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
  normalizeCapturedDependencyOutput(staged, 0);
  const normalized = await observeDependencyTree({ workspacePath: staged.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: staged.workspace, expectedTree: staged.tree, limits: hostedDependencyObservationLimits });
  if (normalized.status !== DependencyTreeObservationStatus.Complete || normalized.digest !== staged.digest) fail(Failure.UnsafeTree);
  if (readHostedDependencyKeyInputs(binding).key.installKey !== inputs.key.installKey) fail();
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    publishCapturedDependencyOutput(normalized, binding.workspace);
  });
  const final = await observeDependencyTree({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: normalized.tree, limits: hostedDependencyObservationLimits });
  if (final.status !== DependencyTreeObservationStatus.Complete || final.digest !== normalized.digest ||
      readHostedDependencyKeyInputs(binding).key.installKey !== inputs.key.installKey) fail(Failure.UnsafeTree);
  const blobs = await LocalDependencyManifestBlobStore.open({ rootPath: `${root}/dependency-manifests`, maxManifestBytes: 32 * 1024 * 1024,
    maxStoredBytes: 512 * 1024 * 1024, maxBlobs: 2048 });
  try { if (await blobs.put(final.canonicalBytes) !== final.digest) fail(); } finally { await blobs.close(); }
  const proofBinding = { generation, workspace: binding.workspace, coverageRevision: base.coverageRevision,
    installKey: inputs.key.installKey, tree: final.tree, manifestDigest: final.digest };
  const ready: DependencyReceipt = { ...base, revision: base.revision + 1, state: DependencyReceiptState.Ready, ...proofBinding,
    provenance: { ...proofBinding, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation,
      verificationEvidenceId: final.digest, installerDrainEvidenceId: completed.completionSha256 } };
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    if (!matchesHostedDependencyReady(binding, ready)) fail();
    publishHostedDependencyReceipt(binding, installing.revision, ready);
  });
}
