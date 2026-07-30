import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
  ConsumedOutputLedgerWriterPort,
  IntegratedOutputLedgerPort,
  IntegratedOutputLedgerPreparation,
  IntegratedOutputLedgerReceipt,
  IntegrationAttempt,
  RejectedOutputLedgerPreparation,
  RejectedOutputLedgerReceipt,
  TerminalOutputDecision,
  TerminalOutputDecisionReceipt,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);

export class LocalConsumedOutputLedgerWriter
  implements ConsumedOutputLedgerWriterPort {
  async assertCanRecord(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<void> {
    const ledgerPath = terminalLedgerPath(input.ledgerRoot, input.decision);
    let existing: string;
    try {
      existing = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return;
      throw error;
    }
    if (!sameTerminalDecision(existing, input.decision)) {
      throw new Error("consumed_output_ledger_terminal_conflict");
    }
  }

  async record(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<TerminalOutputDecisionReceipt> {
    const ledgerPath = terminalLedgerPath(
      input.ledgerRoot,
      input.decision,
    );
    await mkdir(dirname(ledgerPath), { recursive: true });
    const contents = `${JSON.stringify(ledgerRecord(input.decision), null, 2)}\n`;
    const tmpPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, contents, { flag: "wx" });
    try {
      await link(tmpPath, ledgerPath);
      return { ledgerPath, decision: input.decision, idempotentReplay: false };
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      const existing = await readFile(ledgerPath, "utf8");
      if (!sameTerminalDecision(existing, input.decision)) {
        throw new Error("consumed_output_ledger_terminal_conflict");
      }
      return { ledgerPath, decision: input.decision, idempotentReplay: true };
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

export type LocalTerminalOutputBackupCapture = {
  readonly archivePath: string;
  readonly statusPath: string;
  readonly patchPath: string;
  readonly numstatPath: string;
  readonly hasAuthoredOutput: boolean;
};

export async function captureLocalTerminalOutputBackup(input: {
  readonly archiveRoot: string;
  readonly archiveName: string;
  readonly workspacePath: string;
  readonly changedFiles: readonly string[];
  readonly sourcePatchPath?: string;
  readonly gitBinaryPath?: string;
}): Promise<LocalTerminalOutputBackupCapture> {
  await ensurePrivateDirectory(input.archiveRoot);
  const archivePath = join(input.archiveRoot, safeLedgerName(input.archiveName));
  await ensurePrivateDirectory(archivePath);
  const statusPath = join(archivePath, "git-status.txt");
  const patchPath = join(archivePath, "tracked.diff");
  const numstatPath = join(archivePath, "tracked.numstat");
  await publishExactText(statusPath, await localGitOutput({
    cwd: input.workspacePath,
    args: ["status", "--short"],
    ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
  }));
  if (input.sourcePatchPath) {
    await publishExactFile(patchPath, input.sourcePatchPath);
  } else {
    await publishExactBytes(
      patchPath,
      input.changedFiles.length === 0
        ? Buffer.alloc(0)
        : await localGitOutputBytes({
            cwd: input.workspacePath,
            args: ["diff", "--binary", "--", ...input.changedFiles],
            ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
          }),
    );
  }
  await publishExactText(
    numstatPath,
    input.changedFiles.length === 0
      ? ""
      : await localGitOutput({
          cwd: input.workspacePath,
          args: ["diff", "--numstat", "--", ...input.changedFiles],
          ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
        }),
  );
  return {
    archivePath,
    statusPath,
    patchPath,
    numstatPath,
    hasAuthoredOutput: await anyFileHasBytes([patchPath, numstatPath]),
  };
}

export type LocalIntegratedOutputLedgerAdapterOptions = {
  readonly ledgerRoots: readonly string[];
  readonly archiveRoot: string;
  readonly gitBinaryPath?: string;
};

export class LocalIntegratedOutputLedgerAdapter
  implements IntegratedOutputLedgerPort {
  private readonly writer = new LocalConsumedOutputLedgerWriter();

  constructor(private readonly options: LocalIntegratedOutputLedgerAdapterOptions) {}

  async prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation> {
    const ledgerRoot = this.requiredLedgerRoot();
    const archivePath = join(
      this.options.archiveRoot,
      `${safeLedgerName(input.attempt.workerOutput.workerJobId)}-integrated-${input.commitSha.slice(0, 12)}-${safeLedgerName(input.attempt.attemptId)}`,
    );
    await ensurePrivateDirectory(this.options.archiveRoot);
    await ensurePrivateDirectory(archivePath);
    const statusPath = join(archivePath, "git-status.txt");
    const patchPath = join(archivePath, "tracked.diff");
    const numstatPath = join(archivePath, "tracked.numstat");
    await publishExactText(statusPath, await this.gitOutput(
      input.attempt.workerOutput.workspacePath,
      ["status", "--short"],
    ));
    await publishExactBytes(patchPath, await this.gitOutputBytes(
      input.attempt.targetWorkspacePath,
      ["show", "--format=", "--binary", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles],
    ));
    await publishExactText(numstatPath, await this.gitOutput(
      input.attempt.targetWorkspacePath,
      ["show", "--format=", "--numstat", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles],
    ));
    const preparation: IntegratedOutputLedgerPreparation = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      commitSha: input.commitSha,
      archivePath,
      statusPath,
      patchPath,
      numstatPath,
    };
    await publishExactJson(
      join(ledgerRoot, "preparations", `${safeLedgerName(input.attempt.attemptId)}.json`),
      preparation,
    );
    return preparation;
  }

  async preflightFinalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
    readonly pushedAt?: string;
  }): Promise<void> {
    await this.writer.assertCanRecord({
      ledgerRoot: this.requiredLedgerRoot(),
      decision: integratedDecision(
        input.preparation,
        input.pushedAt ?? "1970-01-01T00:00:00.000Z",
      ),
    });
  }

  async finalize(input: {
    readonly preparation: IntegratedOutputLedgerPreparation;
    readonly pushedAt: string;
  }): Promise<IntegratedOutputLedgerReceipt> {
    const ledgerRoot = this.requiredLedgerRoot();
    const receipt = await this.writer.record({
      ledgerRoot,
      decision: integratedDecision(input.preparation, input.pushedAt),
    });
    return {
      ledgerPath: receipt.ledgerPath,
      archivePath: input.preparation.archivePath,
      commitSha: input.preparation.commitSha,
      idempotentReplay: receipt.idempotentReplay,
    };
  }

  async prepareRejection(input: {
    readonly attempt: IntegrationAttempt;
  }): Promise<RejectedOutputLedgerPreparation> {
    const ledgerRoot = this.requiredLedgerRoot();
    const captured = await captureLocalTerminalOutputBackup({
      archiveRoot: this.options.archiveRoot,
      archiveName:
        `${input.attempt.workerOutput.workerJobId}-rejected-${input.attempt.attemptId}`,
      workspacePath: input.attempt.workerOutput.workspacePath,
      changedFiles: input.attempt.workerOutput.changedFiles,
      ...(input.attempt.workerOutput.patchPath
        ? { sourcePatchPath: input.attempt.workerOutput.patchPath }
        : {}),
      ...(this.options.gitBinaryPath
        ? { gitBinaryPath: this.options.gitBinaryPath }
        : {}),
    });
    const preparation: RejectedOutputLedgerPreparation = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      ...captured,
    };
    await publishExactJson(
      join(
        ledgerRoot,
        "rejection-preparations",
        `${safeLedgerName(input.attempt.attemptId)}.json`,
      ),
      preparation,
    );
    return preparation;
  }

  async finalizeRejection(input: {
    readonly preparation: RejectedOutputLedgerPreparation;
    readonly rejectedAt: string;
    readonly reason: string;
  }): Promise<RejectedOutputLedgerReceipt> {
    const ledgerRoot = this.requiredLedgerRoot();
    const status = input.preparation.hasAuthoredOutput
      ? "rejected"
      : "failed_no_output";
    const note = input.preparation.hasAuthoredOutput
      ? `Rejected reviewed worker output via project lifecycle attempt ${input.preparation.attemptId}: ${input.reason}`
      : `Closed attempt ${input.preparation.attemptId} without archived authored output: ${input.reason}`;
    const receipt = await this.writer.record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: input.preparation.workerJobId,
        attemptId: input.preparation.attemptId,
        status,
        closedAt: input.rejectedAt,
        archivePath: input.preparation.archivePath,
        ...(status === "failed_no_output"
          ? {
              failure: {
                category: "infrastructure",
                code: "rejected_without_authored_output",
              },
              output: { authoredChanges: false, workspaceDirty: false },
            }
          : {}),
        note,
        backup: {
          workspace: input.preparation.workerWorkspacePath,
          statusPath: input.preparation.statusPath,
          patchPath: input.preparation.patchPath,
          numstatPath: input.preparation.numstatPath,
        },
      },
    });
    return {
      ledgerPath: receipt.ledgerPath,
      archivePath: input.preparation.archivePath,
      status,
      idempotentReplay: receipt.idempotentReplay,
    };
  }

  private requiredLedgerRoot(): string {
    if (this.options.ledgerRoots.length !== 1) {
      throw new Error("project_integration_consumed_output_ledger_required");
    }
    return this.options.ledgerRoots[0]!;
  }

  private async gitOutput(cwd: string, args: readonly string[]): Promise<string> {
    const result = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      [...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );
    return result.stdout;
  }

  private async gitOutputBytes(
    cwd: string,
    args: readonly string[],
  ): Promise<Buffer> {
    const result = await execFileAsync(
      this.options.gitBinaryPath ?? "git",
      [...args],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    return result.stdout;
  }
}

