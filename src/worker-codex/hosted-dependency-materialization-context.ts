import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyOwnerPhase, sameDependencyAttempt,
  sameDependencyTree, DependencyPreservationKind, DependencyReceiptState, type DependencyReceipt, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt, type CurrentHostedDependencyOrigin, assertOriginalHostedDependencyColdProducer, requiresCurrentHostedDependencyRootPurpose } from "./hosted-current-dependency-origin";
import { type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { buildTestNpmDependencyInstallKey, buildTestNpmLocalDependencyInstallKey } from "../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { captureNpmInstallInputs, revalidateNpmInstallInputs, NpmInputCaptureStatus as Status, NpmInputCaptureReason as Reason,
  type NpmInputRevalidation, type QualifiedNpmInstallInputs } from "../worker-local/dependency-environment/capture-npm-install-inputs";
import { captureNpmLocalClosure, type QualifiedNpmLocalInputs } from "../worker-local/dependency-environment/capture-npm-local-closure";
import { HostedDependencyInstallerRecipe as Recipe, qualifyHostedDependencyLocalInstallerInputs, projectHostedDependencySelectionToolchain } from "./hosted-dependency-installer-inputs";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { dependencyCoverageRevision, readHostedDependencyReceipt, publishHostedDependencyReceipt,
  readHostedDependencyCommittedAbsent } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

export const hostedDependencyObservationLimits = { maxEntries: 100000, maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 32 * 1024 * 1024, maxDurationMs: 30000 } as const;
function fail(reason = Failure.Unsupported): never { throw new DependencyAdmissionError(reason); }
/** Concrete protected owner/inventory/physical-workspace read, not an injected
 * predicate. Durable ExclusiveMutation and qualified creator exclusion span
 * awaits; this short fence reauthenticates them before each effect. */
export function assertHostedDependencyMaterializationOwnerUnderFence(fence: HostedActivationFence,
  binding: HostedDependencyBinding, attempt: DependencyAttempt, capturedOrigin?:CurrentHostedDependencyOrigin): void {
  const context = capturedOrigin ?? readCurrentHostedDependencyOrigin(fence), current = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(current.attempt,attempt) || JSON.stringify(current.binding) !== JSON.stringify(binding)) fail(Failure.StaleAttempt);
}
export function assertHostedDependencyMaterializationOwner(binding: HostedDependencyBinding, attempt: DependencyAttempt, capturedOrigin?:CurrentHostedDependencyOrigin): void {
  withHostedActivationFence(fence => assertHostedDependencyMaterializationOwnerUnderFence(fence, binding, attempt,capturedOrigin));
}
export class HostedDependencyInputCaptureError extends DependencyAdmissionError {
  constructor(readonly captureFailure: Exclude<NpmInputRevalidation, { status: Status.Qualified }>) { super(Failure.Unsupported); }
}
function profile() {
  const value = readHostedDependencyInstallerProfile();
  const { schemaVersion: _version, networkInputs: _networkInputs, privilegeDropper: _privilegeDropper,
    recipeRevision: _recipeRevision, rootGit: _rootGit, ...toolchain } = value;
  return { value, toolchain, sha256: createHash("sha256").update(JSON.stringify(value) + "\n").digest("hex") };
}
function registryKey(capture: QualifiedNpmInstallInputs) {
  return buildTestNpmDependencyInstallKey({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, lockName: capture.lockName,
    toolchain: profile().toolchain, maxInputBytes: 16 * 1024 * 1024, maxCanonicalBytes: 128 * 1024 });
}
function localKey(capture: QualifiedNpmLocalInputs) {
  const actual = profile(), qualified = qualifyHostedDependencyLocalInstallerInputs(capture, actual.value);
  const key = buildTestNpmLocalDependencyInstallKey({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
    lockName: capture.lockName, closure: capture.closure, toolchain: actual.toolchain,
    maxInputBytes: 64 * 1024 * 1024, maxCanonicalBytes: 8 * 1024 * 1024 });
  if (key.installKey !== qualified.installKey || qualified.sha256 !== capture.closureDigest) fail();
  return { key, profileSha256: actual.sha256 };
}
type RegistryInputs = { readonly recipe: Recipe.NpmRegistryNoScriptsV1; readonly capture: QualifiedNpmInstallInputs;
  readonly lockName: QualifiedNpmInstallInputs["lockName"]; readonly packageBytes: Buffer; readonly lockBytes: Buffer;
  readonly key: ReturnType<typeof registryKey> };
