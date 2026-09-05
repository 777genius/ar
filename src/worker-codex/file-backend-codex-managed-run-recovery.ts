import { createHash } from "node:crypto";
import type {
  AgentUsage,
  ClockPort,
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunRecoveryPacket,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProviderFailure,
  ProviderTask,
  ProviderTaskResult,
  RedactorPort,
  RunnerPort,
  RuntimeWarning,
  SessionEnvelope,
  SessionStorePort,
  WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import { CodexJsonAgentDriver } from "@vioxen/subscription-runtime/provider-codex";
import { SubscriptionWorkerError } from "@vioxen/subscription-runtime/worker-core";
import {
  hashArtifact,
  sameArtifactBytes,
} from "./file-backend-codex-auth-artifacts";

export type WaitingProviderTaskResult = Extract<
  ProviderTaskResult,
  { readonly status: "waiting_for_input" }
>;

export type ManagedRunRecoveryJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly recoveryPacket?: ManagedRunRecoveryPacket;
};

export type FileBackendCodexManagedRunResumeInput = {
  readonly runId: string;
  readonly requestId: string;
  readonly answer: string;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
};

export type ManagedRunWorkerResult = {
  readonly status?: "completed";
  readonly outputText: string;
  readonly structuredOutput?: unknown;
  readonly usage?: AgentUsage;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
} | {
  readonly status: "waiting_for_input";
  readonly runId: string;
  readonly outputText: string;
  readonly request: ManagedRunInputRequest;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly structuredOutput?: unknown;
  readonly usage?: AgentUsage;
  readonly warnings: readonly {
    readonly code: string;
    readonly safeMessage: string;
  }[];
};

export type FileBackendCodexManagedRunCoordinatorOptions = {
  readonly providerInstanceId: string;
  readonly workerId: string;
  readonly agentDriver: CodexJsonAgentDriver | null;
  readonly sessionStore: SessionStorePort;
  readonly managedRunStore: ManagedRunStorePort;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly clock: ClockPort;
  readonly recordFailure: (failure: ProviderFailure) => void;
  readonly recordSuccessfulRun: () => void;
  readonly exportAuthJsonFileQuietly: (
    context: "prewarm" | "run",
  ) => Promise<void>;
  readonly runRecoveryJob: (
    job: ManagedRunRecoveryJob,
  ) => Promise<ManagedRunWorkerResult>;
};

export type ManagedRunPersistContext =
  | {
      readonly kind: "run";
      readonly runId: string;
      readonly job: ManagedRunRecoveryJob;
      readonly attempt: number;
  }
  | {
      readonly kind: "resume";
      readonly input: FileBackendCodexManagedRunResumeInput;
      readonly previousRecord: ManagedRunRecord | null;
    };

export function canRecoverManagedRun(
  input: FileBackendCodexManagedRunResumeInput,
  record: ManagedRunRecord | null,
): record is ManagedRunRecord & {
  readonly recoveryPacket: ManagedRunRecoveryPacket;
} {
  if (!record?.recoveryPacket) return false;
  if (record.status === "completed" || record.status === "aborted") return false;
  if (record.runId !== input.runId) return false;
  if (record.request && record.request.id !== input.requestId) return false;
  if (record.resumeHandle?.runId && record.resumeHandle.runId !== input.runId) {
    return false;
  }
  return true;
}

export class FileBackendCodexManagedRunCoordinator {
  constructor(
    private readonly options: FileBackendCodexManagedRunCoordinatorOptions,
  ) {}

