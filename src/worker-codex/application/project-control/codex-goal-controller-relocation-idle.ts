import { controllerStateLocationForRelocation } from "./codex-goal-controller-state-location";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { LocalControlledAgentStateStore } from "@vioxen/subscription-runtime/store-local-file";
import { AccessBoundary, ControlledAgentRunStatus } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { collectCodexGoalStatus, type CodexGoalStatus } from "../../codex-goal-ops";
import { assertNoLedgerEpochWriterProcesses } from "./codex-goal-ledger-epoch-process-guard";

/** A stopped display status alone is insufficient: inspect process facts too. */
export function assertControllerRelocationWorkerStopped(status: CodexGoalStatus, probe: (pid: number) => void = (pid) => { process.kill(pid, 0); }): void {
  if (status.tmuxAlive === true || status.progressProcessAlive === true ||
    status.appServerProcessAlive === true || status.workloadProcessAlive === true) {
    throw new Error("controller_relocation_worker_live");
  }
  for (const pid of [status.progressPid, status.appServerProcessPid, status.workloadProcessPid]) {
    if (pid === undefined) continue;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("controller_relocation_worker_unknown");
    try { probe(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw new Error("controller_relocation_worker_unknown");
    }
    throw new Error("controller_relocation_worker_live");
  }
  if (status.progressExists !== false &&
    !["completed", "stopped", "maintenance_paused", "failed", "partial"].includes(status.progressStatus ?? "")) {
    throw new Error("controller_relocation_worker_stale_or_unknown");
  }
  if (status.warnings.some((warning) => warning !== "tmux session is not alive")) {
    throw new Error("controller_relocation_worker_observation_indeterminate");
  }
}

export async function assertControllerRelocationIdle(input: {
  readonly controller: CodexGoalJobManifest;
  readonly attestedNeverRunControllerJobId?: string;
  readonly registryRootDir: string;
  readonly workspacePaths: readonly string[];
  readonly manifests: readonly CodexGoalJobManifest[];
}, deps: {
  readonly assertNoProcesses?: typeof assertNoLedgerEpochWriterProcesses;
  readonly collectStatus?: typeof collectCodexGoalStatus;
} = {}): Promise<void> {
  // Reuse the maintenance process inventory: inaccessible/changing evidence
  // fails closed and old runtime writers cannot bypass the new fence.
  await (deps.assertNoProcesses ?? assertNoLedgerEpochWriterProcesses)({
    registryRootDir: input.registryRootDir, controllerJobId: input.controller.jobId,
    ledgerRoot: input.controller.jobRootDir, selfPid: process.pid,
    workspacePaths: input.workspacePaths,
  });
  for (const manifest of input.manifests) {
    const workspace = await realpath(manifest.workspacePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (manifest.jobId !== input.controller.jobId &&
      (workspace === undefined || !input.workspacePaths.includes(workspace))) continue;
    if (!isAbsolute(manifest.jobRootDir)) throw new Error("controller_relocation_runtime_root_unknown");
    const cwd = resolve(manifest.cwd ?? process.cwd());
    const status = await (deps.collectStatus ?? collectCodexGoalStatus)({
      jobRootDir: manifest.jobRootDir, taskId: manifest.taskId,
      ...(manifest.progressPath ? { progressPath: resolve(cwd, manifest.progressPath) } : {}),
      ...(manifest.outputPath ? { resultPath: resolve(cwd, manifest.outputPath) } : {}),
      ...(manifest.logPath ? { logPath: resolve(cwd, manifest.logPath) } : {}),
      ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    });
    assertControllerRelocationWorkerStopped(status);
    if (manifest.accessBoundary === AccessBoundary.ProjectScopedControl) {
      const attested = input.attestedNeverRunControllerJobId === manifest.jobId;
      const bound = await controllerStateLocationForRelocation(manifest, attested);
      if (attested) {
        // Any persisted execution record contradicts a never-run assertion,
        // even when terminal. Inspect the usual state below as well.
        if (status.progressExists !== false) throw new Error("controller_relocation_attestation_history_conflict");
        for (const kind of ["runs", "sessions"]) {
          const entries = await readdir(join(manifest.jobRootDir, "controlled-agent", "controlled-agent", kind)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          if (entries.length) throw new Error("controller_relocation_attestation_history_conflict");
        }
      }
      if (bound !== undefined) await assertControlledStateStopped(bound);
    }
    await assertControlledStateStopped(join(manifest.jobRootDir, "controlled-agent"));
  }
}

async function assertControlledStateStopped(stateDir: string): Promise<void> {
  const store = new LocalControlledAgentStateStore({ rootDir: stateDir });
  for (const kind of ["runs", "sessions"] as const) {
    const root = join(stateDir, "controlled-agent", kind);
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) throw new Error("controller_relocation_run_unknown");
      const raw: unknown = JSON.parse(await readFile(join(root, entry.name,
        kind === "runs" ? "run.json" : "session.json"), "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("controller_relocation_run_unknown");
      const id = kind === "runs" && "runId" in raw ? raw.runId : "sessionId" in raw ? raw.sessionId : undefined;
      if (typeof id !== "string") throw new Error("controller_relocation_run_unknown");
      const state = kind === "runs" ? await store.readRun(id) : await store.readSession(id);
      if (!state || JSON.stringify(state) !== JSON.stringify(raw) || ![ControlledAgentRunStatus.Completed, ControlledAgentRunStatus.Stopped,
        ControlledAgentRunStatus.Blocked, ControlledAgentRunStatus.Failed].includes(state.status)) {
        throw new Error("controller_relocation_run_not_stopped");
      }
      if (!state.owner) throw new Error("controller_relocation_owner_unknown");
      {
        const owner = state.owner;
        if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0) {
          throw new Error("controller_relocation_owner_unknown");
        }
        try { process.kill(owner.pid!, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
          throw new Error("controller_relocation_owner_unknown");
        }
        throw new Error("controller_relocation_owner_live");
      }
    }
  }
}
