import { assertRetainedTerminalArchivePatchSize, MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES } from "@vioxen/subscription-runtime/worker-core";
import { inspectRetainedTerminalArchive } from "./retained-terminal-archive-io";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
import {
  localProjectControlEvidenceCustodySupported,
  LocalProjectControlEvidenceCustody,
} from
  "./project-control-evidence-custody-local-adapter";
import { CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER } from
  "@vioxen/subscription-runtime/worker-core";
import { LocalWorkspaceIntegrationLock } from "./project-integration-local-adapters";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "./consumed-output-ledger-maintenance-lock";

const execFileAsync = promisify(execFile);

export class LocalConsumedOutputLedgerWriter implements ConsumedOutputLedgerWriterPort {
  constructor(
    private readonly mutationLocks = new LocalConsumedOutputLedgerMutationLock(),
    private readonly custodyRoot?: string,
    private readonly evidenceRoots?: readonly string[],
  ) {}

  async assertCanRecord(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<void> {
    await assertTerminalEvidenceInCanonicalRoots(
      input.decision,
      this.evidenceRoots,
    );
    await assertLedgerRootActive(input.ledgerRoot);
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
    const maintenanceLease = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: input.ledgerRoot,
      owner: `terminal-record:${input.decision.jobId}`,
    });
    let mutationLease;
    let operationError: unknown;
    let receipt: TerminalOutputDecisionReceipt | undefined;
    try {
      mutationLease = await this.mutationLocks.acquire({
        ledgerRoots: [input.ledgerRoot],
        owner: `terminal-output-writer:${input.decision.jobId}`,
        ...(this.custodyRoot ? { custodyRoot: this.custodyRoot } : {}),
      });
      await this.mutationLocks.assertHeld(mutationLease);
      await assertLedgerRootActive(input.ledgerRoot);
      receipt = await this.recordLocked(input);
      await this.mutationLocks.assertHeld(mutationLease);
    } catch (error) {
      operationError = error;
    }
    const releaseError = await releaseAllBestEffort([
      ...(mutationLease
        ? [async () => await this.mutationLocks.release(mutationLease)]
        : []),
      async () => await releaseConsumedOutputLedgerMaintenanceLock(maintenanceLease),
    ]);
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return receipt!;
  }

  private async recordLocked(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }): Promise<TerminalOutputDecisionReceipt> {
    // Revalidate immediately before publication so a path swap after the
    // preflight cannot publish a ledger record bound to out-of-scope evidence.
    await assertTerminalEvidenceInCanonicalRoots(
      input.decision,
      this.evidenceRoots,
    );
    const ledgerPath = terminalLedgerPath(input.ledgerRoot, input.decision);
    await mkdir(dirname(ledgerPath), { recursive: true });
    const contents = `${JSON.stringify(ledgerRecord(input.decision), null, 2)}\n`;
    const tmpPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    let removeTemp = true;
    try {
      try {
        await writeFile(tmpPath, contents, { flag: "wx" });
      } catch (error) {
        // A failed partial write belongs to us; an existing temporary file does not.
        if (isNodeErrorCode(error, "EEXIST")) removeTemp = false;
        throw error;
      }
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
      }
    } finally {
      if (removeTemp) await unlink(tmpPath).catch(() => undefined);
    }
  }
}