  async resume(
    input: FileBackendCodexManagedRunResumeInput,
  ): Promise<ManagedRunWorkerResult> {
    const agentDriver = this.options.agentDriver;
    if (!agentDriver) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Selected Codex worker engine does not support managed run resume.",
        { details: { reason: "task_mode_unsupported" } },
      );
    }
    this.assertResumeHandleMatchesWorker(input.resumeHandle);
    const abortSignal = input.abortSignal ?? new AbortController().signal;
    const durableRecord = await this.options.managedRunStore.get({
      runId: input.runId,
    });
    const session = await this.options.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "run",
    });
    if (!session) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Codex session is missing.",
        { details: { reason: "needs_reconnect" } },
      );
    }
    if (!agentDriver.hasManagedRunSession(input.runId)) {
      return await this.recoverManagedRun({ input, record: durableRecord });
    }
    const workspace: WorkspaceHandle = { path: input.resumeHandle.workspacePath };
    try {
      const result = await agentDriver.resumeManagedRun({
        session: session.artifact,
        runId: input.runId,
        requestId: input.requestId,
        answer: input.answer,
        resumeHandle: input.resumeHandle,
        task: {
          ...(input.outputSchemaName
            ? { outputSchemaName: input.outputSchemaName }
            : {}),
          ...(input.controls ? { controls: input.controls } : {}),
        },
        workspace,
        runner: this.options.runner,
        redactor: this.options.redactor,
        abortSignal,
      });
      const persisted = await this.persistResumeSessionUpdate({
        result,
        session,
        runId: input.runId,
      });
      if (persisted.status === "failed" && canRecoverManagedRun(input, durableRecord)) {
        return await this.recoverManagedRun({ input, record: durableRecord });
      }
      return await this.taskResultToOutput(persisted, {
        kind: "resume",
        input,
        previousRecord: durableRecord,
      });
    } finally {
      await workspace.dispose?.();
      await this.options.exportAuthJsonFileQuietly("run");
    }
  }

  async taskResultToOutput(
    result: ProviderTaskResult,
    context?: ManagedRunPersistContext,
  ): Promise<ManagedRunWorkerResult> {
    if (result.status === "failed") {
      this.options.recordFailure(result.failure);
      throw managedRunFailureToWorkerError(result);
    }
    if (result.status === "waiting_for_input") {
      const waiting = this.workerWaitingResult(result);
      if (context) {
        await this.persistWaitingManagedRun({ result: waiting, context });
      }
      return {
        status: "waiting_for_input",
        runId: waiting.runId,
        outputText: waiting.outputText,
        request: waiting.request,
        resumeHandle: waiting.resumeHandle,
        ...(waiting.structuredOutput === undefined
          ? {}
          : { structuredOutput: waiting.structuredOutput }),
        ...(waiting.telemetry?.usage === undefined
          ? {}
          : { usage: waiting.telemetry.usage }),
        warnings: waiting.warnings,
      };
    }
    this.options.recordSuccessfulRun();
    return {
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : { structuredOutput: result.structuredOutput }),
      ...(result.telemetry?.usage === undefined
        ? {}
        : { usage: result.telemetry.usage }),
      warnings: result.warnings,
    };
  }

  private async recoverManagedRun(input: {
    readonly input: FileBackendCodexManagedRunResumeInput;
    readonly record: ManagedRunRecord | null;
  }): Promise<ManagedRunWorkerResult> {
    const record = input.record;
    if (!canRecoverManagedRun(input.input, record)) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run cannot be recovered from durable state.",
        { details: { reason: "managed_run_recovery_unavailable" } },
      );
    }
    const packet = record.recoveryPacket;
    const outputSchemaName =
      input.input.outputSchemaName ?? packet.outputSchemaName;
    const controls = input.input.controls ?? packet.controls;
    return await this.options.runRecoveryJob({
      runId: input.input.runId,
      prompt: buildManagedRunRecoveryPrompt({
        packet,
        answer: input.input.answer,
        requestId: input.input.requestId,
      }),
      ...(packet.systemPrompt === undefined
        ? {}
        : { systemPrompt: packet.systemPrompt }),
      kind: packet.kind ?? "structured-prompt",
      ...(outputSchemaName ? { outputSchemaName } : {}),
      ...(controls ? { controls } : {}),
      metadata: {
        ...(packet.metadata ?? {}),
        codexManagedRecovery: "true",
        codexManagedRecoveryRequestId: input.input.requestId,
        ...(packet.goalObjective
          ? { codexGoalObjective: packet.goalObjective }
          : {}),
      },
      ...(input.input.abortSignal ? { abortSignal: input.input.abortSignal } : {}),
      recoveryPacket: packet,
    });
  }

  private async persistResumeSessionUpdate(input: {
    readonly result: ProviderTaskResult;
    readonly session: SessionEnvelope;
    readonly runId: string;
  }): Promise<ProviderTaskResult> {
    if (
      input.result.status !== "completed" ||
      !input.result.sessionUpdate ||
      sameArtifactBytes(input.result.sessionUpdate, input.session.artifact)
    ) {
      return input.result;
    }
    if (input.result.sessionUpdate.providerId !== input.session.providerId) {
      return appendWarnings(input.result, [
        {
          code: "managed_run_session_update_provider_mismatch",
          safeMessage:
            "Managed run session update was ignored because the provider did not match.",
        },
      ]);
    }

    const updateHash = hashArtifact(input.result.sessionUpdate);
    const writebackKey = hashText(
      `${this.options.providerInstanceId}:${input.runId}:${updateHash}`,
    );
    try {
      const writeback = await this.options.sessionStore.write({
        providerInstanceId: this.options.providerInstanceId,
        expectedGeneration: input.session.generation,
        nextArtifact: input.result.sessionUpdate,
        idempotencyKey: `managed-run-resume:${writebackKey.slice(0, 32)}`,
        leaseId: `managed-run-resume:${writebackKey.slice(0, 32)}`,
      });
      if (writeback.status === "stale_generation") {
        return appendWarnings(input.result, [
          {
            code: "managed_run_session_update_stale_generation",
            safeMessage:
              "Managed run session update was skipped because a newer session generation already exists.",
          },
        ]);
      }
      return input.result;
    } catch {
      return appendWarnings(input.result, [
        {
          code: "managed_run_session_update_writeback_failed",
          safeMessage:
            "Managed run session update could not be written back after resume.",
        },
      ]);
    }
  }

  private async persistWaitingManagedRun(input: {
    readonly result: WaitingProviderTaskResult;
    readonly context: ManagedRunPersistContext;
  }): Promise<void> {
    const recoveryPacket = buildManagedRunRecoveryPacket({
      result: input.result,
      context: input.context,
    });
    await this.options.managedRunStore.saveWaitingInput({
      runId: input.result.runId,
      request: input.result.request,
      resumeHandle: input.result.resumeHandle,
      recoveryPacket,
      taskId: input.result.runId,
      assignedWorkerId: this.options.workerId,
      providerInstanceId: this.options.providerInstanceId,
      workspacePath: input.result.resumeHandle.workspacePath,
      ...(input.result.outputText.trim()
        ? { outputText: input.result.outputText }
        : {}),
      now: this.options.clock.now(),
    });
  }

  private workerWaitingResult(
    result: WaitingProviderTaskResult,
  ): WaitingProviderTaskResult {
    return {
      ...result,
      resumeHandle: this.workerResumeHandle(result.resumeHandle),
    };
  }

  private workerResumeHandle(
    resumeHandle: ManagedRunResumeHandle,
  ): ManagedRunResumeHandle {
    return {
      ...resumeHandle,
      providerInstanceId: this.options.providerInstanceId,
      workerId: this.options.workerId,
    };
  }

  private assertResumeHandleMatchesWorker(
    resumeHandle: ManagedRunResumeHandle,
  ): void {
    if (
      resumeHandle.providerInstanceId !== undefined &&
      resumeHandle.providerInstanceId !== this.options.providerInstanceId
    ) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run belongs to a different provider instance.",
        { details: { reason: "managed_run_provider_instance_mismatch" } },
      );
    }
    if (
      resumeHandle.workerId !== undefined &&
      resumeHandle.workerId !== this.options.workerId
    ) {
      throw new SubscriptionWorkerError(
        "subscription_worker_run_failed",
        "Managed run belongs to a different worker.",
        { details: { reason: "managed_run_worker_mismatch" } },
      );
    }
  }
}

