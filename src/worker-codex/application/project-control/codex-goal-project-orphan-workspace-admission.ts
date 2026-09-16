import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ProjectDebtReason,
  consumedDebt,
  consumedOutputRecordFor,
  type ConsumedOutputLedger,
  type ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { ledgerEpochOrphanWorkspaceBindingMatches } from
  "./codex-goal-ledger-epoch-orphan-quarantine";
import { matchesProjectControlPrefix, nodeErrorCode } from
  "./codex-goal-project-utils";

const execFileAsync = promisify(execFile);
export const ORPHAN_GIT_STATUS_TIMEOUT_ENV =
  "SUBSCRIPTION_RUNTIME_ORPHAN_GIT_STATUS_TIMEOUT_MS";
export const DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS = 30_000;
export const MAX_ORPHAN_GIT_STATUS_TIMEOUT_MS = 120_000;

export function normalizeOrphanGitStatusTimeoutMs(
  value: string | undefined,
): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    return DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_ORPHAN_GIT_STATUS_TIMEOUT_MS;
  return Math.min(parsed, MAX_ORPHAN_GIT_STATUS_TIMEOUT_MS);
}

export async function orphanDirtyWorkspaceDebt(input: {
  readonly root: string;
  readonly prefixes: readonly string[];
  readonly knownWorkspacePaths: ReadonlySet<string>;
  readonly consumedOutput: ConsumedOutputLedger;
  readonly orphanWorkspaceBindings:
    readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly deniedRoots: readonly string[];
}): Promise<readonly ProjectDebtItem[]> {
  const root = resolve(input.root);
  const gitStatusTimeoutMs = normalizeOrphanGitStatusTimeoutMs(
    process.env[ORPHAN_GIT_STATUS_TIMEOUT_ENV],
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return [];
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: root,
      severity: "blocking",
      evidence: [
        `workspace root unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
  }
  const debt: ProjectDebtItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!matchesProjectControlPrefix(entry.name, input.prefixes)) continue;
    const workspacePath = join(root, entry.name);
    if (!await pathLooksLikeGitWorkspace(workspacePath)) continue;
    const resolved = await optionalRealPath(workspacePath);
    if (input.knownWorkspacePaths.has(resolve(workspacePath)) ||
      (resolved !== undefined && input.knownWorkspacePaths.has(resolved))) continue;

    const consumed = consumedOutputRecordFor({
      ledger: input.consumedOutput,
      jobId: entry.name,
      workspacePath,
      ...(resolved ? { resolvedWorkspacePath: resolved } : {}),
    });
    if (consumed && !consumed.retentionEvidenceMissing) {
      debt.push(...consumedRecordDebt(input.consumedOutput, consumed));
      continue;
    }
    const status = await gitStatusShort(workspacePath, gitStatusTimeoutMs);
    if (status.ok && status.lines.length === 0) continue;
    const binding = input.orphanWorkspaceBindings.find((candidate) =>
      candidate.state === "quarantined" &&
      (resolve(candidate.declaredPath) === resolve(workspacePath) ||
        (resolved !== undefined && candidate.canonicalPath === resolved))
    );
    if (status.ok && binding && await ledgerEpochOrphanWorkspaceBindingMatches({
      binding,
      deniedRoots: input.deniedRoots,
    })) {
      debt.push({
        reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
        subject: workspacePath,
        severity: "info",
        evidence: [
          "orphan workspace is preserved unchanged by an active ledger epoch",
          `workspace content sha256 ${binding.contentSha256}`,
          `workspace inode ${binding.device}:${binding.inode}`,
          ...(binding.statusPreview ?? []).slice(0, 5),
        ],
      });
      continue;
    }
    debt.push({
      reason: status.ok
        ? ProjectDebtReason.OrphanLegacyWorkspace
        : ProjectDebtReason.UnreadableWorkspace,
      subject: workspacePath,
      severity: "blocking",
      evidence: status.ok
        ? [
            "dirty project workspace is not represented by the controller registry",
            ...status.lines.slice(0, 5),
          ]
        : [`git status failed: ${status.error}`],
    });
  }
  return debt;
}

function consumedRecordDebt(
  ledger: ConsumedOutputLedger,
  record: Parameters<typeof consumedDebt>[0],
): readonly ProjectDebtItem[] {
  const debt = consumedDebt(record);
  const alreadyReported = ledger.debt.some((item) =>
    (item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord ||
      item.reason === ProjectDebtReason.RetentionEvidenceMissing) &&
    item.subject === record.ledgerPath
  );
  return alreadyReported
    ? debt.filter((item) =>
      item.reason !== ProjectDebtReason.IncompleteConsumedOutputRecord &&
      item.reason !== ProjectDebtReason.RetentionEvidenceMissing)
    : debt;
}

async function pathLooksLikeGitWorkspace(path: string): Promise<boolean> {
  try {
    await lstat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function optionalRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function gitStatusShort(path: string, timeoutMs: number): Promise<
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const result = await execFileAsync("git", [
      "-C", path, "status", "--short", "--untracked-files=all",
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return {
      ok: true,
      lines: result.stdout.split(/\n/).filter((line) => line.length > 0),
    };
  } catch (error) {
    return {
      ok: false,
      error: gitStatusError(error, timeoutMs),
    };
  }
}

function gitStatusError(error: unknown, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof Error && "killed" in error && error.killed === true
    ? `timed out after ${timeoutMs}ms: ${message}`
    : message;
}
