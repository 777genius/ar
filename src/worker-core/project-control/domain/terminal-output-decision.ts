import {
  RETAINED_NONQUALIFIED_STATUS,
  retainedNonqualifiedRetentionProblems,
  type RetainedNonqualifiedRetention,
} from "./retained-nonqualified-attempt";

export const TERMINAL_OUTPUT_STATUSES = [
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
  "failed_no_output",
  "reviewed_no_change",
  RETAINED_NONQUALIFIED_STATUS,
] as const;

export type TerminalOutputStatus = typeof TERMINAL_OUTPUT_STATUSES[number];

export type TerminalOutputBackup = {
  readonly workspace: string;
  readonly statusPath: string;
  readonly patchPath?: string;
  readonly numstatPath?: string;
  readonly untrackedArchivePath?: string;
};

export type TerminalOutputDecision = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attemptId?: string;
  readonly status: TerminalOutputStatus;
  readonly closedAt: string;
  readonly commitSha?: string;
  readonly publicationIncorporation?: { readonly path: string; readonly sha256: string };
  readonly archivePath?: string;
  readonly failure?: {
    readonly category: string;
    readonly code: string;
  };
  readonly output?: {
    readonly authoredChanges: boolean;
    readonly workspaceDirty: boolean;
  };
  readonly preexistingWorkspacePatch?: {
    readonly path: string;
    readonly sha256: string;
  };
  /** Only valid with status retained_nonqualified; see retained-nonqualified-attempt. */
  readonly retention?: RetainedNonqualifiedRetention;
  readonly note: string;
  readonly backup: TerminalOutputBackup;
};

export function assertTerminalOutputDecision(
  decision: TerminalOutputDecision,
): TerminalOutputDecision {
  if (!decision.jobId.trim()) throw new Error("terminal_output_job_id_required");
  if (!TERMINAL_OUTPUT_STATUSES.includes(decision.status)) {
    throw new Error("terminal_output_status_invalid");
  }
  if (!decision.closedAt || Number.isNaN(Date.parse(decision.closedAt))) {
    throw new Error("terminal_output_closed_at_invalid");
  }
  if (!decision.note.trim()) throw new Error("terminal_output_note_required");
  if (!decision.backup.workspace || !decision.backup.statusPath) {
    throw new Error("terminal_output_backup_required");
  }
  if (decision.status === "integrated" && !decision.commitSha) {
    throw new Error("terminal_output_integrated_commit_required");
  }
  if (decision.publicationIncorporation && (decision.status !== "integrated" || decision.attemptId !== undefined ||
      !decision.publicationIncorporation.path.startsWith("/") ||
      !/^[a-f0-9]{64}$/.test(decision.publicationIncorporation.sha256))) {
    throw new Error("terminal_output_publication_incorporation_invalid");
  }
  if (
    decision.status === "failed_no_output" &&
    (
      !decision.failure?.category ||
      !decision.failure.code ||
      decision.output?.authoredChanges !== false ||
      decision.output.workspaceDirty !== false
    )
  ) {
    throw new Error("terminal_output_failed_no_output_evidence_required");
  }
  assertRetainedNonqualifiedDecision(decision);
  if (
    decision.preexistingWorkspacePatch &&
    (
      !decision.preexistingWorkspacePatch.path.trim() ||
      !/^[a-f0-9]{64}$/i.test(decision.preexistingWorkspacePatch.sha256)
    )
  ) {
    throw new Error("terminal_output_preexisting_patch_evidence_invalid");
  }
  return decision;
}

/**
 * retained_nonqualified is a custody-only disposition: it needs the bound
 * receipt and a complete backup, and it must not carry any claim that other
 * statuses make (commit, failure/no-output evidence, publication, attempt).
 * Every other status must not carry a retention block, so a forged field can
 * never turn an ordinary record into this disposition.
 */
function assertRetainedNonqualifiedDecision(decision: TerminalOutputDecision): void {
  if (decision.status !== RETAINED_NONQUALIFIED_STATUS) {
    if (decision.retention !== undefined) throw new Error("terminal_output_retention_forbidden");
    return;
  }
  const retention: unknown = decision.retention;
  if (retainedNonqualifiedRetentionProblems(retention).length > 0 ||
      !decision.archivePath || !decision.backup.patchPath || !decision.backup.numstatPath ||
      !decision.backup.untrackedArchivePath ||
      !(retention as RetainedNonqualifiedRetention).receiptPath.startsWith(`${decision.archivePath}/`)) {
    throw new Error("terminal_output_retained_nonqualified_retention_required");
  }
  if (decision.commitSha !== undefined || decision.failure !== undefined || decision.output !== undefined ||
      decision.preexistingWorkspacePatch !== undefined || decision.publicationIncorporation !== undefined ||
      decision.attemptId !== undefined) {
    throw new Error("terminal_output_retained_nonqualified_claims_forbidden");
  }
}
