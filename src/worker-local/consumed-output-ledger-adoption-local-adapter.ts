import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES, assertRetainedTerminalArchivePatchSize } from "@vioxen/subscription-runtime/worker-core";
import type {
  IntegratedOutputLedgerPreparation,
  IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "./project-control-evidence-custody-local-adapter";

const execFileAsync = promisify(execFile);

type AdoptionPreparationContext = {
  readonly readPrepared: (input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }) => Promise<IntegratedOutputLedgerPreparation | undefined>;
  readonly requiredLedgerRoot: () => string;
  readonly requiredActiveEvidenceRoot: () => string;
  readonly gitOutput: (cwd: string, args: readonly string[]) => Promise<string>;
  readonly gitOutputBytes: (cwd: string, args: readonly string[]) => Promise<Buffer>;
};

export class LocalAdoptionLedgerPreparation {
  constructor(private readonly context: AdoptionPreparationContext) {}

  async prepareAdoption(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation> {
    const existing = await this.context.readPrepared(input);
    if (existing) return existing;
    const ledgerRoot = this.context.requiredLedgerRoot();
    const archiveRoot = this.context.requiredActiveEvidenceRoot();
    const archiveName = [
      safeLedgerName(input.attempt.workerOutput.workerJobId), "integrated",
      input.commitSha.slice(0, 12), safeLedgerName(input.attempt.attemptId),
    ].join("-");
    const custody = new LocalProjectControlEvidenceCustody();
    const capturePath = join(ledgerRoot, "adoption-captures", `${safeLedgerName(input.attempt.attemptId)}.json`);
    let capture: Record<string, unknown>;
    if (await custody.pathKind(capturePath) === "absent") {
      // One immutable publication precedes each archive file. A retry after any
      // later crash never has to read the mutable worker workspace again.
      const status = Buffer.from(await this.context.gitOutput(input.attempt.workerOutput.workspacePath, ["status", "--short"]));
      const patch = await this.context.gitOutputBytes(input.attempt.targetWorkspacePath, [
        "show", "--format=", "--binary", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles,
      ]);
      const numstat = Buffer.from(await this.context.gitOutput(input.attempt.targetWorkspacePath, [
        "show", "--format=", "--numstat", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles,
      ]));
      if ([status, patch, numstat].some((bytes) => bytes.length > MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES)) {
        throw new Error("published_commit_adoption_capture_too_large");
      }
      capture = {
        schemaVersion: 1,
        attemptId: input.attempt.attemptId,
        workerJobId: input.attempt.workerOutput.workerJobId,
        workerWorkspacePath: input.attempt.workerOutput.workspacePath,
        reviewedOutputId: input.attempt.workerOutput.reviewedOutputId,
        checkedReviewedTree: input.attempt.checkedReviewedTree,
        changedFiles: input.attempt.workerOutput.changedFiles,
        commitSha: input.commitSha,
        statusBase64: status.toString("base64"), patchBase64: patch.toString("base64"),
        numstatBase64: numstat.toString("base64"),
        statusSha256: sha256Bytes(status), patchSha256: sha256Bytes(patch),
        numstatSha256: sha256Bytes(numstat),
      };
      const bytes = Buffer.from(`${JSON.stringify(capture)}\n`);
      await custody.publishImmutableBytes({
        root: ledgerRoot, directories: ["adoption-captures"],
        fileName: `${safeLedgerName(input.attempt.attemptId)}.json`,
        bytes, expectedSha256: sha256Bytes(bytes),
      });
    }
    const frozen = await custody.readImmutableFile(capturePath, 144 * 1024 * 1024);
    try { capture = JSON.parse(Buffer.from(frozen.bytes).toString("utf8")) as Record<string, unknown>; }
    catch { throw new Error("published_commit_adoption_capture_invalid"); }
    if (!capture || typeof capture !== "object" || Array.isArray(capture) ||
        capture.schemaVersion !== 1 ||
        capture.attemptId !== input.attempt.attemptId ||
        capture.workerJobId !== input.attempt.workerOutput.workerJobId ||
        capture.workerWorkspacePath !== input.attempt.workerOutput.workspacePath ||
        capture.reviewedOutputId !== input.attempt.workerOutput.reviewedOutputId ||
        capture.checkedReviewedTree !== input.attempt.checkedReviewedTree ||
        JSON.stringify(capture.changedFiles) !== JSON.stringify(input.attempt.workerOutput.changedFiles) ||
        capture.commitSha !== input.commitSha || Object.keys(capture).length !== 14) {
      throw new Error("published_commit_adoption_capture_conflict");
    }
    const decode = (name: "status" | "patch" | "numstat"): Buffer => {
      return decodeAdoptionCapturedBytes(capture[`${name}Base64`], capture[`${name}Sha256`]);
    };
    const status = decode("status");
    const patch = decode("patch");
    const numstat = decode("numstat");
    const exactPatch = await this.context.gitOutputBytes(input.attempt.targetWorkspacePath, [
      "show", "--format=", "--binary", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles,
    ]);
    const exactNumstat = Buffer.from(await this.context.gitOutput(input.attempt.targetWorkspacePath, [
      "show", "--format=", "--numstat", input.commitSha, "--", ...input.attempt.workerOutput.changedFiles,
    ]));
    if (!patch.equals(exactPatch) || !numstat.equals(exactNumstat)) {
      throw new Error("published_commit_adoption_capture_commit_mismatch");
    }
    await Promise.all([
      custody.publishImmutableBytes({ root: archiveRoot, directories: [archiveName],
        fileName: "git-status.txt", bytes: status, expectedSha256: sha256Bytes(status) }),
      custody.publishImmutableBytes({ root: archiveRoot, directories: [archiveName],
        fileName: "tracked.diff", bytes: patch, expectedSha256: sha256Bytes(patch) }),
      custody.publishImmutableBytes({ root: archiveRoot, directories: [archiveName],
        fileName: "tracked.numstat", bytes: numstat, expectedSha256: sha256Bytes(numstat) }),
    ]);
    const archivePath = join(archiveRoot, archiveName);
    const preparation: IntegratedOutputLedgerPreparation = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      commitSha: input.commitSha,
      archivePath,
      statusPath: join(archivePath, "git-status.txt"),
      patchPath: join(archivePath, "tracked.diff"),
      numstatPath: join(archivePath, "tracked.numstat"),
    };
    const preparationBytes = Buffer.from(`${JSON.stringify(preparation, null, 2)}\n`);
    await custody.publishImmutableBytes({
      root: ledgerRoot, directories: ["preparations"],
      fileName: `${safeLedgerName(input.attempt.attemptId)}.json`,
      bytes: preparationBytes, expectedSha256: sha256Bytes(preparationBytes),
    });
    return preparation;
  }

