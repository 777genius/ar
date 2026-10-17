import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  RETAINED_NONQUALIFIED_MAX_RECEIPT_BYTES,
  RetainedNonqualifiedOriginalKind,
  assertRetainedNonqualifiedReceipt,
  retainedNonqualifiedReceiptLimits,
  ProjectDebtReason,
  type ConsumedOutputLedger,
  type ConsumedOutputRecord,
  type ProjectDebtItem,
  RETAINED_NONQUALIFIED_LIFECYCLE_ROLES,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from "../../codex-goal-jobs";
import { stringValue } from "../codex-goal-input-values";
import { admissionWorkspacePathsMatch } from "./codex-goal-project-admission-paths";
import { captureLegacyAttemptProcessEvidence } from "./codex-goal-legacy-attempt-process-evidence";
import { assertRetainedReservationInactive, captureRetainedLifecycle, lifecycleBytes, readRegularFileWithMode,
  retainedLifecyclePaths } from "./codex-goal-retained-nonqualified-lifecycle";
import { captureRetainedWorkspaceInventory } from "./codex-goal-retained-nonqualified-inventory";
import { serializeRetainedHeavyWork } from "./codex-goal-retained-nonqualified-resources";
import { hashHeldImmutableFile } from "../../../worker-local/project-control-evidence-custody-held-stat";

type JsonObject = Readonly<Record<string, unknown>>;
export type RetainedNonqualifiedAdmissionVerdict =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: string };