export type HostedDependencyLocalKeyInputs = { readonly recipe: Recipe.NpmLocalNoLifecycleV1; readonly capture: QualifiedNpmLocalInputs;
  readonly lockName: QualifiedNpmLocalInputs["lockName"]; readonly packageBytes: Buffer; readonly lockBytes: Buffer;
  readonly key: ReturnType<typeof localKey>["key"]; readonly profileSha256: string };
export type HostedDependencyKeyInputs = RegistryInputs | HostedDependencyLocalKeyInputs;

export async function readHostedDependencyKeyInputs(binding: HostedDependencyBinding): Promise<HostedDependencyKeyInputs> {
  const capture = await captureNpmInstallInputs({ workspacePath: binding.workspace.canonicalPath, expectedWorkspace: binding.workspace,
    maxInputBytes: 16 * 1024 * 1024, maxDurationMs: 30000 });
  if (capture.status === Status.Qualified) {
    if (capture.packageBytes.length > 8 * 1024 * 1024 || capture.lockBytes.length > 8 * 1024 * 1024) fail();
    return { recipe: Recipe.NpmRegistryNoScriptsV1, capture, lockName: capture.lockName,
      packageBytes: Buffer.from(capture.packageBytes), lockBytes: Buffer.from(capture.lockBytes), key: registryKey(capture) };
  }
  // Only an actual unsupported closure may enter the second closed qualifier.
  // Missing/unknown/unsafe/config input never silently changes profile.
  if (capture.status !== Status.Unsupported || capture.reason !== Reason.UnsupportedClosure) throw new HostedDependencyInputCaptureError(capture);
  const protectedProfile = profile();
  const local = await captureNpmLocalClosure({ selectionToolchain: projectHostedDependencySelectionToolchain(protectedProfile.value), workspacePath: binding.workspace.canonicalPath, expectedWorkspace: binding.workspace,
    maxInputBytes: 64 * 1024 * 1024, maxEntries: 16384, maxPackages: 128, maxDurationMs: 10000 });
  if (profile().sha256 !== protectedProfile.sha256) fail();
  if (local.status !== Status.Qualified) throw new HostedDependencyInputCaptureError(local);
  return { recipe: Recipe.NpmLocalNoLifecycleV1, capture: local, lockName: local.lockName,
    packageBytes: Buffer.from(local.packageBytes), lockBytes: Buffer.from(local.lockBytes), ...localKey(local) };
}
/** Required under the caller's actual final host fence. No tree scan on hot reuse. */
export function assertHostedDependencyKeyInputsCurrent(binding: HostedDependencyBinding, inputs: HostedDependencyKeyInputs): void {
  if (inputs.capture.workspace.canonicalPath !== binding.workspace.canonicalPath || !sameDependencyTree(inputs.capture.workspace, binding.workspace)) fail();
  if (inputs.recipe === Recipe.NpmLocalNoLifecycleV1) {
    const current = localKey(inputs.capture);
    if (current.key.installKey !== inputs.key.installKey || current.profileSha256 !== inputs.profileSha256) fail();
  } else {
    const current = revalidateNpmInstallInputs({ capture: inputs.capture, maxDurationMs: 30000 });
    if (current.status !== Status.Qualified) throw new HostedDependencyInputCaptureError(current);
    if (registryKey(inputs.capture).installKey !== inputs.key.installKey) fail();
  }
}
export function sameHostedDependencyKeyInputs(before: HostedDependencyKeyInputs, after: HostedDependencyKeyInputs): boolean {
  if (before.recipe !== after.recipe || before.key.installKey !== after.key.installKey ||
      before.capture.closureDigest !== after.capture.closureDigest || before.lockName !== after.lockName) return false;
  if (before.recipe === Recipe.NpmLocalNoLifecycleV1 && after.recipe === Recipe.NpmLocalNoLifecycleV1) {
    return before.profileSha256 === after.profileSha256 && JSON.stringify(before.capture.pins) === JSON.stringify(after.capture.pins) &&
      JSON.stringify(before.capture.ancestorPins) === JSON.stringify(after.capture.ancestorPins) &&
      JSON.stringify(before.capture.absentPaths) === JSON.stringify(after.capture.absentPaths) && JSON.stringify(before.capture.watches) === JSON.stringify(after.capture.watches);
  }
  return before.recipe === Recipe.NpmRegistryNoScriptsV1 && after.recipe === Recipe.NpmRegistryNoScriptsV1 &&
    JSON.stringify(before.capture.packageFile) === JSON.stringify(after.capture.packageFile) && JSON.stringify(before.capture.lockFile) === JSON.stringify(after.capture.lockFile);
}