  async readPrepared(input: {
    readonly attempt: IntegrationAttempt;
    readonly commitSha: string;
  }): Promise<IntegratedOutputLedgerPreparation | undefined> {
    const ledgerRoot = this.context.requiredLedgerRoot();
    const archiveRoot = this.context.requiredActiveEvidenceRoot();
    const archiveName = [
      safeLedgerName(input.attempt.workerOutput.workerJobId),
      "integrated", input.commitSha.slice(0, 12), safeLedgerName(input.attempt.attemptId),
    ].join("-");
    const archivePath = join(archiveRoot, archiveName);
    const preparationPath = join(ledgerRoot, "preparations", `${safeLedgerName(input.attempt.attemptId)}.json`);
    const custody = new LocalProjectControlEvidenceCustody();
    if (await custody.pathKind(preparationPath) === "absent") return undefined;
    const saved = await custody.readImmutableFile(preparationPath, 32 * 1024);
    let value: unknown;
    try { value = JSON.parse(Buffer.from(saved.bytes).toString("utf8")); }
    catch { throw new Error("integrated_output_ledger_preparation_invalid"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("integrated_output_ledger_preparation_invalid");
    }
    const preparation = value as Record<string, unknown>;
    const expected = {
      attemptId: input.attempt.attemptId,
      workerJobId: input.attempt.workerOutput.workerJobId,
      workerWorkspacePath: input.attempt.workerOutput.workspacePath,
      commitSha: input.commitSha,
      archivePath,
      statusPath: join(archivePath, "git-status.txt"),
      patchPath: join(archivePath, "tracked.diff"),
      numstatPath: join(archivePath, "tracked.numstat"),
    };
    if (Object.keys(preparation).length !== 8 ||
        Object.entries(expected).some(([key, expectedValue]) => preparation[key] !== expectedValue)) {
      throw new Error("integrated_output_ledger_preparation_conflict");
    }
    await custody.readImmutableFile(expected.statusPath, MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES);
    const archivedPatch = await custody.readImmutableFile(expected.patchPath, MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES);
    const archivedNumstat = await custody.readImmutableFile(expected.numstatPath, MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES);
    const patch = await this.context.gitOutputBytes(input.attempt.targetWorkspacePath, [
      "show", "--format=", "--binary", input.commitSha, "--",
      ...input.attempt.workerOutput.changedFiles,
    ]);
    const numstat = Buffer.from(await this.context.gitOutput(input.attempt.targetWorkspacePath, [
      "show", "--format=", "--numstat", input.commitSha, "--",
      ...input.attempt.workerOutput.changedFiles,
    ]));
    if (!Buffer.from(archivedPatch.bytes).equals(patch) ||
        !Buffer.from(archivedNumstat.bytes).equals(numstat)) {
      throw new Error("integrated_output_ledger_preparation_commit_mismatch");
    }
    return preparation as unknown as IntegratedOutputLedgerPreparation;
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function decodeAdoptionCapturedBytes(encoded: unknown, expectedSha: unknown): Buffer {
  // Bound allocation before decoding. A repeated-group base64 regex can exhaust
  // the JS stack on captures that are well within the supported 32 MiB limit.
  if (typeof encoded !== "string" || typeof expectedSha !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha) ||
      encoded.length > 4 * Math.ceil(MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES / 3) ||
      encoded.length % 4 !== 0) {
    throw new Error("published_commit_adoption_capture_invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES ||
      bytes.toString("base64") !== encoded || sha256Bytes(bytes) !== expectedSha) {
    throw new Error("published_commit_adoption_capture_invalid");
  }
  return bytes;
}

export async function localGitOutputBytes(input: {
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

export function safeLedgerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
