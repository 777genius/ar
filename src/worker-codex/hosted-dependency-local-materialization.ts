import { DependencyContentObservationStage as ContentStage } from "../core/dependency-environment/dependency-content-observation";
import { startOriginalHostedDependencyContentObservation, finishOriginalHostedDependencyContentObservation } from "./hosted-dependency-content-observation";
import { startOriginalHostedDependencyFinalObservation } from "./hosted-dependency-generation-controller";
import { assertOriginalHostedDependencyColdProducer, requiresCurrentHostedDependencyRootPurpose, installCurrentHostedDependencyColdTree, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { DependencyAdmissionError, DependencyAdmissionFailure as Failure, DependencyInstallProofKind, DependencyReceiptState,
  DependencyTreeObservationStatus, sameDependencyTree, type DependencyAttempt, type DependencyTreeIdentity, type DependencyWorkspaceIdentity,
  type DependencyReceipt, type DependencySourceBindingReference } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallProfile } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { assertDependencyLocalOutputEvidence, encodeDependencySourceBindingOutputBody } from "../worker-core/dependency-environment/domain/dependency-source-binding-record";
import type { DependencyCompletedLocalReady, DependencyLocalOutputEvidence, DependencySourceBindingRecordV2 } from "../worker-core/dependency-environment/ports/dependency-source-binding";
import { encodeDependencyTreeManifest, type DependencyCapturedTreeObservation } from "../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { observeDependencyTree, observeDependencyTreeWithLocalRegistrySelection, assertDependencyLocalRegistrySelectionAbsent, closeDependencySourceExposure, type DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import { capturedDependencySourceBindingOutputBody, openCapturedDependencySourceLinks, closeDependencySourceLinkSession,
  readDependencySourceLinkSession, readDependencyProtectedReference, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { assertHostedDependencyMaterializationOwner as assertOwner, assertHostedDependencyMaterializationOwnerUnderFence as assertOwnerUnderFence,
  assertHostedDependencyKeyInputsCurrent, readHostedDependencyKeyInputs, sameHostedDependencyKeyInputs,
  hostedDependencyObservationLimits, beginHostedDependencyInstallation, type HostedDependencyKeyInputs, type HostedDependencyLocalKeyInputs } from "./hosted-dependency-materialization-context";
import { HostedDependencyInstaller, assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { HostedDependencyInstallerRecipe as Recipe } from "./hosted-dependency-installer-inputs";
import { hostedDependencyInstallerRoot } from "./hosted-dependency-installer-recipe";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { normalizeCapturedDependencyOutput, publishCapturedDependencyOutput } from "./hosted-dependency-staged-output";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { assertHostedDependencyLocalOutputProof } from "./hosted-dependency-output-proof";
import { readHostedDependencyReceipt, publishHostedDependencyReceipt,
  publishHostedDependencySourceBinding, openHostedDependencySourceLinks } from "./hosted-dependency-receipts";

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
function fail(reason = Failure.Unsupported): never { throw new DependencyAdmissionError(reason); }
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== names) fail();
}
function decode(bytes: Buffer): unknown {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!encode(value).equals(bytes)) fail(); return value;
}
function custody(): DependencyWorkspaceIdentity {
  const stat = lstatSync(hostedDependencyInstallerRoot, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o7777n) !== 0o700n) fail();
  return { canonicalPath: hostedDependencyInstallerRoot, dev: String(stat.dev), ino: String(stat.ino) };
}
function reference(path: string, root: DependencyWorkspaceIdentity): { reference: DependencySourceBindingReference; bytes: Buffer } {
  const hosted = readHostedPrivateBytes(path, 65536); if (!hosted) fail();
  const stat = lstatSync(path, { bigint: true });
  const reference = { path, identity: { dev: String(stat.dev), ino: String(stat.ino) }, sha256: sha(hosted) };
  const bytes = readDependencyProtectedReference(reference, root, 0n); if (!bytes.equals(hosted)) fail();
  return { reference, bytes };
}
/** Reads the real fixed records; a returned installer DTO is never output proof.
 * Missing mapping is denial even though the general drainer permits no attempt. */