export function managedRunFailureToWorkerError(
  result: Extract<ProviderTaskResult, { readonly status: "failed" }>,
): SubscriptionWorkerError {
  return new SubscriptionWorkerError(
    "subscription_worker_run_failed",
    result.failure.safeMessage,
    {
      ...(result.telemetry?.usage === undefined
        ? {}
        : { usage: result.telemetry.usage }),
      details: {
        code: result.failure.code,
        ...(result.failure.details ?? {}),
      },
    },
  );
}

export function buildManagedRunRecoveryPacket(input: {
  readonly result: WaitingProviderTaskResult;
  readonly context: ManagedRunPersistContext;
}): ManagedRunRecoveryPacket {
  const previous =
    input.context.kind === "resume"
      ? input.context.previousRecord?.recoveryPacket
      : input.context.job.recoveryPacket;
  const job = input.context.kind === "run" ? input.context.job : null;
  const controls =
    input.context.kind === "resume"
      ? input.context.input.controls ?? previous?.controls
      : job?.controls ?? previous?.controls;
  const outputSchemaName =
    input.context.kind === "resume"
      ? input.context.input.outputSchemaName ?? previous?.outputSchemaName
      : job?.outputSchemaName ?? previous?.outputSchemaName;
  const metadata =
    input.context.kind === "run"
      ? job?.metadata ?? previous?.metadata
      : previous?.metadata;
  const goalObjective =
    metadata?.codexGoalObjective ?? previous?.goalObjective;
  const kind = job?.kind ?? previous?.kind;
  const systemPrompt = job?.systemPrompt ?? previous?.systemPrompt;
  return {
    originalPrompt: previous?.originalPrompt ?? job?.prompt ?? input.result.outputText,
    ...(goalObjective ? { goalObjective } : {}),
    lastOutput: input.result.outputText,
    blockerQuestion: input.result.request.question,
    ...(input.result.request.contextSummary
      ? { contextSummary: input.result.request.contextSummary }
      : previous?.contextSummary
        ? { contextSummary: previous.contextSummary }
        : {}),
    attemptSummary: managedRunAttemptSummary(input.context),
    ...(kind ? { kind } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(outputSchemaName ? { outputSchemaName } : {}),
    ...(controls ? { controls } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function managedRunAttemptSummary(context: ManagedRunPersistContext): string {
  if (context.kind === "run") {
    return `Blocked during worker attempt ${context.attempt}.`;
  }
  const answerPreview = context.input.answer.trim().slice(0, 240);
  return [
    `Recovered after answering request ${context.input.requestId}.`,
    answerPreview ? `Answer preview: ${answerPreview}` : "Answer preview: (empty answer)",
  ].join("\n");
}

export function buildManagedRunRecoveryPrompt(input: {
  readonly packet: ManagedRunRecoveryPacket;
  readonly answer: string;
  readonly requestId: string;
}): string {
  return [
    "Continue a previously blocked managed run.",
    "",
    "Original task:",
    input.packet.originalPrompt,
    "",
    ...(input.packet.goalObjective
      ? ["Goal objective:", input.packet.goalObjective, ""]
      : []),
    "Last worker output before the blocker:",
    input.packet.lastOutput || "(no output)",
    "",
    "Blocking request:",
    `Request id: ${input.requestId}`,
    input.packet.blockerQuestion,
    "",
    ...(input.packet.contextSummary
      ? ["Context summary:", input.packet.contextSummary, ""]
      : []),
    ...(input.packet.attemptSummary
      ? ["Attempt summary:", input.packet.attemptSummary, ""]
      : []),
    "Answer from orchestrator:",
    input.answer.trim() || "(empty answer)",
    "",
    "Use the answer above and continue the original task from the recovered state. Do not restart from scratch unless the recovered context is insufficient.",
  ].join("\n");
}

function appendWarnings<T extends ProviderTaskResult>(
  result: T,
  warnings: readonly RuntimeWarning[],
): T {
  if (warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...result.warnings, ...warnings],
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
