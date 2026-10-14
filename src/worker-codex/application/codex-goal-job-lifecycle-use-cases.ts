import { HostedGoalLifecycleOperation } from "./codex-goal-foreground-command";
import { CodexGoalLaunchState } from "../codex-goal-ops";
import { isHostedGoalLaunch, isHostedActivatedGoalLaunch, stopHostedGoalLaunch, routeHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalStopTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  prepareCodexGoalLaunchPaths,
  reconcileCodexGoalRuntimeResult,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  stopCodexGoalTmux,
  type CodexGoalLaunchInput,
} from "../codex-goal-ops";
import { codexGoalProgressPath } from "../codex-goal-runner";
import { buildCodexGoalBrief } from "./codex-goal-brief";
import { isSafeStartAction, nextActionForStatus } from "./codex-goal-decision";
import {
  type CodexGoalJobIdInput,
  type CodexGoalJobLifecycleInput,
  type CodexGoalJobResultReconcileInput,
} from "./codex-goal-use-case-inputs";
import {
  writeCodexGoalMaintenancePauseEvent,
  writeCodexGoalStopEvent,
  writeCodexGoalStoppedProgress,
} from "./codex-goal-lifecycle-markers";
import { codexGoalStateRootDir } from "./codex-goal-worker-control";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-status-input";
import {
  booleanValue,
  numberValue,
  stringValue,
} from "./codex-goal-input-values";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "../project-control-scope-guard";
import { stopDirectCodexGoalRun } from "./codex-goal-direct-run-stop-use-case";
import {
  tryMaterializeTerminalCodexGoalHandoff,
  type TerminalCodexGoalHandoffMaterialization,
} from "../codex-goal-terminal-handoff-materialization";
import {
  DurableHandoffPostStopError,
  DurableHandoffStopError,
  preserveTerminalHandoffBeforeStop,
} from "../codex-goal-preserve-before-stop";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedCodexGoalJobLaunch = {
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
};

export type CodexGoalMcpJobLifecycleDeps = {
  readonly loadJobLaunch: (
    args: CodexGoalJobIdInput,
  ) => Promise<LoadedCodexGoalJobLaunch>;
  readonly stopTmux?: typeof stopCodexGoalTmux;
  readonly materializeHandoff?: typeof tryMaterializeTerminalCodexGoalHandoff;
};