function installerChain(binding: HostedDependencyBinding, attempt: DependencyAttempt, inputs: HostedDependencyLocalKeyInputs) {
  const root = custody(), mappingPath = `${root.canonicalPath}/attempt-${attempt.attemptId}.json`;
  const mapping = reference(mappingPath, root), row = decode(mapping.bytes); fields(row, "attempt,schemaVersion,startId,unit");
  if (typeof row.startId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.startId)) fail();
  const startId = row.startId, unit = `subscription-runtime-installer-${startId}.service`, directory = `${root.canonicalPath}/${startId}`;
  if (!mapping.bytes.equals(encode({ schemaVersion: 1, startId, unit, attempt }))) fail();
  const start = reference(`${directory}/start.json`, root), creator = reference(`${directory}/creator.json`, root),
    completion = reference(`${directory}/creator-completion.json`, root), terminal = reference(`${directory}/terminal.json`, root);
  if (!start.bytes.equals(encode({ schemaVersion: 2, startId, unit, recipe: Recipe.NpmLocalNoLifecycleV1,
    workspace: binding.workspace, attempt, inputSha256: inputs.capture.closureDigest, profileSha256: inputs.profileSha256,
    installKey: inputs.key.installKey, closureDigest: inputs.capture.closureDigest })) ||
    !completion.bytes.equals(encode({ schemaVersion: 1, startId, startSha256: start.reference.sha256,
      creatorSha256: creator.reference.sha256, status: 0, creatorWaitReturned: true }))) fail();
  const end = decode(terminal.bytes); fields(end, "completionSha256,emptySha256,output,schemaVersion,startId"); fields(end.output, "dev,ino");
  if (typeof end.emptySha256 !== "string" || !/^[a-f0-9]{64}$/.test(end.emptySha256) ||
      typeof end.output.dev !== "string" || !/^(0|[1-9][0-9]{0,39})$/.test(end.output.dev) ||
      typeof end.output.ino !== "string" || !/^[1-9][0-9]{0,39}$/.test(end.output.ino)) fail();
  const tree = { dev: end.output.dev, ino: end.output.ino };
  if (!terminal.bytes.equals(encode({ schemaVersion: 1, startId, emptySha256: end.emptySha256,
    completionSha256: completion.reference.sha256, output: tree }))) fail();
  assertHostedDependencyInstallerAttemptDrained(attempt);
  for (const item of [mapping, start, creator, completion, terminal]) readDependencyProtectedReference(item.reference, root, 0n);
  return { root, directory, startId, unit, mapping, start, creator, completion, terminal, tree };
}
type Chain = ReturnType<typeof installerChain>;
function currentChain(chain: Chain, attempt: DependencyAttempt): void {
  assertHostedDependencyInstallerAttemptDrained(attempt);
  if (!sameDependencyTree(custody(), chain.root)) fail();
  for (const item of [chain.mapping, chain.start, chain.creator, chain.completion, chain.terminal]) readDependencyProtectedReference(item.reference, chain.root, 0n);
}
/** Private issuer, reachable only after this flow's real final observation and
 * successful joined manifest close. No exported issue(record,predicate) port. */