/** The existing legal absence/preservation transition. Owns its actual capture
 * and reads protected prior history; no caller key/record supplies authority.
 * The returned private-flow baseline is retained through subsequent awaits. */
export async function beginHostedDependencyInstallation(binding: HostedDependencyBinding, attempt: DependencyAttempt,capturedOrigin?:CurrentHostedDependencyOrigin,internalAccess?:symbol) {
  if(capturedOrigin) {if(internalAccess===undefined)fail();withHostedActivationFence(fence=>assertOriginalHostedDependencyColdProducer(capturedOrigin,fence,internalAccess));}
  else if(requiresCurrentHostedDependencyRootPurpose())fail();
  assertHostedDependencyMaterializationOwner(binding, attempt,capturedOrigin);
  const previous = readHostedDependencyReceipt(binding), root = "/var/lib/subscription-runtime-host-policy";
  const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
  const absence = previous ? null : readHostedPrivateBytes(`${root}/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`, 4096);
  const expectedAbsence = encode({ version: 1, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) });
  if (previous ? previous.state !== DependencyReceiptState.Absent : !absence?.equals(expectedAbsence)) fail();
  const committed = previous ? readHostedDependencyCommittedAbsent(binding, previous.revision) : null;
  const inputs = await readHostedDependencyKeyInputs(binding), generation = attempt.attemptId;
  const base = { version: 1 as const, revision: (previous?.revision ?? 0) + 1, generation, workspace: binding.workspace, coverageRevision: dependencyCoverageRevision(binding) };
  const installing: Extract<DependencyReceipt, { state: DependencyReceiptState.Installing }> = { ...base, state: DependencyReceiptState.Installing, operationId: generation,
    requestedKey: inputs.key.installKey, preservation: committed ? { kind: DependencyPreservationKind.CommittedAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      prior: { generation: committed.receipt.generation, revision: committed.receipt.revision, operationId: committed.receipt.operationId,
        installKey: committed.receipt.installKey, tree: committed.receipt.evictionCommit.tree,
        manifestDigest: committed.receipt.evictionCommit.manifestDigest, commitEvidenceId: committed.receipt.evictionCommit.commitEvidenceId,
        receipt: committed.reference } } : { kind: DependencyPreservationKind.KnownFreshAbsence,
      generation, workspace: binding.workspace, coverageRevision: base.coverageRevision, operationId: generation,
      absenceEvidenceId: createHash("sha256").update(absence ?? fail()).digest("hex") } };
  withHostedActivationFence(fence => {
    if(capturedOrigin)assertOriginalHostedDependencyColdProducer(capturedOrigin,fence,internalAccess ?? fail());
    else if(requiresCurrentHostedDependencyRootPurpose(fence))fail();
    assertHostedDependencyMaterializationOwnerUnderFence(fence, binding, attempt,capturedOrigin);
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    try { lstatSync(binding.workspace.canonicalPath + "/node_modules"); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    publishHostedDependencyReceipt(binding, previous?.revision ?? null, installing);
  });
  return { inputs, installing };
}
