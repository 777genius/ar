import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind,
  DependencyNpmLockName, DependencyPreservationKind, DependencyReceiptParseStatus, DependencyReceiptState,
  DependencyTreeObservationStatus, parseDependencyReceipt, sameDependencyTree, sameDependencyWorkspace,
  type DependencyAttempt, type DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedOrdinaryProcessOrigin } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyManifestBlobStore } from "../store-local-file/dependency-environment/local-dependency-manifest-blob-store";
import { buildTestNpmDependencyInstallKey } from "../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { readHostedDependencyAttempt, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";

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
function receiptRoot(binding: HostedDependencyBinding): string {
  return `${root}/dependency-receipts/${binding.workspace.dev}-${binding.workspace.ino}`;
}
export function dependencyCoverageRevision(binding: HostedDependencyBinding): string {
  return hash(encode(binding));
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
function keyInputs(binding: HostedDependencyBinding) {
  const fd = openSync(binding.workspace.canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameDependencyTree(identity(fstatSync(fd, { bigint: true })), binding.workspace)) fail();
    for (const name of ["npm-shrinkwrap.json", ".npmrc"]) {
      try { lstatSync(`/proc/self/fd/${fd}/${name}`); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const packageBytes = bytes(fd, "package.json"), lockBytes = bytes(fd, "package-lock.json");
    const { schemaVersion: _version, networkInputs: _networkInputs, privilegeDropper: _dropper, recipeRevision: _recipe, ...toolchain } = readHostedDependencyInstallerProfile();
    const key = buildTestNpmDependencyInstallKey({ packageBytes, lockBytes, lockName: DependencyNpmLockName.PackageLock,
      toolchain, maxInputBytes: 16 * 1024 * 1024, maxCanonicalBytes: 128 * 1024 });
    return { packageBytes, lockBytes, key };
  } finally { closeSync(fd); }
}

/** Protected state is immutable for this first fresh TEST materialization.
 * Installing without Ready is an unresolved intent; no cleanup or overwrite.
 * Subsequent eviction generations require their own later transaction adapter. */
export function readHostedDependencyReceipt(binding: HostedDependencyBinding): DependencyReceipt | null {
  const parent = `${root}/dependency-receipts`;
  try { lstatSync(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const path = receiptRoot(binding);
  try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const intent = readHostedPrivateBytes(path + "/installing.json", 16384), ready = readHostedPrivateBytes(path + "/ready.json", 16384);
  if (!intent || !ready) fail();
  const decode = (value: Buffer): unknown => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)); }
    catch { return fail(); }
  };
  const pending = parseDependencyReceipt(decode(intent));
  const parsed = parseDependencyReceipt(decode(ready));
  if (parsed.status !== DependencyReceiptParseStatus.Valid || parsed.receipt.state !== DependencyReceiptState.Ready ||
      !sameDependencyWorkspace(parsed.receipt.workspace, binding.workspace) || parsed.receipt.coverageRevision !== dependencyCoverageRevision(binding)) fail();
  if (pending.status !== DependencyReceiptParseStatus.Valid || pending.receipt.state !== DependencyReceiptState.Installing ||
      pending.receipt.generation !== parsed.receipt.generation || pending.receipt.revision + 1 !== parsed.receipt.revision ||
      !sameDependencyWorkspace(pending.receipt.workspace, parsed.receipt.workspace) ||
      pending.receipt.coverageRevision !== parsed.receipt.coverageRevision || pending.receipt.requestedKey !== parsed.receipt.installKey ||
      parsed.receipt.provenance.kind !== DependencyInstallProofKind.CompletedInstall ||
      pending.receipt.operationId !== parsed.receipt.provenance.operationId) fail();
  return parsed.receipt;
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
    (tree.mode & 0o700n) === 0o700n && receipt.installKey === keyInputs(binding).key.installKey;
}

export async function materializeHostedDependencyFreshAbsence(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<void> {
  assertOwner(binding, attempt);
  const absence = readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096);
  const expectedAbsence = encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) });
  if (!absence?.equals(expectedAbsence) || readHostedDependencyReceipt(binding)) fail();
  const inputs = keyInputs(binding), generation = attempt.attemptId;
  directory(`${root}/dependency-receipts`); directory(receiptRoot(binding)); directory(`${root}/dependency-manifests`);
  const base = { version: 1 as const, revision: 1, generation, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) };
  const installing: DependencyReceipt = { ...base, state: DependencyReceiptState.Installing, operationId: generation,
    requestedKey: inputs.key.installKey, preservation: { kind: DependencyPreservationKind.KnownFreshAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      absenceEvidenceId: hash(absence) } };
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    try { lstatSync(binding.workspace.canonicalPath + "/node_modules"); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    createReadonlyPrivateRecord(receiptRoot(binding) + "/installing.json", encode(installing));
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
  if (keyInputs(binding).key.installKey !== inputs.key.installKey) fail();
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    publishCapturedDependencyOutput(normalized, binding.workspace);
  });
  const final = await observeDependencyTree({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: normalized.tree, limits: hostedDependencyObservationLimits });
  if (final.status !== DependencyTreeObservationStatus.Complete || final.digest !== normalized.digest ||
      keyInputs(binding).key.installKey !== inputs.key.installKey) fail(Failure.UnsafeTree);
  const blobs = await LocalDependencyManifestBlobStore.open({ rootPath: `${root}/dependency-manifests`, maxManifestBytes: 32 * 1024 * 1024,
    maxStoredBytes: 512 * 1024 * 1024, maxBlobs: 2048 });
  try { if (await blobs.put(final.canonicalBytes) !== final.digest) fail(); } finally { await blobs.close(); }
  const proofBinding = { generation, workspace: binding.workspace, coverageRevision: base.coverageRevision,
    installKey: inputs.key.installKey, tree: final.tree, manifestDigest: final.digest };
  const ready: DependencyReceipt = { ...base, revision: 2, state: DependencyReceiptState.Ready, ...proofBinding,
    provenance: { ...proofBinding, kind: DependencyInstallProofKind.CompletedInstall, operationId: generation,
      verificationEvidenceId: final.digest, installerDrainEvidenceId: completed.completionSha256 } };
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation);
    assertHostedDependencyInstallerAttemptDrained(attempt);
    if (!matchesHostedDependencyReady(binding, ready)) fail();
    createReadonlyPrivateRecord(receiptRoot(binding) + "/ready.json", encode(ready));
  });
}
