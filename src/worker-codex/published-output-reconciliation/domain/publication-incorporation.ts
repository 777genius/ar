import { createHash } from "node:crypto";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const text = z.string().min(1).max(4096);
const path = text.refine((value) => value.startsWith("/") && !value.includes("\0"));
const changedPath = text.refine((p) => !p.startsWith("/") &&
  !p.split("/").some((part) => part === ".." || part === "." || part === "") && !p.includes("\0"));
const entry = z.object({ mode: z.enum(["100644", "100755", "120000"]),
  type: z.literal("blob"), oid: sha }).strict().nullable();
export const incorporationPermitSchema = z.object({
  schemaVersion: z.literal(1), operation: z.literal("reconcile_published_reviewed_output"),
  controllerJobId: text, projectId: text, workerJobId: text, reviewedOutputId: hash,
  reviewedBy: text, reviewDecisionSha256: hash, patchSha256: hash, sourceBase: sha,
  sourceWorkspace: path, targetWorkspace: path,
  changedFiles: z.array(changedPath).min(1).max(256),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  remote: z.string().regex(/^[A-Za-z0-9_.-]+$/), branch: text,
  publishedSha: sha, canonicalHead: sha,
  operator: text, verifiedAt: z.string().datetime(),
  verificationMethod: z.literal("authenticated_gh_api"),
  ownerLogin: z.literal("777genius"), authorEmail: z.literal("iliyazelenkog@gmail.com"),
  publicationEvidenceSha256: hash,
  publicationEvidencePath: path,
  sourceReviewEvidence: z.object({ path, sha256: hash }).strict(),
  additionalEvidence: z.array(z.object({ path, sha256: hash }).strict()).max(20),
  requiredCanonicalChecks: z.array(text).min(1).max(100),
  snapshotCheckMappings: z.array(z.object({ checkSpecSha256: hash, canonicalCheckId: text }).strict()).max(100),
  checks: z.array(z.object({ checkId: text, commitSha: sha,
    conclusion: z.literal("success"), evidenceSha256: hash, evidencePath: path }).strict()).min(1).max(100),
  review: z.object({ reviewedSha: sha, reviewedTree: sha, decision: z.literal("approved"),
    reviewedBy: text, evidenceSha256: hash, evidencePath: path }).strict(),
}).strict().superRefine((permit, ctx) => {
  if (permit.checks.some((check) => check.commitSha !== permit.publishedSha) ||
      new Set(permit.changedFiles).size !== permit.changedFiles.length ||
      permit.requiredCanonicalChecks.some((id) => !permit.checks.some((check) => check.checkId === id)) ||
      new Set(permit.requiredCanonicalChecks).size !== permit.requiredCanonicalChecks.length ||
      new Set(permit.checks.map((check) => check.checkId)).size !== permit.checks.length) {
    ctx.addIssue({ code: "custom", message: "published_output_exact_sha_evidence_required" });
  }
});
export type IncorporationPermit = z.infer<typeof incorporationPermitSchema>;
export const incorporationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.literal("operator_attested_publication_incorporation"),
  permitSha256: hash, permit: incorporationPermitSchema,
  sourceTree: sha, sourceParents: z.array(sha), reconstructedTree: sha,
  publishedTree: sha, publishedParents: z.array(sha),
  paths: z.array(z.object({ path: changedPath,
    before: entry, after: entry, published: entry }).strict()).min(1).max(256),
  statusSha256: hash,
}).strict().superRefine((receipt, ctx) => {
  if (new Set(receipt.paths.map((item) => item.path)).size !== receipt.paths.length ||
      JSON.stringify(receipt.paths.map((item) => item.path).sort()) !== JSON.stringify([...receipt.permit.changedFiles].sort()) ||
      receipt.publishedTree !== receipt.permit.review.reviewedTree ||
      receipt.paths.some((item) => JSON.stringify(item.after) !== JSON.stringify(item.published) ||
        JSON.stringify(item.before) === JSON.stringify(item.after))) {
    ctx.addIssue({ code: "custom", message: "published_output_path_proof_invalid" });
  }
});
export type IncorporationReceipt = z.infer<typeof incorporationReceiptSchema>;
export const incorporationHash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const incorporationBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function incorporationEvidenceReferences(permit: IncorporationPermit) {
  return [{ path: permit.publicationEvidencePath, sha256: permit.publicationEvidenceSha256 },
    permit.sourceReviewEvidence, { path: permit.review.evidencePath, sha256: permit.review.evidenceSha256 },
    ...permit.checks.map((check) => ({ path: check.evidencePath, sha256: check.evidenceSha256 })), ...permit.additionalEvidence];
}

export function assertIncorporationLedgerBinding(receipt: IncorporationReceipt,
  record: { jobId?: unknown; status?: unknown; commitSha?: unknown;
    attemptId?: unknown; closedAt?: unknown; backup?: unknown }): void {
  const backup = record.backup as { workspace?: unknown } | undefined;
  if (record.status !== "integrated" || record.attemptId !== undefined ||
      record.jobId !== receipt.permit.workerJobId || record.commitSha !== receipt.permit.publishedSha ||
      record.closedAt !== receipt.permit.verifiedAt || backup?.workspace !== receipt.permit.sourceWorkspace) {
    throw new Error("published_output_receipt_ledger_binding_mismatch");
  }
}
