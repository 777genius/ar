import { join } from "node:path";
import { parseCodexGoalJobManifest } from "../../codex-goal-jobs";

export type LegacyAttemptWorkerPathBinding = {
  readonly declaredPath: string;
  readonly state: "present" | "missing";
  readonly canonicalPath?: string;
  readonly device?: number;
  readonly inode?: number;
  readonly mode?: number;
  readonly size?: number;
  readonly sha256?: string;
};

export type LegacyAttemptWorkerLifecycleBinding = {
  readonly state: "terminal_result";
  readonly terminalResultClaimed: true;
  readonly workerJobId: string;
  readonly workerJobRootDir: string;
  readonly resultStatus?: "done" | "partial" | "blocked" | "failed" | "completed";
  readonly result?: LegacyAttemptWorkerPathBinding;
};

export async function bindLegacyAttemptWorkerLifecycle(input: {
  readonly workerJobId: string;
  readonly workerManifest: LegacyAttemptWorkerPathBinding;
  readonly readBoundFile: (path: string, maxBytes?: number) => Promise<Buffer>;
  readonly bindPath: (
    path: string,
    includeBytes: boolean,
    maxBytes?: number,
  ) => Promise<LegacyAttemptWorkerPathBinding>;
  readonly maxManifestBytes: number;
}): Promise<LegacyAttemptWorkerLifecycleBinding> {
  if (input.workerManifest.state === "missing") {
    throw new Error("legacy_attempt_quarantine_worker_manifest_required");
  }
  const manifest = parseCodexGoalJobManifest(JSON.parse(
    (await input.readBoundFile(
      input.workerManifest.declaredPath,
      input.maxManifestBytes,
    )).toString("utf8"),
  ));
  if (manifest.jobId !== input.workerJobId) {
    throw new Error("legacy_attempt_quarantine_worker_manifest_mismatch");
  }
  const resultPath = manifest.outputPath ??
    join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`);
  const result = await input.bindPath(resultPath, true);
  if (result.state !== "present") {
    throw new Error("legacy_attempt_quarantine_worker_terminal_result_required");
  }
  const value: unknown = JSON.parse(
    (await input.readBoundFile(result.declaredPath)).toString("utf8"),
  );
  if (!isRecord(value) || !isTerminalWorkerResultStatus(value.status)) {
    throw new Error("legacy_attempt_quarantine_worker_terminal_result_required");
  }
  return {
    state: "terminal_result",
    terminalResultClaimed: true,
    workerJobId: input.workerJobId,
    workerJobRootDir: manifest.jobRootDir,
    resultStatus: value.status,
    result,
  };
}

export function validLegacyAttemptWorkerLifecycle(
  value: LegacyAttemptWorkerLifecycleBinding,
): boolean {
  if (!value.workerJobId || !value.workerJobRootDir.startsWith("/")) return false;
  return value.state === "terminal_result" &&
    value.terminalResultClaimed === true && value.result?.state === "present" &&
    isTerminalWorkerResultStatus(value.resultStatus);
}

function isTerminalWorkerResultStatus(
  value: unknown,
): value is "done" | "partial" | "blocked" | "failed" | "completed" {
  return value === "done" || value === "partial" || value === "blocked" ||
    value === "failed" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
