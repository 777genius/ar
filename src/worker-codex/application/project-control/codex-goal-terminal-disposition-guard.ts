import { basename, dirname, join } from "node:path";
import type { ConsumedOutputLedgerSourcePort } from "@vioxen/subscription-runtime/worker-core";

/** File-name-safe job id, exactly as the native terminal ledger writer derives it. */
export const terminalLedgerSafeJobId = (jobId: string) => jobId.replace(/[^a-zA-Z0-9._-]/g, "_");

export const terminalLedgerItemPath = (ledgerRoot: string, jobId: string) =>
  join(ledgerRoot, "items", `${terminalLedgerSafeJobId(jobId)}.json`);

/**
 * A job may have exactly one terminal disposition. Any unreadable ledger root or
 * item, or any entry for the job other than the caller's own ledger path, is a
 * conflict, so a retention or archive can never sit beside another decision.
 */
export async function assertNoConflictingTerminalDisposition(input: {
  readonly source: Pick<ConsumedOutputLedgerSourcePort, "readEntries">;
  readonly ledgerRoot: string;
  readonly jobId: string;
}): Promise<void> {
  const ledgerPath = terminalLedgerItemPath(input.ledgerRoot, input.jobId);
  const safeJobId = terminalLedgerSafeJobId(input.jobId);
  const loaded = await input.source.readEntries({ roots: [input.ledgerRoot] });
  if (loaded.failures.some(failure => failure.subject === input.ledgerRoot || failure.subject === dirname(ledgerPath) ||
    basename(failure.subject) === `${safeJobId}.json` || basename(failure.subject).startsWith(`${safeJobId}--`)) ||
    loaded.entries.some(entry => typeof entry.value === "object" && entry.value !== null && "jobId" in entry.value &&
      entry.value.jobId === input.jobId && entry.ledgerPath !== ledgerPath)) {
    throw new Error("consumed_output_ledger_terminal_conflict");
  }
}