function issue(chain: Chain, evidence: DependencyLocalOutputEvidence): DependencySourceBindingReference {
  assertDependencyLocalOutputEvidence(evidence);
  const bytes = encode(evidence); if (bytes.length > 65536) fail();
  const directory = lstatSync(chain.directory, { bigint: true }), parent = openSync(chain.directory, directoryFlags);
  try {
    const opened = fstatSync(parent, { bigint: true });
    if (!directory.isDirectory() || directory.uid !== 0n || (directory.mode & 0o7777n) !== 0o700n ||
        directory.dev !== opened.dev || directory.ino !== opened.ino || opened.uid !== 0n || (opened.mode & 0o7777n) !== 0o700n) fail();
    const fd = openSync(`/proc/self/fd/${parent}/verified-local-output.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncSync(parent);
    const reread = reference(`${chain.directory}/verified-local-output.json`, chain.root);
    const fresh = lstatSync(chain.directory, { bigint: true });
    if (!reread.bytes.equals(bytes) || fresh.dev !== opened.dev || fresh.ino !== opened.ino || fresh.uid !== 0n || (fresh.mode & 0o7777n) !== 0o700n) fail();
    return reread.reference;
  } finally { closeSync(parent); }
}
function assertRoot(workspace: DependencyWorkspaceIdentity, tree: DependencyTreeIdentity): void {
  const stat = lstatSync(`${workspace.canonicalPath}/node_modules`, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o700n) !== 0o700n || !sameDependencyTree({ dev: String(stat.dev), ino: String(stat.ino) }, tree)) fail(Failure.UnsafeTree);
}

/** Named opaque types keep declaration emit from expanding private brands. */
export type HostedDependencyLocalMaterializationResult = {
  readonly installing: Extract<DependencyReceipt, { state: DependencyReceiptState.Installing }>;
} & (
  | { readonly inputs: Extract<HostedDependencyKeyInputs, { recipe: Recipe.NpmRegistryNoScriptsV1 }>; readonly cold: undefined }
  | { readonly inputs: HostedDependencyLocalKeyInputs; readonly cold: {
      readonly ready: DependencyCompletedLocalReady;
      readonly observed: Extract<DependencyCapturedTreeObservation, { status: DependencyTreeObservationStatus.Complete }> & {
        readonly exposure: DependencySourceExposure;
      };
      readonly source: DependencySourceLinkSession;
      readonly exposure: DependencySourceExposure;
    } }
);

/** Closed local composition. Public arguments contain no observation, key,
 * claimed evidence or arbitrary path. Genuine qualified creator exclusion and
 * durable ExclusiveMutation span every await; each boundary reauthenticates
 * owner, physical source, actual profile/key and real installer drain. Unknown
 * failure retains Installing, output/evidence and owner for reconciliation. */
export async function materializeHostedDependencyLocalAbsence(binding: HostedDependencyBinding, attempt: DependencyAttempt,capturedOrigin?:CurrentHostedDependencyOrigin,internalAccess?:symbol): Promise<HostedDependencyLocalMaterializationResult> {
  if(capturedOrigin) {if(internalAccess===undefined)fail();withHostedActivationFence(fence=>assertOriginalHostedDependencyColdProducer(capturedOrigin,fence,internalAccess));}
  else if(requiresCurrentHostedDependencyRootPurpose())fail();
  const prepared = await beginHostedDependencyInstallation(binding, attempt,capturedOrigin,internalAccess), { inputs, installing } = prepared;
  // Registry continues its existing recipe with this same actual capture and
  // legal Installing transition. Local retains its initial physical pins.
  if (inputs.recipe === Recipe.NpmRegistryNoScriptsV1) return { inputs, installing, cold: undefined };
  const current = () => {
    assertHostedDependencyKeyInputsCurrent(binding, inputs);
    const stored = readHostedDependencyReceipt(binding); if (!stored || !encode(stored).equals(encode(installing))) fail();
  };
  withHostedActivationFence(fence => { assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); });
  const completed=capturedOrigin ? await installCurrentHostedDependencyColdTree(capturedOrigin,internalAccess ?? fail()) :
    await new HostedDependencyInstaller().install({recipe:Recipe.NpmLocalNoLifecycleV1,workspace:binding.workspace,attempt});
  assertOwner(binding, attempt,capturedOrigin);
  const chain = withHostedActivationFence(fence => {
    assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); return installerChain(binding, attempt, inputs);
  });
  const stagePath = `${chain.directory}/staging`, stageStat = lstatSync(stagePath, { bigint: true });
  const stageWorkspace = { canonicalPath: stagePath, dev: String(stageStat.dev), ino: String(stageStat.ino) };
  if (!stageStat.isDirectory() || stageStat.uid !== 0n || completed.recipe !== Recipe.NpmLocalNoLifecycleV1 ||
      completed.startId !== chain.startId || completed.unit !== chain.unit || completed.inputSha256 !== inputs.capture.closureDigest ||
      completed.profileSha256 !== inputs.profileSha256 || completed.completionSha256 !== chain.completion.reference.sha256 ||
      completed.installKey !== inputs.key.installKey || completed.closureDigest !== inputs.capture.closureDigest ||
      completed.output.canonicalPath !== `${stagePath}/node_modules` || !sameDependencyTree(completed.output, chain.tree)) fail();
  const stagedSession = openCapturedDependencySourceLinks(inputs.capture, stageWorkspace);
  let ownedOriginalSession: ReturnType<typeof openCapturedDependencySourceLinks> | undefined;
  let stagedExposure: DependencySourceExposure | undefined, finalExposure: DependencySourceExposure | undefined;
  try {
    const originalSession = openCapturedDependencySourceLinks(inputs.capture); ownedOriginalSession = originalSession;
    const stagedOrdinal=capturedOrigin ? withHostedActivationFence(fence=>startOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),ContentStage.Staged)) : undefined;
    const staged = await observeDependencyTreeWithLocalRegistrySelection({ workspacePath: stagePath, expectedWorkspace: stageWorkspace, treeName: "node_modules",
      expectedTree: chain.tree, sourceLinkSession: stagedSession, limits: hostedDependencyObservationLimits });
    if (staged.status === DependencyTreeObservationStatus.Complete) stagedExposure = staged.exposure;
    if(capturedOrigin && stagedOrdinal!==undefined)withHostedActivationFence(fence=>finishOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),stagedOrdinal,staged.status===DependencyTreeObservationStatus.Complete));
    if (staged.status !== DependencyTreeObservationStatus.Complete) fail(Failure.UnsafeTree);
    withHostedActivationFence(fence => { assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); currentChain(chain, attempt);
      assertDependencyLocalRegistrySelectionAbsent(staged.exposure, stagedSession, stageWorkspace, chain.tree);
      normalizeCapturedDependencyOutput(staged, 0, stagedSession); });
    closeDependencySourceExposure(staged.exposure); stagedExposure = undefined;
    const normalizedOrdinal=capturedOrigin ? withHostedActivationFence(fence=>startOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),ContentStage.Normalized)) : undefined;
    const normalized = await observeDependencyTree({ workspacePath: stagePath, expectedWorkspace: stageWorkspace, treeName: "node_modules",
      expectedTree: chain.tree, sourceLinkSession: stagedSession, limits: hostedDependencyObservationLimits });
    if(capturedOrigin && normalizedOrdinal!==undefined)withHostedActivationFence(fence=>finishOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),normalizedOrdinal,normalized.status===DependencyTreeObservationStatus.Complete));
    if (normalized.status !== DependencyTreeObservationStatus.Complete || !Buffer.from(normalized.canonicalBytes).equals(Buffer.from(staged.canonicalBytes)) ||
        !sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail(Failure.UnsafeTree);
    withHostedActivationFence(fence => { assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); currentChain(chain, attempt);
      publishCapturedDependencyOutput(normalized, binding.workspace, { staged: stagedSession, original: originalSession }); });
    assertOwner(binding,attempt,capturedOrigin);
    if(capturedOrigin)withHostedActivationFence(fence=>startOriginalHostedDependencyFinalObservation(capturedOrigin,fence,internalAccess ?? fail()));
    const finalOrdinal=capturedOrigin ? withHostedActivationFence(fence=>startOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),ContentStage.FinalRoot)) : undefined;
    const final = await observeDependencyTreeWithLocalRegistrySelection({ workspacePath: binding.workspace.canonicalPath, expectedWorkspace: binding.workspace,
      treeName: "node_modules", expectedTree: chain.tree, sourceLinkSession: originalSession, limits: hostedDependencyObservationLimits });
    if (final.status === DependencyTreeObservationStatus.Complete) finalExposure = final.exposure;
    if(capturedOrigin && finalOrdinal!==undefined)withHostedActivationFence(fence=>finishOriginalHostedDependencyContentObservation(capturedOrigin,fence,internalAccess ?? fail(),finalOrdinal,final.status===DependencyTreeObservationStatus.Complete));
    if (final.status !== DependencyTreeObservationStatus.Complete || !Buffer.from(final.canonicalBytes).equals(Buffer.from(normalized.canonicalBytes)) ||
        !sameHostedDependencyKeyInputs(inputs, await readHostedDependencyKeyInputs(binding))) fail(Failure.UnsafeTree);
    assertOwner(binding, attempt,capturedOrigin);
    const blobs = await openHostedDependencyManifestPlacement();
    // Private immutable blob I/O holds placement FDs. Full origin admission
    // remains before open and after awaited closure, before any Ready effect.
    try {if (await blobs.put(final.canonicalBytes) !== final.digest) fail();} finally {await blobs.close();}
    assertOwner(binding,attempt,capturedOrigin);
    // All observer/placement descriptors have joined close before FDA origin
    // inspection. Source sessions retain logical pins, not leaked scan FDs.
    const ready = withHostedActivationFence(fence => {
      assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); currentChain(chain, attempt); assertRoot(binding.workspace, final.tree);
      readDependencySourceLinkSession(originalSession, binding.workspace, "node_modules"); blobs.assertCurrent(fence);
      assertDependencyLocalRegistrySelectionAbsent(final.exposure, originalSession, binding.workspace, final.tree);
      const proofBinding = { generation: installing.generation, workspace: binding.workspace, coverageRevision: installing.coverageRevision,
        installKey: inputs.key.installKey, tree: final.tree, manifestDigest: final.digest };
      const body = capturedDependencySourceBindingOutputBody(inputs.capture, proofBinding, chain.completion.reference.sha256);
      if (!Buffer.from(encodeDependencyTreeManifest(final.entries, body.sourceLinks)).equals(Buffer.from(final.canonicalBytes))) fail(Failure.UnsafeTree);
      const evidence: DependencyLocalOutputEvidence = { version: 1, profile: DependencyInstallProfile.TestNpmLocalNoLifecycleV1,
        ...proofBinding, operationId: installing.operationId, closureDigest: inputs.capture.closureDigest,
        inputSha256: inputs.capture.closureDigest, profileSha256: inputs.profileSha256,
        start: chain.start.reference, creator: chain.creator.reference, completion: chain.completion.reference, terminal: chain.terminal.reference,
        manifestVersion: 2, manifestPlacementRevision: blobs.placementRevision, verifiedBindingSha256: sha(Buffer.from(encodeDependencySourceBindingOutputBody(body))) };
      const record: DependencySourceBindingRecordV2 = { ...body, outputReference: issue(chain, evidence) };
      assertHostedDependencyLocalOutputProof(record);
      const sourceBinding = publishHostedDependencySourceBinding(record);
      const ready: DependencyCompletedLocalReady = { version: 1, revision: installing.revision + 1, state: DependencyReceiptState.Ready, ...proofBinding, treeMeasurement: final.measurement,
        provenance: { ...proofBinding, kind: DependencyInstallProofKind.CompletedLocalInstallV1, operationId: installing.operationId,
          verificationEvidenceId: final.digest, installerDrainEvidenceId: chain.completion.reference.sha256, sourceBinding } };
      const protectedSession = openHostedDependencySourceLinks(ready); closeDependencySourceLinkSession(protectedSession);
      assertOwnerUnderFence(fence, binding, attempt,capturedOrigin); current(); currentChain(chain, attempt); assertRoot(binding.workspace, final.tree);
      readDependencySourceLinkSession(originalSession, binding.workspace, "node_modules"); blobs.assertCurrent(fence);
      assertDependencyLocalRegistrySelectionAbsent(final.exposure, originalSession, binding.workspace, final.tree);
      publishHostedDependencyReceipt(binding, installing.revision, ready);
      return ready;
    });
    // Transfer only after actual protected Ready publication. These are genuine
    // logical selection/source pins; scan FDs and placement already joined close.
    const cold = { ready, observed: final, source: originalSession, exposure: final.exposure };
    finalExposure = undefined; ownedOriginalSession = undefined;
    return { inputs, installing, cold };
  } finally {
    if (stagedExposure) closeDependencySourceExposure(stagedExposure);
    if (finalExposure) closeDependencySourceExposure(finalExposure);
    closeDependencySourceLinkSession(stagedSession); if (ownedOriginalSession) closeDependencySourceLinkSession(ownedOriginalSession);
  }
}
