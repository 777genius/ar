import { join } from "node:path";
import {
  assertJobStorageIdentity, assertJobStorageIntent, JobStorageCapabilityStatus as Status, JobStorageIntentKind,
  JobStorageSettlementStatus, SourceRecoveryFacet, type JobStorageHandoffVerification,
  type JobStorageSettlement, type JobStorageSourceHandoffPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  SourceHandoffCaptureStatus, SourceHandoffError, SourceHandoffFailure as Failure, SourceHandoffKeyPurpose, SourceHandoffRoot as Root,
  sourceHandoffFail, type SourceHandoffCaptureResult, type SourceHandoffDependencies,
  type SourceHandoffManifest, type SourceHandoffReceipt, type SourceHandoffFilesystemIdentity,
} from "./source-handoff-contracts";
import {
  assertSourceHandoffArtifacts, assertSourceHandoffDirectory, handoffFacetDigest, inventorySourceHandoff, sourceHandoffDigest,
  sourceHandoffDirectory, sourceHandoffId, sourceHandoffRootsDisjoint,
} from "./source-handoff-filesystem";
import { captureEncryptedSourceHandoff, restoreEncryptedSourceHandoff } from "./source-handoff-envelope";
import { inspectSourceHandoffDependencies, inspectSourceHandoffGit } from "./source-handoff-git";