export async function continueStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial =
    projectControlGenericToolDenial({
      accessBoundary: loaded.manifest.accessBoundary,
      projectAccessScope: loaded.manifest.projectAccessScope,
      jobId: loaded.manifest.jobId,
    }) ??
    (await projectControlGenericScopeDenial({
      registryRootDir: loaded.registryRootDir,
      jobId: loaded.manifest.jobId,
      workspacePath: loaded.launch.config.workspacePath,
      requiredTool: "codex_goal_project_start",
    }));
  if (projectControlDenial) return projectControlDenial;
  const { tmuxSession: _tmuxSession, ...foregroundStatus } = statusInput(loaded.launch);
  const status = await collectCodexGoalStatus(isHostedGoalLaunch(loaded.launch) ? foregroundStatus : statusInput(loaded.launch));
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > (numberValue(args.staleAfterMs) ?? 10 * 60_000);
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  if (workerLiveness.alive) {
    return {
      ok: false,
      reason: "worker_already_running",
      jobId: loaded.manifest.jobId,
      status,
      workerSupervisorKind: workerLiveness.supervisorKind,
      workerAliveReason: workerLiveness.aliveReason,
    };
  }
  if (!isSafeStartAction(status.recommendedAction) && !args.forceStart) {
    return {
      ok: false,
      reason: "status_requires_review",
      jobId: loaded.manifest.jobId,
      status,
      next: nextActionForStatus(status.recommendedAction),
      requiredOverride: "forceStart",
    };
  }
  if (!args[options.confirmKey]) {
    return {
      ok: false,
      reason: `${options.confirmKey}_required`,
      jobId: loaded.manifest.jobId,
      status,
      tmuxCommand: loaded.launch.tmuxSession
        ? buildCodexGoalTmuxCommand(loaded.launch).preview
        : undefined,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
      next: nextActionForStatus(status.recommendedAction),
    };
  }
  if (!loaded.launch.tmuxSession && !isHostedGoalLaunch(loaded.launch)) {
    return {
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
    };
  }
  const outerStatus = await routeHostedGoalLaunch({ ...loaded.launch, registryRootDir: loaded.registryRootDir }, {
    operation: options.mode === "continue" ? HostedGoalLifecycleOperation.Continue : HostedGoalLifecycleOperation.Recover,
    jobId: loaded.manifest.jobId, confirmed: args[options.confirmKey] === true,
    skipDoctor: args.skipDoctor === true, forceStart: args.forceStart === true,
    ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
  });
  if (outerStatus !== undefined) return { ok: outerStatus === 0, jobId: loaded.manifest.jobId,
    launchState: outerStatus === 0 ? CodexGoalLaunchState.Completed : CodexGoalLaunchState.Failed, exitCode: outerStatus };
  if (!args.skipDoctor) {
    await prepareCodexGoalLaunchPaths(loaded.launch);
    const doctor = await doctorCodexGoal({
      config: loaded.launch.config,
      ...(isHostedGoalLaunch(loaded.launch) ? {} : { tmuxSession: loaded.launch.tmuxSession }),
    });
    if (!doctor.ok) {
      return {
        ok: false,
        reason: "doctor_failed",
        jobId: loaded.manifest.jobId,
        doctor,
      };
    }
  }
  const resultReconciliation = shouldReconcileResultBeforeStart(status)
    ? await reconcileCodexGoalRuntimeResult({
        config: loaded.launch.config,
        status,
        preservePatch: true,
      })
    : undefined;
  const command = await startCodexGoalTmux(loaded.launch);
  return {
    ok: command.launchState !== CodexGoalLaunchState.Failed,
    mode: options.mode,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    tmuxCommand: command.preview,
    launchState: command.launchState ?? CodexGoalLaunchState.Scheduled,
    statusBefore: status,
    ...(resultReconciliation === undefined ? {} : { resultReconciliation }),
  };
}

function shouldReconcileResultBeforeStart(
  status: Awaited<ReturnType<typeof collectCodexGoalStatus>>,
): boolean {
  if (
    status.progressStatus === "maintenance_paused" &&
    status.resultExists !== true &&
    !status.workspaceDirty &&
    (status.logExists !== true || (status.logByteLength ?? 0) === 0)
  ) {
    return false;
  }
  if (status.resultExists === true) return true;
  if (status.workspaceDirty) return true;
  if (status.progressExists) return true;
  if (status.logExists && (status.logByteLength ?? 0) > 0) return true;
  return false;
}

export async function reconcileStoredJobRuntimeResultLifecycle(
  args: CodexGoalJobResultReconcileInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial =
    projectControlGenericToolDenial({
      accessBoundary: loaded.manifest.accessBoundary,
      projectAccessScope: loaded.manifest.projectAccessScope,
      jobId: loaded.manifest.jobId,
      requiredTool: "codex_goal_project_mark_reviewed",
    }) ??
    (await projectControlGenericScopeDenial({
      registryRootDir: loaded.registryRootDir,
      jobId: loaded.manifest.jobId,
      workspacePath: loaded.launch.config.workspacePath,
      requiredTool: "codex_goal_project_mark_reviewed",
    }));
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (
    brief.workerAlive &&
    !brief.silentStale &&
    !brief.heartbeatOnlyNoOutput &&
    !args.forceWrite
  ) {
    return {
      ok: false,
      reason: "worker_alive",
      jobId: loaded.manifest.jobId,
      status,
      brief,
      requiredOverride: "forceWrite",
      safeMessage:
        "Worker still appears alive. Reconcile result only after stop/stale confirmation or with forceWrite.",
    };
  }
  const reconciliation = await reconcileCodexGoalRuntimeResult({
    config: loaded.launch.config,
    status,
    forceWrite: booleanValue(args.forceWrite) === true,
    preservePatch: args.preservePatch !== false,
    silentStale: brief.silentStale,
    heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
    ...(brief.silentStale
      ? { reason: "silent_stale_worker" }
      : brief.heartbeatOnlyNoOutput
        ? { reason: "heartbeat_only_no_output" }
        : {}),
  });
  return {
    ok: true,
    mode: "reconcile_result",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status,
    brief,
    reconciliation,
  };
}

