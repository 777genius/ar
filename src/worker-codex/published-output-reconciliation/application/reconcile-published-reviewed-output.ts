import { AccessBoundary, ReviewDecisionStatus, createAccessPolicyService,
  recordTerminalOutputDecision, type ProjectAccessScope,
  type ConsumedOutputLedgerWriterPort, type TerminalOutputDecision } from "@vioxen/subscription-runtime/worker-core";
import type { ReviewedWorkerOutputSnapshot } from "../../reviewed-worker-output";
import { incorporationBytes, incorporationHash, incorporationPermitSchema, incorporationReceiptSchema,
  type IncorporationPermit, type IncorporationReceipt } from "../domain/publication-incorporation";

export type PublishedOutputReconciliationDeps = {
  readonly loadSnapshot: (id: string) => Promise<ReviewedWorkerOutputSnapshot | undefined>;
  readonly readPatch: (snapshot: ReviewedWorkerOutputSnapshot) => Promise<string>;
  readonly assertQuiescent: () => Promise<void>;
  readonly assertSourceMatches: (snapshot: ReviewedWorkerOutputSnapshot) => Promise<void>;
  readonly verify: (snapshot: ReviewedWorkerOutputSnapshot, patch: string) => Promise<Pick<IncorporationReceipt,
    "sourceTree" | "sourceParents" | "reconstructedTree" | "publishedTree" | "publishedParents" | "paths">>;
  readonly readPrepared: () => Promise<{ receipt: IncorporationReceipt; status: Buffer } | undefined>;
  readonly readStatus: () => Promise<Buffer>;
  readonly publish: (receipt: IncorporationReceipt, patch: string, status: Buffer) => Promise<void>;
  readonly writer: ConsumedOutputLedgerWriterPort;
  readonly isCommitted: (decision: TerminalOutputDecision) => Promise<boolean>;
};

export async function reconcilePublishedReviewedOutput(deps: PublishedOutputReconciliationDeps, input: {
  readonly scope: ProjectAccessScope; readonly controllerJobId: string;
  readonly permit: IncorporationPermit; readonly permitSha256: string;
  readonly archivePath: string;
}) {
  const permit = incorporationPermitSchema.parse(input.permit);
  const access = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope: input.scope });
  if (input.scope.projectId !== permit.projectId || input.controllerJobId !== permit.controllerJobId ||
      !access.canStartWorker({ jobId: permit.workerJobId, workspacePath: permit.sourceWorkspace }).allowed ||
      !access.canIntegrateCommit({ workspacePath: permit.targetWorkspace, branch: permit.branch }).allowed) {
    throw new Error("published_output_reconciliation_scope_denied");
  }
  const ledgerRoots = input.scope.consumedOutputLedgerRoots ?? [];
  if (ledgerRoots.length !== 1) throw new Error("published_output_reconciliation_ledger_required");
  const snapshot = await deps.loadSnapshot(permit.reviewedOutputId);
  if (!snapshot || snapshot.merge || snapshot.reviewDecision.decision !== ReviewDecisionStatus.Approved ||
      snapshot.controllerJobId !== permit.controllerJobId || snapshot.projectId !== permit.projectId ||
      snapshot.workerJobId !== permit.workerJobId || snapshot.sourceWorkspacePath !== permit.sourceWorkspace ||
      snapshot.patchSha256 !== permit.patchSha256 || snapshot.baseCommit !== permit.sourceBase ||
      snapshot.reviewDecision.reviewedBy !== permit.reviewedBy ||
      incorporationHash(JSON.stringify(snapshot.reviewDecision)) !== permit.reviewDecisionSha256 ||
      JSON.stringify([...snapshot.changedFiles].sort()) !== JSON.stringify([...permit.changedFiles].sort()) ||
      JSON.stringify([...snapshot.changedFiles].sort()) !== JSON.stringify([...snapshot.reviewDecision.approvedFiles].sort()) ||
      snapshot.reviewDecision.requiredChecks.some((check) => !permit.snapshotCheckMappings.some((mapping) =>
        mapping.checkSpecSha256 === incorporationHash(JSON.stringify(check)) &&
        permit.checks.some((proof) => proof.checkId === mapping.canonicalCheckId)))) {
    throw new Error("published_output_approved_snapshot_binding_required");
  }
  const patch = await deps.readPatch(snapshot);
  if (incorporationHash(patch) !== permit.patchSha256) throw new Error("published_output_patch_hash_mismatch");
  const prepared = await deps.readPrepared();
  let receipt: IncorporationReceipt;
  if (prepared) {
    receipt = incorporationReceiptSchema.parse(prepared.receipt);
    if (receipt.permitSha256 !== input.permitSha256 ||
        !incorporationBytes(receipt.permit).equals(incorporationBytes(permit)) ||
        receipt.statusSha256 !== incorporationHash(prepared.status) ||
        JSON.stringify(receipt.paths.map((path) => path.path).sort()) !== JSON.stringify([...snapshot.changedFiles].sort())) {
      throw new Error("published_output_preparation_conflict");
    }
  } else {
    await deps.assertQuiescent();
    await deps.assertSourceMatches(snapshot);
    const proof = await deps.verify(snapshot, patch);
    const status = await deps.readStatus();
    await deps.assertSourceMatches(snapshot);
    await deps.assertQuiescent();
    receipt = incorporationReceiptSchema.parse({ schemaVersion: 1,
      provenance: "operator_attested_publication_incorporation", permitSha256: input.permitSha256,
      permit, ...proof, statusSha256: incorporationHash(status) });
    await deps.publish(receipt, patch, status);
  }
  const receiptPath = `${input.archivePath}/publication-incorporation.json`;
  const decision: TerminalOutputDecision = {
      schemaVersion: 1, jobId: permit.workerJobId, status: "integrated", closedAt: permit.verifiedAt,
      commitSha: permit.publishedSha, archivePath: input.archivePath,
      note: `Reconciled reviewed publication incorporation ${permit.reviewedOutputId}.`,
      publicationIncorporation: { path: receiptPath, sha256: incorporationHash(incorporationBytes(receipt)) },
      backup: { workspace: permit.sourceWorkspace, statusPath: `${input.archivePath}/git-status.txt`,
        patchPath: `${input.archivePath}/tracked.diff` },
    };
  if (!await deps.isCommitted(decision)) {
    await deps.assertQuiescent();
    await deps.assertSourceMatches(snapshot);
    await deps.assertQuiescent();
  }
  return await recordTerminalOutputDecision({ writer: deps.writer }, {
    allowedLedgerRoots: ledgerRoots, ledgerRoot: ledgerRoots[0]!, decision,
  });
}