function immutableCurrent(current: JobStorageSettlement): JobStorageSettlement {
  assertJobStorageIdentity(current);
  assertJobStorageIntent(current.intent);
  if (current.status !== JobStorageSettlementStatus.Resumable || current.intent.kind !== JobStorageIntentKind.NoResume ||
      !Number.isSafeInteger(current.revision) || current.revision < 0) sourceHandoffFail(Failure.Unsupported);
  return Object.freeze({ ...current, intent: Object.freeze({ ...current.intent }) });
}
function binding(receipt: Pick<SourceHandoffReceipt, "handoffId" | "jobId" | "generationId" | "receiptSha256" | "settlementRevision" | "keyId" | "independentDestinationId" | "nativeFenceSha256" | "sourcePhysicalSha256" | "destinationPhysicalSha256">): string {
  return JSON.stringify({ schemaVersion: 1, handoffId: receipt.handoffId, jobId: receipt.jobId, generationId: receipt.generationId,
    receiptSha256: receipt.receiptSha256, settlementRevision: receipt.settlementRevision, keyId: receipt.keyId,
    independentDestinationId: receipt.independentDestinationId, nativeFenceSha256: receipt.nativeFenceSha256, sourcePhysicalSha256: receipt.sourcePhysicalSha256,
    destinationPhysicalSha256: receipt.destinationPhysicalSha256 });
}
export function validateSourceHandoffReceipt(receipt: SourceHandoffReceipt): void {
  const fields = ["schemaVersion", "handoffId", "jobId", "generationId", "receiptSha256", "settlementRevision", "keyId",
    "independentDestinationId", "nativeFenceSha256", "sourcePhysicalSha256", "destinationPhysicalSha256", "envelopeSha256", "envelopeBytes",
    "sourceManifestSha256", "outputManifestSha256", "evidenceManifestSha256"];
  if (!receipt || Object.keys(receipt).some(field => !fields.includes(field)) ||
      fields.filter(field => !["schemaVersion", "settlementRevision", "envelopeBytes"].includes(field))
        .some(field => typeof receipt[field as keyof SourceHandoffReceipt] !== "string")) sourceHandoffFail(Failure.Invalid);
  sourceHandoffId(receipt.handoffId); sourceHandoffId(receipt.keyId); sourceHandoffId(receipt.independentDestinationId);
  assertJobStorageIdentity(receipt);
  if (receipt.schemaVersion !== 1 || !Number.isSafeInteger(receipt.settlementRevision) || receipt.settlementRevision < 0 ||
      !Number.isSafeInteger(receipt.envelopeBytes) || receipt.envelopeBytes <= 0 ||
      [receipt.sourcePhysicalSha256, receipt.destinationPhysicalSha256, receipt.nativeFenceSha256, receipt.envelopeSha256, receipt.sourceManifestSha256, receipt.outputManifestSha256, receipt.evidenceManifestSha256]
        .some(hash => !/^[a-f0-9]{64}$/.test(hash))) sourceHandoffFail(Failure.Invalid);
}
function physicalIdentity(filesystem: SourceHandoffFilesystemIdentity, directories: unknown): string {
  if (!/^[a-f0-9]{32}$/.test(filesystem.machineId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(filesystem.filesystemUuid)) sourceHandoffFail(Failure.Unsupported);
  return sourceHandoffDigest(JSON.stringify({ machineId: filesystem.machineId, filesystemUuid: filesystem.filesystemUuid, directories }));
}
/** Concrete encrypted FS capture + independent restored readback. Qualified
 * native owner/key custody/receipt integration is deliberately not constructed
 * here. Missing or uncertain native authority never grants source coverage. */
export class LocalSourceHandoff implements JobStorageSourceHandoffPort {
  private readonly dependencies: SourceHandoffDependencies;
  constructor(dependencies: SourceHandoffDependencies) { this.dependencies = Object.freeze({ ...dependencies }); }
  async capture(currentInput: JobStorageSettlement, handoffId: string): Promise<SourceHandoffCaptureResult> {
    if (!this.dependencies.native) return { status: Status.Unsupported };
    try {
      sourceHandoffId(handoffId);
      const current = immutableCurrent(currentInput);
      if (await this.dependencies.receipts.read(handoffId)) return { status: Status.Unsupported };
      const captured = await this.dependencies.native.withQuiescedCapture(current, handoffId, async lease => {
        lease.assertCurrent();
        const independentDestinationId = lease.independentDestinationId, nativeFenceSha256 = lease.nativeFenceSha256;
        sourceHandoffId(independentDestinationId); sourceHandoffId(this.dependencies.keyId);
        if (typeof nativeFenceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(nativeFenceSha256)) sourceHandoffFail(Failure.Unsupported);
        const roots = Object.freeze({ workspace: Object.freeze({ ...lease.source.workspace }),
          output: Object.freeze({ ...lease.source.output }), evidence: Object.freeze({ ...lease.source.evidence }) });
        const destination = Object.freeze({ ...lease.destination });
        const sourcePhysicalSha256 = physicalIdentity(Object.freeze({ ...lease.sourceFilesystem }), roots),
          destinationPhysicalSha256 = physicalIdentity(Object.freeze({ ...lease.destinationFilesystem }), destination);
        sourceHandoffRootsDisjoint([...Object.values(roots).map(root => root.path), destination.path]);
        if (Object.values(roots).some(root => root.device === destination.device || root.device !== roots.workspace.device)) sourceHandoffFail(Failure.Unsupported);
        const requiredArtifacts = Object.freeze({ output: Object.freeze([...lease.requiredArtifacts.output]),
          evidence: Object.freeze([...lease.requiredArtifacts.evidence]) });
        const entries = await inventorySourceHandoff(roots, () => lease.assertCurrent());
        assertSourceHandoffArtifacts(entries, requiredArtifacts);
        await inspectSourceHandoffDependencies(roots.workspace.path, entries);
        const gitFactsSha256 = await inspectSourceHandoffGit(roots.workspace.path, entries);
        lease.assertCurrent();
        const manifest: SourceHandoffManifest = Object.freeze({ schemaVersion: 1, entries, gitFactsSha256, requiredArtifacts });
        const bounded = Object.freeze({ handoffId, jobId: current.jobId, generationId: current.generationId,
          receiptSha256: current.receiptSha256, settlementRevision: current.revision, keyId: this.dependencies.keyId,
          independentDestinationId, nativeFenceSha256,
          sourcePhysicalSha256, destinationPhysicalSha256 });
        const encrypted = await this.dependencies.keys.withKey(bounded.keyId, SourceHandoffKeyPurpose.Capture,
          key => captureEncryptedSourceHandoff({ roots, destination, handoffId, manifest, key,
            binding: binding(bounded), assertCurrent: () => lease.assertCurrent() }));
        // Detect source mutations outside the declared native envelope as well;
        // this recheck is not a substitute for the held quiescence authority.
        const after = await inventorySourceHandoff(roots, () => lease.assertCurrent());
        if (JSON.stringify(after) !== JSON.stringify(entries) || await inspectSourceHandoffGit(roots.workspace.path, after) !== gitFactsSha256) sourceHandoffFail(Failure.Changed);
        lease.assertCurrent();
        const receipt: SourceHandoffReceipt = Object.freeze({ schemaVersion: 1, ...bounded, ...encrypted,
          sourceManifestSha256: sourceHandoffDigest(JSON.stringify(manifest)),
          outputManifestSha256: handoffFacetDigest(entries, Root.Output), evidenceManifestSha256: handoffFacetDigest(entries, Root.Evidence) });
        validateSourceHandoffReceipt(receipt);
        await this.dependencies.receipts.publish(receipt);
        lease.assertCurrent();
        return receipt;
      });
      return captured.status === Status.Verified ? { status: SourceHandoffCaptureStatus.Captured, receipt: captured.value } : captured;
    } catch (error) { return { status: error instanceof SourceHandoffError && error.code === Failure.Unsupported ? Status.Unsupported : Status.Unknown }; }
  }
  async verify(currentInput: JobStorageSettlement, handoffId: string): Promise<JobStorageHandoffVerification> {
    if (!this.dependencies.native) return { status: Status.Unsupported };
    try {
      sourceHandoffId(handoffId);
      const current = immutableCurrent(currentInput), stored = await this.dependencies.receipts.read(handoffId);
      if (!stored) return { status: Status.Unknown };
      const receipt: SourceHandoffReceipt = Object.freeze({ ...stored });
      validateSourceHandoffReceipt(receipt);
      if (receipt.handoffId !== handoffId || receipt.jobId !== current.jobId || receipt.generationId !== current.generationId ||
          receipt.receiptSha256 !== current.receiptSha256 || receipt.settlementRevision !== current.revision) return { status: Status.Unknown };
      const verified = await this.dependencies.native.withOfflineReadback(current, receipt, async lease => {
        lease.assertCurrent();
        if (lease.independentDestinationId !== receipt.independentDestinationId) sourceHandoffFail(Failure.Destination);
        const destination = Object.freeze({ ...lease.destination }), restoreParent = Object.freeze({ ...lease.restoreParent });
        sourceHandoffRootsDisjoint([destination.path, restoreParent.path]);
        if (physicalIdentity(lease.destinationFilesystem, destination) !== receipt.destinationPhysicalSha256) sourceHandoffFail(Failure.Destination);
        await assertSourceHandoffDirectory(destination); await assertSourceHandoffDirectory(restoreParent);
        const restored = await this.dependencies.keys.withKey(receipt.keyId, SourceHandoffKeyPurpose.Readback, key =>
          restoreEncryptedSourceHandoff({ destination, restoreParent,
            handoffId, key, binding: binding(receipt), envelopeSha256: receipt.envelopeSha256, envelopeBytes: receipt.envelopeBytes,
            assertCurrent: () => lease.assertCurrent() }));
        const roots = Object.freeze({ workspace: await sourceHandoffDirectory(join(restored.restorePath, Root.Workspace)),
          output: await sourceHandoffDirectory(join(restored.restorePath, Root.Output)), evidence: await sourceHandoffDirectory(join(restored.restorePath, Root.Evidence)) });
        const actual = await inventorySourceHandoff(roots, () => lease.assertCurrent());
        assertSourceHandoffArtifacts(actual, restored.manifest.requiredArtifacts);
        await inspectSourceHandoffDependencies(roots.workspace.path, actual);
        const gitFactsSha256 = await inspectSourceHandoffGit(roots.workspace.path, actual);
        if (JSON.stringify(actual) !== JSON.stringify(restored.manifest.entries) || gitFactsSha256 !== restored.manifest.gitFactsSha256 ||
            sourceHandoffDigest(JSON.stringify(restored.manifest)) !== receipt.sourceManifestSha256 ||
            handoffFacetDigest(actual, Root.Output) !== receipt.outputManifestSha256 || handoffFacetDigest(actual, Root.Evidence) !== receipt.evidenceManifestSha256) sourceHandoffFail(Failure.Authentication);
        lease.assertCurrent();
        const inventorySha256 = sourceHandoffDigest(JSON.stringify(actual));
        const result: JobStorageHandoffVerification = { status: Status.Verified, identity: { jobId: current.jobId,
          generationId: current.generationId, receiptSha256: current.receiptSha256 }, settlementRevision: current.revision,
          source: { sourceManifestSha256: receipt.sourceManifestSha256, inventorySha256,
            facets: Object.fromEntries(Object.values(SourceRecoveryFacet).map(facet => [facet, Status.Verified])) as Record<SourceRecoveryFacet, Status.Verified> },
          outputManifestSha256: receipt.outputManifestSha256, evidenceManifestSha256: receipt.evidenceManifestSha256,
          independentDestinationId: receipt.independentDestinationId,
          readbackReceiptSha256: sourceHandoffDigest(JSON.stringify({ receipt, inventorySha256, gitFactsSha256 })) };
        return result;
      });
      return verified.status === Status.Verified ? verified.value : verified;
    } catch (error) { return { status: error instanceof SourceHandoffError && error.code === Failure.Unsupported ? Status.Unsupported : Status.Unknown }; }
  }
}