export async function stopStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial =
    projectControlGenericToolDenial({
      accessBoundary: loaded.manifest.accessBoundary,
      projectAccessScope: loaded.manifest.projectAccessScope,
      jobId: loaded.manifest.jobId,
      requiredTool: "codex_goal_project_stop",
    }) ??
    (await projectControlGenericScopeDenial({
      registryRootDir: loaded.registryRootDir,
      jobId: loaded.manifest.jobId,
      workspacePath: loaded.launch.config.workspacePath,
      requiredTool: "codex_goal_project_stop",
    }));
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (isHostedActivatedGoalLaunch(loaded.launch)) {
    if (!brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceStop) {
      return { ok: false, reason: "worker_not_silent_stale_or_heartbeat_only_no_output", requiredOverride: "forceStop" };
    }
    if (!args.confirmStop) return { ok: false, reason: "confirm_stop_required" };
    stopHostedGoalLaunch(loaded.launch);
    return { ok: true, jobId: loaded.manifest.jobId, stopRequested: true, terminalCustodyProven: false };
  }
  if (!loaded.launch.tmuxSession || isHostedGoalLaunch(loaded.launch)) {
    return stopDirectCodexGoalRun({
      manifest: loaded.manifest,
      launch: loaded.launch,
      status,
      brief,
      confirmStop: Boolean(args.confirmStop),
    });
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return {
      ok: false,
      reason: "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (!brief.silentStale && !brief.heartbeatOnlyNoOutput && !args.forceStop) {
    return {
      ok: false,
      reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forceStop",
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (!args.confirmStop) {
    return {
      ok: false,
      reason: "confirm_stop_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  const preserved = await preserveBeforeStop(
    loaded.launch,
    deps,
    () => (deps.stopTmux ?? stopCodexGoalTmux)(loaded.launch.tmuxSession!),
    { forceAfterMaterializationFailure: Boolean(args.forceStop) },
  );
  if ("error" in preserved) {
    return preserved.phase === "stop"
      ? stopFailureAfterHandoffResult(
          loaded,
          status,
          brief,
          preserved.error,
          preserved.handoff,
        )
      : preserved.phase === "post_stop_materialize"
        ? terminalPreservationFailureAfterStopResult(
            loaded,
            status,
            brief,
            preserved.error,
            preserved.preStopHandoff,
          )
        : preserved.phase === "forced_stop"
          ? forcedStopFailureAfterPreservationFailureResult(
              loaded,
              status,
              brief,
              preserved.error,
              preserved.preservationError,
            )
          : preservationFailureResult(loaded, status, brief, preserved.error);
  }
  const { handoff, preservationError, stopResult: command } = preserved;
  await writeCodexGoalStoppedProgress({
    progressPath:
      loaded.launch.config.progressPath ??
      codexGoalProgressPath({
        jobRootDir: loaded.launch.config.jobRootDir,
        taskId: loaded.launch.config.taskId,
      }),
    taskId: loaded.launch.config.taskId,
    status: "stopped",
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const stopEventPath = await writeCodexGoalStopEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    forceStop: Boolean(args.forceStop),
    ...(handoff
      ? {
          handoffPacketPath: handoff.packetPath,
          handoffManifestSha256: handoff.manifestSha256,
        }
      : {}),
    ...(preservationError
      ? { handoffPreservationError: preservationError }
      : {}),
    statusBefore: status,
    statusAfter,
    brief,
  });
  const resultReconciliation = preservationError
    ? { status: "skipped", reason: "durable_handoff_preservation_failed" }
    : await reconcileCodexGoalRuntimeResult({
        config: loaded.launch.config,
        status: statusAfter,
        reason: brief.silentStale
          ? "silent_stale_worker"
          : brief.heartbeatOnlyNoOutput
            ? "heartbeat_only_no_output"
            : "manual_force_stop",
        preservePatch: true,
        silentStale: brief.silentStale,
        heartbeatOnlyNoOutput: brief.heartbeatOnlyNoOutput,
      });
  return {
    ok: true,
    mode: "stop",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    stopEventPath,
    statusBefore: status,
    statusAfter,
    brief,
    resultReconciliation,
    ...(handoff
      ? {
          handoffPacketPath: handoff.packetPath,
          handoffManifestSha256: handoff.manifestSha256,
        }
      : {}),
    ...(preservationError
      ? {
          handoffPreservationError: preservationError,
          preservationDegraded: true,
        }
      : {}),
    safeMessage: preservationError
      ? "Force-stopped the worker after durable handoff preservation failed. Recovery may require the original workspace; review the stop event before cleanup."
      : "Stopped the tmux worker session. Review workspace/log/result before continuing or recovery.",
  };
}

export async function maintenancePauseStoredJobLifecycle(
  args: CodexGoalJobLifecycleInput,
  deps: CodexGoalMcpJobLifecycleDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadJobLaunch(args);
  const projectControlDenial =
    projectControlGenericToolDenial({
      accessBoundary: loaded.manifest.accessBoundary,
      projectAccessScope: loaded.manifest.projectAccessScope,
      jobId: loaded.manifest.jobId,
      requiredTool: "codex_goal_project_stop",
    }) ??
    (await projectControlGenericScopeDenial({
      registryRootDir: loaded.registryRootDir,
      jobId: loaded.manifest.jobId,
      workspacePath: loaded.launch.config.workspacePath,
      requiredTool: "codex_goal_project_stop",
    }));
  if (projectControlDenial) return projectControlDenial;
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  const accounts = await listCodexGoalAccountStatuses({
    authRootDir: loaded.launch.config.authRootDir,
    accounts: loaded.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(loaded.launch),
  });
  const brief = await buildCodexGoalBrief({
    jobId: loaded.manifest.jobId,
    launch: loaded.launch,
    status,
    accounts,
    staleAfterMs: numberValue(args.staleAfterMs) ?? 10 * 60_000,
    tailLines: numberValue(args.tailLines) ?? 20,
  });
  if (isHostedActivatedGoalLaunch(loaded.launch)) {
    if (status.workspaceDirty && !args.forcePause) return { ok: false, reason: "workspace_dirty_requires_force_pause" };
    if (!args.confirmPause) return { ok: false, reason: "confirm_pause_required" };
    stopHostedGoalLaunch(loaded.launch);
    return { ok: true, jobId: loaded.manifest.jobId, stopRequested: true, terminalCustodyProven: false };
  }
  if (isHostedGoalLaunch(loaded.launch)) {
    if (status.workspaceDirty && !args.forcePause) return { ok: false, reason: "workspace_dirty_requires_force_pause" };
    return stopDirectCodexGoalRun({ manifest: loaded.manifest, launch: loaded.launch, status, brief,
      confirmStop: Boolean(args.confirmPause) });
  }
  if (!loaded.launch.tmuxSession) {
    return {
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      status,
      brief,
    };
  }
  const stopCommand = buildCodexGoalStopTmuxCommand(loaded.launch.tmuxSession);
  if (!status.tmuxAlive) {
    return {
      ok: false,
      reason:
        status.progressStatus === "maintenance_paused"
          ? "already_maintenance_paused"
          : "worker_not_running",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  if (status.workspaceDirty && !args.forcePause) {
    return {
      ok: false,
      reason: "workspace_dirty_requires_force_pause",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      requiredOverride: "forcePause",
      stopCommand: stopCommand.preview,
      status,
      brief,
      safeMessage:
        "Workspace has uncommitted changes. Wait for a clean checkpoint or pass forcePause after manual review.",
    };
  }
  if (!args.confirmPause) {
    return {
      ok: false,
      reason: "confirm_pause_required",
      jobId: loaded.manifest.jobId,
      tmuxSession: loaded.launch.tmuxSession,
      stopCommand: stopCommand.preview,
      status,
      brief,
    };
  }
  const preserved = await preserveBeforeStop(
    loaded.launch,
    deps,
    () => (deps.stopTmux ?? stopCodexGoalTmux)(loaded.launch.tmuxSession!),
    { forceAfterMaterializationFailure: Boolean(args.forcePause) },
  );
  if ("error" in preserved) {
    return preserved.phase === "stop"
      ? stopFailureAfterHandoffResult(
          loaded,
          status,
          brief,
          preserved.error,
          preserved.handoff,
        )
      : preserved.phase === "post_stop_materialize"
        ? terminalPreservationFailureAfterStopResult(
            loaded,
            status,
            brief,
            preserved.error,
            preserved.preStopHandoff,
          )
        : preserved.phase === "forced_stop"
          ? forcedStopFailureAfterPreservationFailureResult(
              loaded,
              status,
              brief,
              preserved.error,
              preserved.preservationError,
            )
          : preservationFailureResult(loaded, status, brief, preserved.error);
  }
  const { handoff, preservationError, stopResult: command } = preserved;
  const pauseReason = stringValue(args.reason) ?? "planned_maintenance";
  await writeCodexGoalStoppedProgress({
    progressPath:
      loaded.launch.config.progressPath ??
      codexGoalProgressPath({
        jobRootDir: loaded.launch.config.jobRootDir,
        taskId: loaded.launch.config.taskId,
      }),
    taskId: loaded.launch.config.taskId,
    status: "maintenance_paused",
    reason: pauseReason,
  });
  const statusAfter = await collectCodexGoalStatus(statusInput(loaded.launch));
  const maintenancePausePath = await writeCodexGoalMaintenancePauseEvent({
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    jobRootDir: loaded.launch.config.jobRootDir,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    reason: pauseReason,
    forcePause: Boolean(args.forcePause),
    ...(handoff
      ? {
          handoffPacketPath: handoff.packetPath,
          handoffManifestSha256: handoff.manifestSha256,
        }
      : {}),
    ...(preservationError
      ? { handoffPreservationError: preservationError }
      : {}),
    statusBefore: status,
    statusAfter,
    brief,
  });
  return {
    ok: true,
    mode: "maintenance_pause",
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    stopCommand: command.preview,
    maintenancePausePath,
    statusBefore: status,
    statusAfter,
    brief,
    ...(handoff
      ? {
          handoffPacketPath: handoff.packetPath,
          handoffManifestSha256: handoff.manifestSha256,
        }
      : {}),
    ...(preservationError
      ? {
          handoffPreservationError: preservationError,
          preservationDegraded: true,
        }
      : {}),
    safeMessage: preservationError
      ? "Force-paused the worker after durable handoff preservation failed. Keep the original workspace intact and review the pause event before continuing."
      : "Worker paused for planned maintenance. No failure result was reconciled; codex_goal_continue can resume after maintenance.",
  };
}

type VerifiedStopHandoff = TerminalCodexGoalHandoffMaterialization & {
  readonly packetPath: string;
  readonly manifestSha256: string;
};

async function preserveBeforeStop(
  launch: CodexGoalLaunchInput,
  deps: CodexGoalMcpJobLifecycleDeps,
  stop: () => Promise<Awaited<ReturnType<typeof stopCodexGoalTmux>>>,
  options: { readonly forceAfterMaterializationFailure: boolean },
): Promise<
  | {
      readonly handoff?: VerifiedStopHandoff;
      readonly preservationError?: string;
      readonly stopResult: Awaited<ReturnType<typeof stopCodexGoalTmux>>;
    }
  | {
      readonly phase: "materialize";
      readonly error: string;
    }
  | {
      readonly phase: "stop";
      readonly error: string;
      readonly handoff: VerifiedStopHandoff;
    }
  | {
      readonly phase: "post_stop_materialize";
      readonly error: string;
      readonly preStopHandoff: VerifiedStopHandoff;
    }
  | {
      readonly phase: "forced_stop";
      readonly error: string;
      readonly preservationError: string;
    }
> {
  try {
    const result = await preserveTerminalHandoffBeforeStop({
      materialize: () =>
        (deps.materializeHandoff ?? tryMaterializeTerminalCodexGoalHandoff)(
          launch.config,
        ),
      stop,
    });
    return { handoff: result.handoff, stopResult: result.stopResult };
  } catch (error) {
    if (error instanceof DurableHandoffStopError) {
      return {
        phase: "stop",
        error: error.message,
        handoff: error.handoff as VerifiedStopHandoff,
      };
    }
    if (error instanceof DurableHandoffPostStopError) {
      if (options.forceAfterMaterializationFailure) {
        return {
          handoff: error.preStopHandoff as VerifiedStopHandoff,
          stopResult: error.stopResult as Awaited<
            ReturnType<typeof stopCodexGoalTmux>
          >,
          preservationError: error.message,
        };
      }
      return {
        phase: "post_stop_materialize",
        error: error.message,
        preStopHandoff: error.preStopHandoff as VerifiedStopHandoff,
      };
    }
    const preservationError =
      error instanceof Error ? error.message : "unknown";
    if (options.forceAfterMaterializationFailure) {
      try {
        const stopResult = await stop();
        try {
          const terminalHandoff = await (
            deps.materializeHandoff ?? tryMaterializeTerminalCodexGoalHandoff
          )(launch.config);
          if (terminalHandoff.packetPath && terminalHandoff.manifestSha256) {
            return {
              handoff: terminalHandoff as VerifiedStopHandoff,
              stopResult,
              preservationError,
            };
          }
        } catch {
          // A force override may release custody only with explicit degraded
          // evidence when terminal recapture is still impossible after stop.
        }
        return { stopResult, preservationError };
      } catch (stopError) {
        return {
          phase: "forced_stop",
          error: stopError instanceof Error ? stopError.message : "unknown",
          preservationError,
        };
      }
    }
    return {
      phase: "materialize",
      error: preservationError,
    };
  }
}

function terminalPreservationFailureAfterStopResult(
  loaded: LoadedCodexGoalJobLaunch,
  status: unknown,
  brief: unknown,
  error: string,
  preStopHandoff: VerifiedStopHandoff,
): JsonObject {
  return {
    ok: false,
    reason: "terminal_handoff_materialization_failed_after_worker_stop",
    error,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    preStopHandoffPacketPath: preStopHandoff.packetPath,
    preStopHandoffManifestSha256: preStopHandoff.manifestSha256,
    status,
    brief,
    safeMessage:
      "The worker stopped, but terminal handoff recapture failed. The pre-stop packet is preserved; keep workspace custody and retry terminal materialization before release.",
  };
}

function forcedStopFailureAfterPreservationFailureResult(
  loaded: LoadedCodexGoalJobLaunch,
  status: unknown,
  brief: unknown,
  error: string,
  preservationError: string,
): JsonObject {
  return {
    ok: false,
    reason: "worker_stop_failed_after_handoff_materialization_failure",
    error,
    handoffPreservationError: preservationError,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status,
    brief,
    safeMessage:
      "Durable handoff preservation failed and the forced stop also failed. Re-check worker liveness before retrying.",
  };
}

function stopFailureAfterHandoffResult(
  loaded: LoadedCodexGoalJobLaunch,
  status: unknown,
  brief: unknown,
  error: string,
  handoff: VerifiedStopHandoff,
): JsonObject {
  return {
    ok: false,
    reason: "worker_stop_failed_after_durable_handoff",
    error,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    handoffPacketPath: handoff.packetPath,
    handoffManifestSha256: handoff.manifestSha256,
    status,
    brief,
    safeMessage:
      "Durable handoff was preserved, but stopping the worker failed. Re-check worker liveness before retrying.",
  };
}

function preservationFailureResult(
  loaded: LoadedCodexGoalJobLaunch,
  status: unknown,
  brief: unknown,
  error: string,
): JsonObject {
  return {
    ok: false,
    reason: "durable_handoff_materialization_failed",
    error,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    status,
    brief,
    safeMessage:
      "Worker remains alive because durable handoff preservation failed.",
  };
}