async function assertTerminalEvidenceInCanonicalRoots(
  decision: TerminalOutputDecision,
  configuredRoots: readonly string[] | undefined,
): Promise<void> {
  if (configuredRoots === undefined) {
    if (decision.backup.patchPath) await inspectRetainedTerminalArchive(decision.backup.patchPath);
    return;
  }
  if (configuredRoots.length === 0) {
    throw new Error("consumed_output_evidence_root_required");
  }
  const roots = await Promise.all(configuredRoots.map(async (input) => {
    const lexical = resolve(input);
    const metadata = await lstat(lexical);
    const physical = await realpath(lexical);
    if (
      physical !== lexical || metadata.isSymbolicLink() || !metadata.isDirectory()
    ) {
      throw new Error("consumed_output_evidence_root_noncanonical");
    }
    return physical;
  }));
  const directories = decision.archivePath ? [decision.archivePath] : [];
  const files = [
    decision.backup.statusPath,
    decision.backup.patchPath,
    decision.backup.numstatPath,
    decision.backup.untrackedArchivePath,
    decision.preexistingWorkspacePatch?.path,
  ].filter((path): path is string => path !== undefined);
  for (const input of directories) {
    const lexical = resolve(input);
    const [physical, metadata] = await Promise.all([
      realpath(lexical),
      lstat(lexical),
    ]);
    if (
      physical !== lexical || metadata.isSymbolicLink() || !metadata.isDirectory() ||
      !roots.some((root) => pathInsideOrEqual(physical, root))
    ) {
      throw new Error("consumed_output_evidence_directory_outside_root");
    }
  }
  for (const input of files) {
    const lexical = resolve(input);
    const [physical, metadata] = await Promise.all([
      realpath(lexical),
      lstat(lexical),
    ]);
    if (
      physical !== lexical || metadata.isSymbolicLink() || !metadata.isFile() ||
      !roots.some((root) => pathInsideOrEqual(physical, root))
    ) {
      throw new Error("consumed_output_evidence_file_outside_root");
    }
  }
  if (decision.backup.patchPath) {
    await inspectRetainedTerminalArchive(decision.backup.patchPath, { expectedCanonicalPath: resolve(decision.backup.patchPath) });
  }
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

export type ConsumedOutputLedgerMutationLease = {
  readonly locks: readonly {
    readonly port: LocalWorkspaceIntegrationLock;
    readonly lock: Awaited<
      ReturnType<LocalWorkspaceIntegrationLock["acquire"]>
    >;
    readonly ledgerRoot: string;
    readonly device: number;
    readonly inode: number;
  }[];
};

export class LocalConsumedOutputLedgerMutationLock {
  async acquire(input: {
    readonly ledgerRoots: readonly string[];
    readonly owner: string;
    readonly custodyRoot?: string;
  }): Promise<ConsumedOutputLedgerMutationLease> {
    const acquired: Array<ConsumedOutputLedgerMutationLease["locks"][number]> =
      [];
    try {
      const roots = await canonicalLedgerMutationRoots(
        input.ledgerRoots,
        input.custodyRoot,
      );
      for (const identity of roots) {
        const ledgerRoot = identity.canonicalPath;
        const port = new LocalWorkspaceIntegrationLock({
          rootDir: identity.lockRoot,
          staleLockMs: 30 * 60_000,
        });
        const lock = await port.acquire({
          workspacePath: ledgerRoot,
          owner: input.owner,
        });
        acquired.push({
          port,
          lock,
          ledgerRoot,
          device: identity.device,
          inode: identity.inode,
        });
        await assertLedgerMutationRootIdentity(identity);
      }
      return { locks: acquired };
    } catch (error) {
      for (const entry of acquired.reverse()) {
        await entry.port.release(entry.lock).catch(() => undefined);
      }
      throw error;
    }
  }

  async release(lease: ConsumedOutputLedgerMutationLease): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of [...lease.locks].reverse()) {
      try {
        await assertLedgerMutationRootIdentity({
          canonicalPath: entry.ledgerRoot,
          device: entry.device,
          inode: entry.inode,
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await entry.port.release(entry.lock);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw deterministicReleaseError(
      "consumed_output_ledger_mutation_release_failed",
      failures,
    );
  }

  async assertHeld(lease: ConsumedOutputLedgerMutationLease): Promise<void> {
    for (const entry of lease.locks) {
      await assertLedgerMutationRootIdentity({
        canonicalPath: entry.ledgerRoot,
        device: entry.device,
        inode: entry.inode,
      });
    }
  }
}

async function releaseAllBestEffort(
  releases: readonly (() => Promise<void>)[],
): Promise<Error | undefined> {
  const failures: unknown[] = [];
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures.length === 0
    ? undefined
    : deterministicReleaseError("consumed_output_ledger_release_failed", failures);
}

function deterministicReleaseError(message: string, failures: readonly unknown[]): Error {
  return new Error(message, { cause: failures[0] });
}

type LedgerMutationRootIdentity = {
  readonly canonicalPath: string;
  readonly lockRoot: string;
  readonly device: number;
  readonly inode: number;
};

async function canonicalLedgerMutationRoots(
  inputs: readonly string[],
  custodyRoot?: string,
): Promise<readonly LedgerMutationRootIdentity[]> {
  const roots = await Promise.all(inputs.map(async (input) => {
    const requested = resolve(input);
    const lockRoot = await ensureLocalLedgerLockRoot(requested, custodyRoot);
    const metadata = await lstat(requested);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("consumed_output_ledger_lock_root_unsafe");
    }
    const canonicalPath = await realpath(requested);
    if (canonicalPath !== requested) {
      throw new Error("consumed_output_ledger_root_alias_denied");
    }
    return {
      canonicalPath,
      lockRoot,
      device: metadata.dev,
      inode: metadata.ino,
    };
  }));
  const byPath = new Map<string, LedgerMutationRootIdentity>();
  const byIdentity = new Map<string, string>();
  for (const root of roots) {
    const existingPath = byIdentity.get(`${root.device}:${root.inode}`);
    if (existingPath !== undefined && existingPath !== root.canonicalPath) {
      throw new Error("consumed_output_ledger_root_alias_denied");
    }
    byIdentity.set(`${root.device}:${root.inode}`, root.canonicalPath);
    byPath.set(root.canonicalPath, root);
  }
  return [...byPath.values()].sort((left, right) =>
    left.canonicalPath.localeCompare(right.canonicalPath)
  );
}

async function assertLedgerMutationRootIdentity(
  expected: Pick<
    LedgerMutationRootIdentity,
    "canonicalPath" | "device" | "inode"
  >,
): Promise<void> {
  const current = await lstat(expected.canonicalPath);
  if (
    current.isSymbolicLink() || !current.isDirectory() ||
    current.dev !== expected.device || current.ino !== expected.inode ||
    await realpath(expected.canonicalPath) !== expected.canonicalPath
  ) {
    throw new Error("consumed_output_ledger_root_identity_drift");
  }
}

async function ensureLocalLedgerLockRoot(
  ledgerRootInput: string,
  custodyRootInput?: string,
): Promise<string> {
  const ledgerRoot = resolve(ledgerRootInput);
  if (custodyRootInput) {
    await ensureLedgerRootWithinCustody(resolve(custodyRootInput), ledgerRoot);
  }
  const rootMetadata = await lstat(ledgerRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("consumed_output_ledger_lock_root_unsafe");
  }
  const canonicalRoot = await realpath(ledgerRoot);
  const legacyLockRoot = join(ledgerRoot, ".mutation-locks");
  try {
    const legacyMetadata = await lstat(legacyLockRoot);
    if (legacyMetadata.isSymbolicLink() || !legacyMetadata.isDirectory()) {
      throw new Error("consumed_output_ledger_lock_root_unsafe");
    }
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  const lockBoundary = await realpath(dirname(canonicalRoot));
  const lockRoot = join(
    lockBoundary,
    ".consumed-output-ledger-mutation-locks",
    createHash("sha256").update(canonicalRoot).digest("hex"),
  );
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const canonicalLockRoot = await realpath(lockRoot);
  const rest = relative(lockBoundary, canonicalLockRoot);
  if (rest === ".." || rest.startsWith(`..${sep}`)) {
    throw new Error("consumed_output_ledger_lock_root_unsafe");
  }
  return canonicalLockRoot;
}

async function ensureLedgerRootWithinCustody(
  custodyRoot: string,
  ledgerRoot: string,
): Promise<void> {
  const custodyMetadata = await lstat(custodyRoot);
  if (custodyMetadata.isSymbolicLink() || !custodyMetadata.isDirectory()) {
    throw new Error("consumed_output_ledger_lock_root_unsafe");
  }
  const lexicalRest = relative(custodyRoot, ledgerRoot);
  if (
    lexicalRest === ".." ||
    lexicalRest.startsWith(`..${sep}`) ||
    resolve(custodyRoot, lexicalRest) !== ledgerRoot
  ) {
    throw new Error("consumed_output_ledger_lock_root_unsafe");
  }
  const canonicalCustody = await realpath(custodyRoot);
  let current = custodyRoot;
  for (const segment of lexicalRest.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("consumed_output_ledger_lock_root_unsafe");
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
      await mkdir(current, { recursive: false, mode: 0o700 });
    }
    const canonicalCurrent = await realpath(current);
    const canonicalRest = relative(canonicalCustody, canonicalCurrent);
    if (canonicalRest === ".." || canonicalRest.startsWith(`..${sep}`)) {
      throw new Error("consumed_output_ledger_lock_root_unsafe");
    }
  }
}

async function assertLedgerRootActive(ledgerRoot: string): Promise<void> {
  try {
    await readFile(join(ledgerRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("consumed_output_ledger_root_retired");
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
  readonly sourcePatchBytes?: Uint8Array;
  readonly gitBinaryPath?: string;
  readonly requireEvidenceCustody?: boolean;
}): Promise<LocalTerminalOutputBackupCapture> {
  if (input.sourcePatchBytes) {
    assertRetainedTerminalArchivePatchSize(input.sourcePatchBytes.byteLength);
  }
  const archivePath = join(
    input.archiveRoot,
    safeLedgerName(input.archiveName),
  );
  const statusPath = join(archivePath, "git-status.txt");
  const patchPath = join(archivePath, "tracked.diff");
  const numstatPath = join(archivePath, "tracked.numstat");
  const status = Buffer.from(await localGitOutput({
      cwd: input.workspacePath,
      args: ["status", "--short"],
      ...(input.gitBinaryPath ? { gitBinaryPath: input.gitBinaryPath } : {}),
    }));
  const patch = input.sourcePatchBytes
    ? Buffer.from(input.sourcePatchBytes)
    : input.sourcePatchPath
    ? (await inspectRetainedTerminalArchive(input.sourcePatchPath, { collect: true })).bytes!
    : input.changedFiles.length === 0
        ? Buffer.alloc(0)
        : await localGitOutputBytes({
            cwd: input.workspacePath,
            args: ["diff", "--binary", "--", ...input.changedFiles],
            ...(input.gitBinaryPath
              ? { gitBinaryPath: input.gitBinaryPath }
              : {}),
          });
  assertRetainedTerminalArchivePatchSize(patch.byteLength);
  const numstat = Buffer.from(input.changedFiles.length === 0
      ? ""
      : await localGitOutput({
          cwd: input.workspacePath,
          args: ["diff", "--numstat", "--", ...input.changedFiles],
          ...(input.gitBinaryPath
            ? { gitBinaryPath: input.gitBinaryPath }
            : {}),
        }));
  if (!localProjectControlEvidenceCustodySupported &&
    !input.requireEvidenceCustody) {
    await mkdir(archivePath, { recursive: true });
    await Promise.all([
      publishExactBytes(statusPath, status),
      publishExactBytes(patchPath, patch),
      publishExactBytes(numstatPath, numstat),
    ]);
    return {
      archivePath,
      statusPath,
      patchPath,
      numstatPath,
      hasAuthoredOutput: await anyFileHasBytes([patchPath, numstatPath]),
    };
  }
  const custody = new LocalProjectControlEvidenceCustody();
  const directory = safeLedgerName(input.archiveName);
  await Promise.all([
    custody.publishImmutableBytes({
      root: input.archiveRoot, directories: [directory],
      fileName: "git-status.txt", bytes: status,
      expectedSha256: sha256Bytes(status),
    }),
    custody.publishImmutableBytes({
      root: input.archiveRoot, directories: [directory],
      fileName: "tracked.diff", bytes: patch,
      expectedSha256: sha256Bytes(patch),
    }),
    custody.publishImmutableBytes({
      root: input.archiveRoot, directories: [directory],
      fileName: "tracked.numstat", bytes: numstat,
      expectedSha256: sha256Bytes(numstat),
    }),
  ]);
  return {
    archivePath,
    statusPath,
    patchPath,
    numstatPath,
    hasAuthoredOutput: await anyFileHasBytes([patchPath, numstatPath]),
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type LocalIntegratedOutputLedgerAdapterOptions = {
  readonly ledgerRoots: readonly string[];
  readonly evidenceRoots: readonly string[];
  readonly activeEvidenceRoot?: string;
  readonly custodyRoot?: string;
  readonly gitBinaryPath?: string;
};

export class LocalIntegratedOutputLedgerAdapter implements IntegratedOutputLedgerPort {
  private readonly writer: LocalConsumedOutputLedgerWriter;

  constructor(
    private readonly options: LocalIntegratedOutputLedgerAdapterOptions,
  ) {
    this.writer = new LocalConsumedOutputLedgerWriter(
      undefined,
      options.custodyRoot,
      options.evidenceRoots,
    );
  }

  async prepare(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation> {
    const ledgerRoot = this.requiredLedgerRoot();
    const archiveRoot = this.requiredActiveEvidenceRoot();
    const archiveName = [
      safeLedgerName(input.attempt.workerOutput.workerJobId),
      "integrated",
      input.commitSha.slice(0, 12),
      safeLedgerName(input.attempt.attemptId),
    ].join("-");
    const archivePath = join(archiveRoot, archiveName);
    const statusPath = join(archivePath, "git-status.txt");
    const patchPath = join(archivePath, "tracked.diff");
    const numstatPath = join(archivePath, "tracked.numstat");
    const status = Buffer.from(
      await this.gitOutput(input.attempt.workerOutput.workspacePath, [
        "status",
        "--short",
      ]),
    );
    const patch = await this.gitOutputBytes(input.attempt.targetWorkspacePath, [
      "show",
      "--format=",
      "--binary",
      input.commitSha,
      "--",
      ...input.attempt.workerOutput.changedFiles,
    ]);
    const numstat = Buffer.from(
      await this.gitOutput(input.attempt.targetWorkspacePath, [
        "show",
        "--format=",
        "--numstat",
        input.commitSha,
        "--",
        ...input.attempt.workerOutput.changedFiles,
      ]),
    );
    const custody = new LocalProjectControlEvidenceCustody();
    await Promise.all([
      custody.publishImmutableBytes({
        root: archiveRoot, directories: [archiveName],
        fileName: "git-status.txt", bytes: status,
        expectedSha256: sha256Bytes(status),
      }),
      custody.publishImmutableBytes({
        root: archiveRoot, directories: [archiveName],
        fileName: "tracked.diff", bytes: patch,
        expectedSha256: sha256Bytes(patch),
      }),
      custody.publishImmutableBytes({
        root: archiveRoot, directories: [archiveName],
        fileName: "tracked.numstat", bytes: numstat,
        expectedSha256: sha256Bytes(numstat),
      }),
    ]);
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
    const preparationBytes = Buffer.from(
      `${JSON.stringify(preparation, null, 2)}\n`,
    );
    await custody.publishImmutableBytes({
      root: ledgerRoot,
      directories: ["preparations"],
      fileName: `${safeLedgerName(input.attempt.attemptId)}.json`,
      bytes: preparationBytes,
      expectedSha256: sha256Bytes(preparationBytes),
    });
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
      archiveRoot: this.requiredActiveEvidenceRoot(),
      archiveName: `${input.attempt.workerOutput.workerJobId}-rejected-${input.attempt.attemptId}`,
      workspacePath: input.attempt.workerOutput.workspacePath,
      changedFiles: input.attempt.workerOutput.changedFiles,
      requireEvidenceCustody: this.options.custodyRoot !== undefined,
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

  private requiredActiveEvidenceRoot(): string {
    const latestRoot = this.options.evidenceRoots.at(-1);
    if (!latestRoot) {
      throw new Error("project_integration_consumed_output_evidence_root_required");
    }
    if (!this.options.activeEvidenceRoot) {
      throw new Error("project_integration_consumed_output_evidence_root_required");
    }
    const activeRoot = resolve(this.options.activeEvidenceRoot);
    if (activeRoot !== resolve(latestRoot)) {
      throw new Error("project_integration_consumed_output_active_evidence_root_mismatch");
    }
    return activeRoot;
  }

  private async gitOutput(
    cwd: string,
    args: readonly string[],
  ): Promise<string> {
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
    return await localGitOutputBytes({
      cwd,
      args,
      ...(this.options.gitBinaryPath ? { gitBinaryPath: this.options.gitBinaryPath } : {}),
    });
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
  try {
    const result = await execFileAsync(
      input.gitBinaryPath ?? "git",
      [...input.args],
      {
        cwd: input.cwd,
        encoding: "buffer",
        maxBuffer: MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES,
        timeout: 60_000,
      },
    );
    assertRetainedTerminalArchivePatchSize(result.stdout.byteLength);
    return result.stdout;
  } catch (error) {
    if (isNodeErrorCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") &&
        error instanceof Error && error.message.includes("stdout")) {
      assertRetainedTerminalArchivePatchSize(MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES + 1);
    }
    throw error;
  }
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

async function publishExactFile(
  path: string,
  sourcePath: string,
): Promise<void> {
  await publishExactBytes(path, await readFile(sourcePath));
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

async function publishExactBytes(
  path: string,
  contents: Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, contents, { flag: "wx" });
  try {
    await link(tmpPath, path);
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) throw error;
    if (!(await readFile(path)).equals(contents)) {
      throw new Error("integrated_output_ledger_preparation_conflict");
    }
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

function ledgerRecord(
  decision: TerminalOutputDecision,
): Record<string, unknown> {
  return {
    ...decision,
    consumedAt: decision.closedAt,
    ...(decision.commitSha
      ? {
          integratedCommitSha: decision.commitSha,
          commit: decision.commitSha,
        }
      : {}),
    notes: [
      {
        status: decision.status,
        text: decision.note,
        ...(decision.commitSha ? { commit: decision.commitSha } : {}),
      },
    ],
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