async function localGitOutput(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly gitBinaryPath?: string;
}): Promise<string> {
  const result = await execFileAsync(
    input.gitBinaryPath ?? "git",
    [...input.args],
    { cwd: input.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
  );
  return result.stdout;
}

async function localGitOutputBytes(input: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly gitBinaryPath?: string;
}): Promise<Buffer> {
  const result = await execFileAsync(
    input.gitBinaryPath ?? "git",
    [...input.args],
    {
      cwd: input.cwd,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  return result.stdout;
}

function sameTerminalDecision(
  existingJson: string,
  decision: TerminalOutputDecision,
): boolean {
  try {
    const existing: unknown = JSON.parse(existingJson);
    return isDeepStrictEqual(existing, ledgerRecord(decision));
  } catch {
    return false;
  }
}

async function publishExactJson(path: string, value: unknown): Promise<void> {
  await publishExactText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function publishExactFile(path: string, sourcePath: string): Promise<void> {
  await publishExactBytes(path, await readRegularFileNoFollow(sourcePath));
}

async function anyFileHasBytes(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if ((await stat(path)).size > 0) return true;
  }
  return false;
}

async function publishExactText(path: string, contents: string): Promise<void> {
  await publishExactBytes(path, Buffer.from(contents));
}

async function publishExactBytes(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, contents, { flag: "wx", mode: 0o600 });
  try {
    await link(tmpPath, path);
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) throw error;
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
  await assertExactPrivateFile(path, contents);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const item = await handle.stat();
    if (!item.isDirectory()) {
      throw new Error("integrated_output_ledger_archive_unsafe");
    }
    await handle.chmod(0o700);
    if (((await handle.stat()).mode & 0o777) !== 0o700) {
      throw new Error("integrated_output_ledger_archive_unsafe");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integrated_output_ledger_archive_unsafe"
    ) {
      throw error;
    }
    throw new Error("integrated_output_ledger_archive_unsafe");
  } finally {
    await handle?.close();
  }
}

