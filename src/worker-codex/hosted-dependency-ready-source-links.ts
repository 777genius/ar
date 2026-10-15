import { readHostedDependencyScratchLayout } from "./hosted-dependency-scratch-layout";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DependencyInstallProofKind, DependencyReceiptState, sameDependencyTree,
  type DependencyReceipt, type DependencySourceBindingReference } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner } from "../core/dependency-environment/dependency-owner";
import type { DependencyCompletedLocalReady } from "../worker-core/dependency-environment/ports/dependency-source-binding";
import { LocalDependencySourceBindingStore, dependencyComparedSourceLinkProof,
  type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { assertHostedDependencyLegacyComparedReady, assertHostedDependencyLegacyLocalReferenceOutput,
  assertHostedDependencyLegacyLocalSourceHistory } from "./hosted-dependency-legacy-comparison-record";
import { assertHostedDependencyLocalOutputProof } from "./hosted-dependency-output-proof";
import { hostedDependencySourceBindingRoot, openHostedDependencySourceLinks, ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";

type Ready = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
type Target = NonNullable<Parameters<LocalDependencySourceBindingStore["openLegacyLocalCompared"]>[2]>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown) => encode(a).equals(encode(b));
const operations = "/var/lib/subscription-runtime-host-policy/dependency-transactions";
function fail(): never { throw new Error("dependency_ready_source_history_unresolved"); }
function sourceStore() {
  assertReadonlyHostOperator();
  return new LocalDependencySourceBindingStore(hostedDependencySourceBindingRoot,
    { assertInstallerCompletion() { fail(); } }, { assertVerifiedOutput: assertHostedDependencyLocalOutputProof }, {
      assertReferenceOutput: assertHostedDependencyLegacyLocalReferenceOutput,
      assertComparedSource(ready, mapping, reference) {
        const comparison = assertHostedDependencyLegacyComparedReady(ready);
        if (comparison.version !== 2 || !equal(comparison.candidateSourceBinding, reference)) fail();
        assertHostedDependencyLegacyLocalSourceHistory(comparison, mapping);
      },
      assertDetachedTarget(ready, _mapping, target) {
        const reference = target.reference;
        const id = /^dependency-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(target.name)?.[1];
        if (!id || reference.path !== `${operations}/${id}.json` ||
            target.workspace.dev !== ready.tree.dev) fail();
        const bytes = readPinned(reference, 32768), header = JSON.parse(bytes.toString("utf8"));
        if (!header || Object.keys(header).sort().join(",") !== "attempt,ready,trash,version" || header.version !== 1 ||
            !equal(header.ready, ready) || !encode(header).equals(bytes)) fail();
        const owner = parseDependencyOwner({ version: 2, workspace: ready.workspace, revision: 1, epoch: header.attempt?.epoch,
          owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: header.attempt } });
        if (owner.owner?.kind !== DependencyOwnerKind.Maintenance || owner.owner.attempt.operationId !== id ||
            target.workspace.canonicalPath !== readHostedDependencyScratchLayout(owner.owner.attempt.host.runtimeSha).trash ||
            !header.trash || Object.keys(header.trash).sort().join(",") !== "destinationName,destinationParent,operationId,originalTree" ||
            header.trash.operationId !== id || !sameDependencyTree(header.trash.originalTree, ready.tree) ||
            !equal(header.trash.destinationParent, target.workspace) || header.trash.destinationName !== target.name) fail();
        readPinned(reference, 32768);
      },
    });
}
function readPinned(reference: DependencySourceBindingReference, maximum: number): Buffer {
  const before = lstatSync(reference.path, { bigint: true }), bytes = readHostedPrivateBytes(reference.path, maximum), after = lstatSync(reference.path, { bigint: true });
  if (!bytes || !before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n ||
      String(before.dev) !== reference.identity.dev || String(before.ino) !== reference.identity.ino || hash(bytes) !== reference.sha256 ||
      before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) fail();
  return bytes;
}
/** Historical only: no old stage/tree or current mutable source is opened. */
export function assertHostedDependencyReadySourceHistory(ready: Ready): void {
  if (ready.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
    assertHostedDependencyLegacyComparedReady({ ...ready, provenance: ready.provenance }); return;
  }
  if (ready.provenance.kind === DependencyInstallProofKind.CompletedInstall) return;
  if (ready.provenance.kind !== DependencyInstallProofKind.CompletedLocalInstallV1) fail();
  const reference = ready.provenance.sourceBinding, record = sourceStore().readInstalledHistory(reference);
  if (record.version !== 2 ||
      record.generation !== ready.generation || !equal(record.workspace, ready.workspace) || !equal(record.tree, ready.tree) ||
      record.coverageRevision !== ready.coverageRevision || record.installKey !== ready.installKey || record.manifestDigest !== ready.manifestDigest ||
      record.operationId !== ready.provenance.operationId || record.installerCompletionSha256 !== ready.provenance.installerDrainEvidenceId ||
      ready.provenance.verificationEvidenceId !== ready.manifestDigest) fail();
  assertHostedDependencyLocalOutputProof(record);
}
/** Only authenticated immutable history selects the current physical pins. */
export function openHostedDependencyReadySourceLinks(ready: Ready, target?: Target): DependencySourceLinkSession | undefined {
  assertHostedDependencyReadySourceHistory(ready);
  if (ready.provenance.kind === DependencyInstallProofKind.CompletedLocalInstallV1) {
    const installed: DependencyCompletedLocalReady = { ...ready, provenance: ready.provenance };
    return openHostedDependencySourceLinks(installed, target);
  }
  if (ready.provenance.kind !== DependencyInstallProofKind.LegacyCompared) return undefined;
  const compared = { ...ready, provenance: ready.provenance }, comparison = assertHostedDependencyLegacyComparedReady(compared);
  if (comparison.version === 1) return undefined;
  return sourceStore().openLegacyLocalCompared(compared, comparison.candidateSourceBinding, target);
}
export function readHostedDependencyComparedSourceProof(session: DependencySourceLinkSession) {
  return dependencyComparedSourceLinkProof(session);
}

/** Worker-private composition; caller's actual final Maintenance fence owns publication. */
export function publishHostedDependencyLegacyLocalSourceBinding(input: Parameters<LocalDependencySourceBindingStore["publishLegacyLocalCompared"]>[0]) {
  ensureHostedDependencyDirectory(hostedDependencySourceBindingRoot);
  return sourceStore().publishLegacyLocalCompared(input);
}
