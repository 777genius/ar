import { assertHostedDependencyExecutionWorkspace } from "./hosted-dependency-admission";
import { createHash, randomUUID } from "node:crypto";
import {
  DefaultRedactor,
  type AgentUsage,
  type ClockPort,
  type ManagedRunInputRequest,
  type ManagedRunRecoveryPacket,
  type ManagedRunResumeHandle,
  type ObservabilityPort,
  type ProviderFailure,
  type ProviderLogicalThreadExecution,
  type ProviderTask,
  type RefreshThenRunResult,
  type RedactorPort,
  type SessionArtifact,
  assertProviderTaskSystemPrompt,
} from "@vioxen/subscription-runtime/core";
import {
  CodexJsonAgentDriver,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  SubscriptionWorkerError,
  combineAbortSignals,
  type CapacityAwareSubscriptionWorker,
  type SubscriptionWorkerHealth,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerRunOptions,
  type SubscriptionWorkerState,
  type WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import { NullWorkerObservability } from "../worker-local/observability";
import {
  FileBackendCodexManagedRunCoordinator,
  type FileBackendCodexManagedRunResumeInput,
} from "./file-backend-codex-managed-run-recovery";
import {
  FileBackendCodexCapacityState,
  isSevereCapacity,
} from "./file-backend-codex-capacity";
import {
  createFileBackendCodexWorkerRuntime,
  type FileBackendCodexWorkerRuntimeParts,
} from "./file-backend-codex-runtime-factory";
import { FileBackendCodexPrewarmer } from "./file-backend-codex-prewarm";
import { FileBackendCodexSessionSeeder } from "./file-backend-codex-session-seeding";
import { FileBackendCodexSessionBinding } from "./file-backend-codex-session-binding";

import type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker-options";
export type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker-options";
export type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
export type { CodexWorkerCapacityPolicy } from "./file-backend-codex-capacity";
export type { FileBackendCodexManagedRunResumeInput } from "./file-backend-codex-managed-run-recovery";
import { assertWorkerOptions } from "./file-backend-codex-worker-options";
export type FileBackendCodexWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly execution?: ProviderTask["execution"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly logicalThread?: ProviderLogicalThreadExecution;
  readonly recoveryPacket?: ManagedRunRecoveryPacket;
};

export type FileBackendCodexWorkerResult = {
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

export class FileBackendCodexWorker implements CapacityAwareSubscriptionWorker<
  FileBackendCodexWorkerJob,
  FileBackendCodexWorkerResult
> {
  readonly workerId: string;
  private workerState: SubscriptionWorkerState = "created";
  private disposing:Promise<void>|undefined;
  private readonly redactor: RedactorPort = new DefaultRedactor();
  private readonly runner: FileBackendCodexWorkerRuntimeParts["runner"];
  private readonly observability: ObservabilityPort;
  private readonly clock: ClockPort;
  private readonly agentDriver: FileBackendCodexWorkerRuntimeParts["agentDriver"];
  private readonly sessionStore: FileBackendCodexWorkerRuntimeParts["sessionStore"];
  private readonly runtime: FileBackendCodexWorkerRuntimeParts["runtime"];
  private readonly ownedWorkspace: FileBackendCodexWorkerRuntimeParts["ownedWorkspace"];
  private readonly capacityTracker: FileBackendCodexCapacityState;
  private readonly sessionSeeder: FileBackendCodexSessionSeeder;
  private readonly managedRuns: FileBackendCodexManagedRunCoordinator;
  private readonly prewarmer: FileBackendCodexPrewarmer;
  private readonly sessionBinding: FileBackendCodexSessionBinding;

  constructor(private readonly options: FileBackendCodexWorkerOptions) {
    assertHostedDependencyExecutionWorkspace(options.workspacePath);
    this.workerId =
      options.workerId ??
      `file-backend-codex:${hashText(options.providerInstanceId).slice(0, 12)}`;
    assertWorkerOptions(options);
    this.observability = options.observability ?? new NullWorkerObservability();
    const runtimeParts = createFileBackendCodexWorkerRuntime({
      options,
      workerId: this.workerId,
      observability: this.observability,
      redactor: this.redactor,
      clock: options.clock ?? systemClock,
    });
    this.runner = runtimeParts.runner;
    this.clock = runtimeParts.clock;
    this.agentDriver = runtimeParts.agentDriver;
    const managedDriver = this.agentDriver instanceof CodexJsonAgentDriver ? this.agentDriver : undefined;
    this.sessionBinding = new FileBackendCodexSessionBinding(
      managedDriver ? (runId) => managedDriver.hasManagedRunSession(runId) : undefined);
    this.sessionStore = runtimeParts.sessionStore;
    this.runtime = runtimeParts.runtime;
    this.ownedWorkspace = runtimeParts.ownedWorkspace;
    this.capacityTracker = new FileBackendCodexCapacityState({
      clock: this.clock,
      providerInstanceId: options.providerInstanceId,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.capacityAccountId === undefined
        ? {}
        : { configuredAccountId: options.capacityAccountId }),
      ...(options.serviceTier === undefined
        ? {}
        : { serviceTier: options.serviceTier }),
      ...(options.capacityPolicy === undefined
        ? {}
        : { policy: options.capacityPolicy }),
    });

    this.sessionSeeder = new FileBackendCodexSessionSeeder({
      ...(options.assertProviderAdmission ? { assertProviderAdmission: options.assertProviderAdmission } : {}),
      providerInstanceId: options.providerInstanceId,
      sessionStore: this.sessionStore,
      observability: this.observability,
      clock: this.clock,
      agentId: this.agentDriver.agentId,
      onFailure: (failure) => this.recordFailure(failure),
      rememberQuotaGroup: (session) => this.rememberQuotaGroup(session),
      onAuthImported: () => this.capacityTracker.recordAuthImported(),
      // Local invalidation suppresses writeback; the seeder independently binds
      // publication to its source and fences concurrent runtime writers.
      shouldExportAuth: () => !this.capacityTracker.sessionInvalid,
    });
    this.managedRuns = new FileBackendCodexManagedRunCoordinator({
      providerInstanceId: options.providerInstanceId,
      workerId: this.workerId,
      agentDriver:
        this.agentDriver instanceof CodexJsonAgentDriver ? this.agentDriver : null,
      sessionStore: this.sessionStore,
      managedRunStore: runtimeParts.managedRunStore,
      runner: this.runner,
      redactor: this.redactor,
      clock: this.clock,
      recordFailure: (failure) => this.recordFailure(failure),
      recordSuccessfulRun: () => this.recordSuccessfulRun(),
      exportAuthJsonFileQuietly: (context,requireAcknowledgement) =>
        this.sessionSeeder.exportAuthJsonFileQuietly(context,requireAcknowledgement),
      // Recovery is part of the already admitted resume operation and keeps
      // its binding reservation through failure handling and writeback.
      runRecoveryJob: async (job) => await this.runWithSessionBinding(job, {}, false),
    });
    this.prewarmer = new FileBackendCodexPrewarmer({
      providerInstanceId: options.providerInstanceId,
      sessionStore: this.sessionStore,
      agentDriver: this.agentDriver,
      prewarmWorkspace: runtimeParts.prewarmWorkspace,
      runner: this.runner,
      redactor: this.redactor,
      now: () => this.clock.now(),
      importAuthJsonFileIfChanged: (context) =>
        this.sessionSeeder.importAuthJsonFileIfChanged(context),
      exportAuthJsonFileQuietly: (context) =>
        this.sessionSeeder.exportAuthJsonFileQuietly(context),
      rememberQuotaGroup: (session) => this.rememberQuotaGroup(session),
      onFailure: (error) => {
        const failure = this.agentDriver.classifyRunFailure(error);
        if (failure.code === "provider_session_invalid") this.recordFailure(failure);
      },
    });
  }

  get state(): SubscriptionWorkerState {
    return this.workerState;
  }

  async start(): Promise<void> {
    assertHostedDependencyExecutionWorkspace(this.options.workspacePath);
    if (this.workerState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Codex worker has been disposed.",
      );
    }
    if (this.workerState !== "created" && this.workerState !== "failed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_already_started",
        "Codex worker is already started.",
      );
    }
    this.workerState = "started";
  }

  async seedCodexAuthJsonFile(authJsonPath: string): Promise<void> {
    await this.sessionBinding.reserve(() => this.sessionSeeder.seedAuthJsonFile(authJsonPath));
  }

  async seedCodexAuthJson(authJson: string): Promise<boolean> {
    return await this.sessionBinding.reserve(() => this.sessionSeeder.seedAuthJson(authJson));
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    assertHostedDependencyExecutionWorkspace(this.options.workspacePath);
    this.assertStarted();
    return await this.sessionBinding.reserve(() => this.prewarmWithSessionBinding());
  }

  private async prewarmWithSessionBinding(): Promise<SubscriptionWorkerPrewarmResult> {
    this.workerState = "prewarming";
    try {
      const result = await this.prewarmer.prewarm();
      this.workerState = "ready";
      return result;
    } catch (error) {
      this.workerState = "failed";
      throw error;
    }
  }

  async run(
    job: FileBackendCodexWorkerJob,
    options: SubscriptionWorkerRunOptions = {},
  ): Promise<FileBackendCodexWorkerResult> {
    assertHostedDependencyExecutionWorkspace(this.options.workspacePath);
    this.assertStarted();
    return await this.sessionBinding.reserve(() => this.runWithSessionBinding(job, options));
  }

  private async runWithSessionBinding(
    job: FileBackendCodexWorkerJob,
    options: SubscriptionWorkerRunOptions = {},
    importSource = true,
  ): Promise<FileBackendCodexWorkerResult> {
    assertHostedDependencyExecutionWorkspace(this.options.workspacePath);
    this.assertStarted();
    assertProviderTaskSystemPrompt(job.systemPrompt, "job.systemPrompt");
    if (importSource) await this.sessionSeeder.importAuthJsonFileIfChanged("run");
    await this.rememberStoredQuotaGroup();
    const runId = job.runId ?? `local-${randomUUID()}`;
    this.sessionBinding.trackManagedRun(runId);
    const abort = combineAbortSignals(job.abortSignal, options.abortSignal);
    const abortSignal = abort.signal;
    const startedAt = this.clock.monotonicMs();
    const retryMaxMs = this.options.refreshConflictRetryMaxMs ?? 30_000;
    let attempt = 1;

    try {
      while (true) {
        let result: RefreshThenRunResult;
        try {
          result = await this.runtime.refreshThenRunTask({
            providerInstanceId: this.options.providerInstanceId,
            task: {
              kind: job.kind ?? "structured-prompt",
              prompt: job.prompt,
              ...(job.systemPrompt !== undefined
                ? { systemPrompt: job.systemPrompt }
                : {}),
              ...(job.outputSchemaName
                ? { outputSchemaName: job.outputSchemaName }
                : {}),
              ...(job.controls ? { controls: job.controls } : {}),
              ...(job.execution ? { execution: job.execution } : {}),
              metadata: {
                ...(job.metadata ?? {}),
                codexManagedRunId: runId,
              },
            },
            runContext: {
              runId,
              attempt,
              abortSignal,
              ...(options.onProviderTaskStarted
                  ? { onProviderTaskStarted: options.onProviderTaskStarted }
                  : {}),
              ...(options.onProviderTextDelta
                  ? { onProviderTextDelta: options.onProviderTextDelta }
                  : {}),
              ...(job.logicalThread === undefined
                ? {}
                : { logicalThread: job.logicalThread }),
            },
          });
        } catch (error) {
          const failure = this.agentDriver.classifyRunFailure(error);
          this.recordFailure(failure);
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            failure.safeMessage,
            {
              cause: error,
              details: {
                reason: failure.code,
                ...(failure.details ?? {}),
                ...(this.capacityTracker.accountId
                  ? { accountId: this.capacityTracker.accountId }
                  : {}),
              },
            },
          );
        }

        if (result.status === "completed") {
          if (result.task.status === "waiting_for_input") {
            this.sessionBinding.trackManagedRun(result.task.runId);
          }
          return await this.managedRuns.taskResultToOutput(result.task, {
            kind: "run",
            runId,
            job,
            attempt,
          });
        }

        if (
          !this.options.childBudget && shouldRetryRefreshConflict(result) &&
          !abortSignal.aborted &&
          this.clock.monotonicMs() - startedAt < retryMaxMs
        ) {
          await delay(refreshConflictDelayMs(attempt), abortSignal);
          attempt += 1;
          continue;
        }

        this.recordBlocked(result.reason);
        throw new SubscriptionWorkerError(
          "subscription_worker_run_failed",
          result.safeMessage,
          { details: { reason: result.reason } },
        );
      }
    } finally {
      abort.dispose();
      await this.sessionSeeder.exportAuthJsonFileQuietly("run");
    }
  }

  async resumeManagedRun(
    input: FileBackendCodexManagedRunResumeInput,
  ): Promise<FileBackendCodexWorkerResult> {
    assertHostedDependencyExecutionWorkspace(this.options.workspacePath);
    this.assertStarted();
    return await this.sessionBinding.reserveResume(input.runId,
      () => this.sessionSeeder.importAuthJsonFileIfChanged("run"),
      () => this.managedRuns.resume(input));
  }

  async health(): Promise<SubscriptionWorkerHealth> {
    try {
      await this.rememberStoredQuotaGroup();
      const health = await this.runtime.healthCheck({
        providerInstanceId: this.options.providerInstanceId,
      });
      const capacity = this.capacity();
      const details = {
        ...(capacity.details ?? {}),
        availability: capacity.availability,
        recentRuns: String(capacity.recentRuns ?? 0),
      };
      if (health.status === "healthy" && isSevereCapacity(capacity)) {
        return {
          status: "degraded",
          state: this.workerState,
          checkedAt: this.clock.now(),
          failures: [
            {
              code: capacity.reason ?? capacity.availability,
              safeMessage: `Codex worker capacity is ${capacity.availability}.`,
            },
          ],
          warnings: health.warnings,
          details,
        };
      }
      if (health.status === "healthy") {
        return {
          status: "healthy",
          state: this.workerState,
          checkedAt: this.clock.now(),
          warnings: health.warnings,
          details,
        };
      }
      return {
        status: "unhealthy",
        state: this.workerState,
        checkedAt: this.clock.now(),
        failures: health.failures.map((failure) => ({
          code: failure.code,
          safeMessage: failure.safeMessage,
        })),
        warnings: health.warnings,
        details,
      };
    } catch (error) {
      return {
        status: "unhealthy",
        state: "failed",
        checkedAt: this.clock.now(),
        failures: [
          {
            code: "subscription_worker_health_failed",
            safeMessage:
              error instanceof Error ? error.message : "Codex health failed.",
          },
        ],
        warnings: [],
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.workerState === "disposed") return;
    if (this.disposing) return await this.disposing;
    this.workerState = "draining";
    const pending = (async () => {
      await this.runtime.retryPendingTaskFinalizations();
      await this.managedRuns.cancelRetainedSessions();
      if ("dispose" in this.agentDriver) await this.agentDriver.dispose();
      await this.ownedWorkspace?.dispose();
      this.workerState = "disposed";
    })();
    this.disposing = pending;
    try { await pending; } finally { if (this.disposing === pending) this.disposing = undefined; }
  }

  capacity(): WorkerCapacitySnapshot {
    return this.capacityTracker.snapshot({
      workerState: this.workerState,
      authSourceChanged: !this.sessionBinding.isInUse() &&
        this.sessionSeeder.authJsonFileChanged(),
    });
  }

  private recordSuccessfulRun(): void {
    this.capacityTracker.recordSuccessfulRun();
  }

  private recordFailure(failure: ProviderFailure): void {
    if (failure.code === "provider_session_invalid") {
      this.sessionSeeder.rememberBoundSeedQuotaGroup();
    }
    this.capacityTracker.recordFailure(failure);
    if (failure.code === "provider_session_invalid") {
      const invalidSeed = this.capacityTracker.snapshot({
        workerState: this.workerState, authSourceChanged: false,
      });
      this.options.onSessionInvalid?.(invalidSeed);
      // A cached refresh can rotate the token while the login source stays
      // unchanged. Fence both that actual session and its source lineage.
      this.sessionSeeder.rememberBoundSourceQuotaGroup();
      const invalidSource = this.capacityTracker.snapshot({
        workerState: this.workerState, authSourceChanged: false,
      });
      if (invalidSource.details?.capacitySessionId !== invalidSeed.details?.capacitySessionId) {
        this.options.onSessionInvalid?.(invalidSource);
      }
    }
  }

  private recordBlocked(reason: string): void {
    this.capacityTracker.recordBlocked(reason);
  }

  private async rememberStoredQuotaGroup(): Promise<void> {
    if (this.capacityTracker.hasKnownAccountIdentity()) return;
    const session = await this.sessionStore.read({
      providerInstanceId: this.options.providerInstanceId,
      expectedProviderId: "codex",
      purpose: "health-check",
    });
    if (session) this.capacityTracker.rememberQuotaGroup(session.artifact);
  }

  private rememberQuotaGroup(session: SessionArtifact): void {
    this.capacityTracker.rememberQuotaGroup(session);
  }

  private assertStarted(): void {
    if (this.workerState === "draining") throw new SubscriptionWorkerError("subscription_worker_disposed","Codex worker is draining.");
    if (this.workerState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Codex worker has been disposed.",
      );
    }
    if (this.workerState === "created") {
      throw new SubscriptionWorkerError(
        "subscription_worker_not_started",
        "Codex worker has not been started.",
      );
    }
  }
}

function shouldRetryRefreshConflict(result: RefreshThenRunResult): boolean {
  if (result.status !== "blocked") return false;
  if (result.reason === "stale_generation") return true;
  return (
    result.reason === "permission_required" &&
    /session refresh is already leased/i.test(result.safeMessage)
  );
}

function refreshConflictDelayMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
}

function delay(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.reject(new Error("subscription_worker_run_aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("subscription_worker_run_aborted"));
      },
      { once: true },
    );
  });
}


function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
};