async function readRegularFileNoFollow(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error("integrated_output_ledger_source_patch_unsafe");
    }
    const contents = await handle.readFile();
    const confirmed = await handle.stat();
    if (
      confirmed.dev !== opened.dev ||
      confirmed.ino !== opened.ino ||
      confirmed.size !== opened.size ||
      confirmed.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("integrated_output_ledger_source_patch_unsafe");
    }
    return contents;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integrated_output_ledger_source_patch_unsafe"
    ) {
      throw error;
    }
    throw new Error("integrated_output_ledger_source_patch_unsafe");
  } finally {
    await handle?.close();
  }
}

async function assertExactPrivateFile(
  path: string,
  expected: Buffer,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expected.byteLength) {
      throw new Error("integrated_output_ledger_preparation_conflict");
    }
    const actual = await handle.readFile();
    if (!actual.equals(expected)) {
      throw new Error("integrated_output_ledger_preparation_conflict");
    }
    await handle.chmod(0o600);
    const confirmed = await handle.stat();
    if (
      confirmed.dev !== opened.dev ||
      confirmed.ino !== opened.ino ||
      confirmed.size !== opened.size ||
      confirmed.mtimeMs !== opened.mtimeMs ||
      (confirmed.mode & 0o777) !== 0o600
    ) {
      throw new Error("integrated_output_ledger_preparation_unsafe");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === "integrated_output_ledger_preparation_conflict" ||
        error.message === "integrated_output_ledger_preparation_unsafe"
      )
    ) {
      throw error;
    }
    throw new Error("integrated_output_ledger_preparation_unsafe");
  } finally {
    await handle?.close();
  }
}

function ledgerRecord(decision: TerminalOutputDecision): Record<string, unknown> {
  return {
    ...decision,
    consumedAt: decision.closedAt,
    ...(decision.commitSha
      ? {
          integratedCommitSha: decision.commitSha,
          commit: decision.commitSha,
        }
      : {}),
    notes: [{
      status: decision.status,
      text: decision.note,
      ...(decision.commitSha ? { commit: decision.commitSha } : {}),
    }],
  };
}

function integratedDecision(
  preparation: IntegratedOutputLedgerPreparation,
  pushedAt: string,
): TerminalOutputDecision {
  return {
    schemaVersion: 1,
    jobId: preparation.workerJobId,
    attemptId: preparation.attemptId,
    status: "integrated",
    closedAt: pushedAt,
    commitSha: preparation.commitSha,
    archivePath: preparation.archivePath,
    note: `Integrated reviewed worker output via project lifecycle attempt ${preparation.attemptId}.`,
    backup: {
      workspace: preparation.workerWorkspacePath,
      statusPath: preparation.statusPath,
      patchPath: preparation.patchPath,
      numstatPath: preparation.numstatPath,
    },
  };
}

function terminalLedgerPath(
  ledgerRoot: string,
  decision: TerminalOutputDecision,
): string {
  const attemptSuffix = decision.attemptId
    ? `--${safeLedgerName(decision.attemptId)}`
    : "";
  return join(
    ledgerRoot,
    "items",
    `${safeLedgerName(decision.jobId)}${attemptSuffix}.json`,
  );
}

function safeLedgerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