/** Admission-side state for one job: whether retained custody is verified, and its blocking debt if not. */
export async function retainedNonqualifiedAdmission(input: {
  readonly jobId: string;
  readonly item: JsonObject;
  readonly ledger: ConsumedOutputLedger;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly registryRootDir: string;
  readonly readJob: Parameters<typeof verifyRetainedNonqualifiedAdmission>[0]["readJob"];
}): Promise<{ readonly verified: boolean; unverifiedDebt(subject: string): ProjectDebtItem }> {
  const record = input.ledger.byJobId.get(input.jobId);
  const verdict = record?.status === "retained_nonqualified"
    ? await verifyRetainedNonqualifiedAdmission({ ...input, record })
    : undefined;
  return {
    verified: verdict?.verified === true,
    unverifiedDebt: (subject) => ({
      reason: ProjectDebtReason.IncompleteConsumedOutputRecord, subject, severity: "blocking",
      evidence: [`${input.jobId} retained nonqualified custody is not verified against the present originals`,
        verdict && !verdict.verified ? verdict.reason : "retained_nonqualified_record_unverified"],
    }),
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Admission may treat a retained_nonqualified ledger record as consuming a
 * stopped dirty workspace only while the exact retained originals are still
 * what is on disk now: the immutable receipt, the job manifest, the original
 * result/progress/event/stop-event state and the complete workspace inventory.
 * Any change (a replay, a restart, an edit, a swapped receipt) restores debt.
 * The record alone, which a forged field could imitate, is never enough.
 */
export async function verifyRetainedNonqualifiedAdmission(input: {
  readonly record: ConsumedOutputRecord;
  readonly item: JsonObject;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly registryRootDir: string;
  readonly readJob: ((input: { readonly registryRootDir: string; readonly jobId: string }) => Promise<CodexGoalJobManifest>) | undefined;
}): Promise<RetainedNonqualifiedAdmissionVerdict> {
  const refuse = (reason: string): RetainedNonqualifiedAdmissionVerdict => ({ verified: false, reason });
  try {
    const { record, item, summary } = input;
    const retained = record.retainedNonqualified;
    if (!retained || !record.structurallyValid || !summary || !input.readJob || summary.jobId !== record.jobId) {
      return refuse("retained_nonqualified_record_unverified");
    }
    // A stopped dirty attempt only: any live process or conflicting risk is not retained custody.
    if (item.workerAlive !== false || item.workerProcessAlive === true || item.progressProcessAlive === true ||
        item.workspaceDirty !== true || item.workspaceConflict === true ||
        (item.activeWriterRisk !== "none" && item.activeWriterRisk !== "dirty_workspace_without_worker")) {
      return refuse("retained_nonqualified_attempt_not_stopped");
    }
    const receiptBytes = (await readRegularFileWithMode(retained.receiptPath, RETAINED_NONQUALIFIED_MAX_RECEIPT_BYTES)).bytes;
    if (sha256(receiptBytes) !== retained.receiptSha256) return refuse("retained_nonqualified_receipt_hash_mismatch");
    const receipt = assertRetainedNonqualifiedReceipt(JSON.parse(receiptBytes.toString("utf8")));
    if (receipt.kind !== retained.kind || receipt.workerJobId !== record.jobId) return refuse("retained_nonqualified_receipt_identity_mismatch");
    // The one validated, hash-bound policy of this receipt bounds every read below; nothing uses an ambient default.
    // The complete policy and payload lengths were validated above, before any large allocation.
    const limits = retainedNonqualifiedReceiptLimits(receipt);
    const readJob = input.readJob;
    // Admission needs NO memory authority under any policy: payloads and workspace files are verified by streaming
    // hashes through held descriptors (one chunk resident), and the only buffered read is the lifecycle bounded by the
    // ordinary 64 MiB. Heavy verification still runs one at a time in this process.
    return await serializeRetainedHeavyWork(async (): Promise<RetainedNonqualifiedAdmissionVerdict> => {
    const manifest = await readJob({ registryRootDir: input.registryRootDir, jobId: record.jobId });
    if (manifest.jobId !== record.jobId || stringValue(item.workspacePath) === undefined ||
        !await admissionWorkspacePathsMatch(manifest.workspacePath, receipt.workspace) ||
        !await admissionWorkspacePathsMatch(summary.workspacePath, receipt.workspace) ||
        !await admissionWorkspacePathsMatch(stringValue(item.workspacePath)!, receipt.workspace)) {
      return refuse("retained_nonqualified_job_identity_changed");
    }
    // Every lifecycle path is derived from the manifest, never taken from the receipt, and each
    // present/absent state, hash, size and mode must be exactly what was archived.
    const paths = retainedLifecyclePaths(manifest, input.registryRootDir);
    const lifecycle = await captureRetainedLifecycle(paths, { collect: true, maxBytes: limits.lifecycleBytes });
    for (const role of RETAINED_NONQUALIFIED_LIFECYCLE_ROLES) {
      if (receipt.original[role].path !== paths[role]) return refuse(`retained_nonqualified_lifecycle_path_changed:${role}`);
      if (JSON.stringify(lifecycle.states[role]) !== JSON.stringify(receipt.original[role])) {
        return refuse(`retained_nonqualified_original_${role}_changed`);
      }
    }
    const manifestState = lifecycle.states.manifest;
    if (manifestState.state !== "present" || manifestState.sha256 !== receipt.workerManifestSha256) {
      return refuse("retained_nonqualified_job_identity_changed");
    }
    // A fresh lease that is active or malformed is a possible live holder. The retained state itself only
    // stays acceptable while it equals the archived (absent or expired) reservation.
    assertRetainedReservationInactive(lifecycleBytes(lifecycle, "accountReservation"));
    // The discriminator is bound to the preserved facts, never taken on trust.
    const absentResult = receipt.original.result.state === "absent";
    if ((receipt.kind === RetainedNonqualifiedOriginalKind.ResultMissing) !== absentResult ||
        (absentResult && item.resultExists === true) || (!absentResult && item.resultExists !== true)) {
      return refuse("retained_nonqualified_original_result_changed");
    }
    // Native flags can miss a new holder with a different PID: reuse the producer's fail-closed custody-path inventory.
    const custodyPaths = [receipt.workspace, manifest.jobRootDir].sort();
    const processes = await captureLegacyAttemptProcessEvidence({ custodyPaths });
    if (processes.blockers.length > 0) return refuse("retained_nonqualified_writer_present");
    // Backup custody: every archival payload still exists and hashes to what the receipt recorded.
    const backupRoot = dirname(retained.receiptPath);
    for (const [file, expected] of Object.entries(receipt.backupFiles)) {
      // A v2 receipt's recorded length is the read cap and must match exactly; a v1 receipt uses the default payload cap.
      const declared = (receipt.payloadLengths as Readonly<Record<string, number>> | undefined)?.[file];
      const payload = await hashHeldImmutableFile(join(backupRoot, file), declared ?? limits.payloadBytes);
      if ((declared !== undefined && payload.length !== declared) || payload.sha256 !== expected) {
        return refuse("retained_nonqualified_backup_changed");
      }
    }
    const inventory = await captureRetainedWorkspaceInventory(receipt.workspace, { ignoredRetain: receipt.ignored.retain, limits });
    if (inventory.headCommit !== receipt.headCommit || inventory.digest !== receipt.inventory.digest ||
        JSON.stringify(inventory.disposableListing) !== JSON.stringify(receipt.ignored.disposableListing)) {
      return refuse("retained_nonqualified_workspace_changed");
    }
    return { verified: true };
    });
  } catch (error) {
    return refuse(`retained_nonqualified_verification_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

