import { AppServerAdmission, AppServerExecutionLease, appServerTurnCapacity } from "./app-server-admission";
import { AppServerUsageError } from "../domain/app-server-usage-error";
import { appServerTurnStartParams } from "./app-server-turn-start-params";
import { AppServerTokenUsageTracker } from "./app-server-turn-usage";
import { pruneCodexChildEnv } from "../../codex-cli-domain";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type {
  CodexMaterializedSession,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "./app-server-process-port";
import {
  appServerGoalObjectiveLimitError,
  formatGoalSetError,
} from "../domain/app-server-goal-policy";
import {
  codexAppServerSandboxPolicy,
  codexAppServerThreadRuntimePolicy,
  type AppServerWarning,
  type CodexAppServerCommandApprovalPolicy,
  type CodexAppServerNativeToolSurface,
  type CodexAppServerSandboxPolicy,
  type CodexThreadGoal,
  type CodexThreadGoalStatus,
} from "../domain/app-server-types";
import {
  codexAppServerProviderError,
  safeMessage,
  throwIfAborted,
} from "../domain/app-server-errors";
import { CodexAppServerThreadForkError } from "./app-server-thread-fork-error";
import {
  type AppServerTurnResult,
  createTurnState,
  type PendingRequest,
  type TurnState,
} from "./app-server-turn-state";
import { waitForAppServerTurn } from "./app-server-turn-waiter";
import {
  codexAppServerRolloutBudgetConfig,
  type CodexAppServerRolloutBudget,
} from "../domain/app-server-rollout-budget";
import { codexAppServerToolConfig } from "../domain/app-server-tool-config";
import { isCodexAppServerReconnectProgressMessage } from "../protocol/app-server-event-parser";
import { readGoal } from "../protocol/app-server-goal-protocol";
import { readCodexModelCatalogPage } from "../protocol/app-server-model-catalog";
import {
  encodeJsonRpcMessage,
  type CodexAppServerJsonRpcResponse,
} from "../protocol/app-server-json-rpc";
import {
  AppServerJsonRpcLineDecoder,
  appServerJsonRpcFrameLimit,
} from "../protocol/app-server-json-rpc-line-decoder";
import {
  CodexModelUnavailableError,
  hasCodexModel,
  isCodexModelUnavailableMessage,
  type CodexModelCatalogEntry,
} from "../domain/model-catalog";
import {
  agentMessageText,
  nestedString,
  readRecord,
  stringArrayField,
  stringField,
} from "../protocol/app-server-content-parser";
import { turnFailureError } from "./app-server-turn-failure";
import { appendTurnOutput, mergeTurnOutput, replaceTurnOutput } from "./app-server-turn-output";
import {
  AppServerExecutionMayHaveStartedError,
  AppServerRequestMayHaveReachedProviderError,
} from "../domain/app-server-execution-safety";
import { sendAppServerRequest } from "./app-server-request-sender";
import { codexAppServerProcessArgs } from "./app-server-process-args";
import { handleAppServerServerRequest } from "./app-server-server-request-handler";
import { stopAppServerProcess } from "./app-server-process-stopper";
import { appServerApprovalPolicy } from "./app-server-approval-policy";
import { appServerThreadToolPolicy } from "./app-server-thread-tool-policy";
import { handleAppServerReconnectProgress } from "./app-server-reconnect-handler";
import { handleAppServerStdout } from "./app-server-stdout-handler";
import {
  AppServerRateLimitsMonitor,
  isCodexAppServerRateLimitsRejectedError,
  type CodexAppServerRateLimitsSnapshotHandler,
} from "./app-server-rate-limits-monitor";
import { createBoundedAppServerWarningCollector } from "./app-server-warning-collector";

export {
  CodexAppServerTurnError,
  type AppServerTurnFailureDetails,
  type AppServerTurnFailurePhase,
} from "./app-server-turn-failure";
export { CodexAppServerThreadForkError, turnFailureError };

export type { AppServerTurnResult } from "./app-server-turn-state";

const maxRetainedTurnStates = appServerTurnCapacity;
const maxRetainedEarlyTurnIds = 128;
const maxRetainedTurnAliases = 128;

export class CodexAppServerClient {
  private readonly executionAdmission = new AppServerAdmission();
  private readonly turnAdmission = new AppServerAdmission();
  private nextId = 1;
  private child: CodexAppServerChildProcess | null = null;
  private readonly stdoutDecoder: AppServerJsonRpcLineDecoder;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly tokenUsage = new AppServerTokenUsageTracker((warning) => this.warnings.push(warning));
  private readonly turns = new Map<string, TurnState>();
  private readonly startingTurnThreads = new Set<string>();
  private readonly pendingTurnIdsByThread = new Map<string, string>();
  private readonly earlyTurnIdsByThread = new Map<string, string>();
  private readonly turnIdAliases = new Map<string, string>();
  private readonly warnings = createBoundedAppServerWarningCollector();
  private exited = false;
  private terminalError: Error | null = null;
  private stopping: Promise<void> | null = null;
  private readonly rateLimitsMonitor: AppServerRateLimitsMonitor | null;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly session: CodexMaterializedSession;
      readonly workspacePath: string;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly rolloutBudget?: CodexAppServerRolloutBudget;
      readonly bypassHookTrust?: boolean;
      readonly timeoutMs: number;
      readonly startupTimeoutMs: number;
      readonly reconnectGraceMs: number;
      readonly maxOutputBytes: number;
      readonly abortSignal: AbortSignal;
      readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
    },
  ) {
    this.stdoutDecoder = new AppServerJsonRpcLineDecoder(
      appServerJsonRpcFrameLimit(options.maxOutputBytes),
    );
    this.rateLimitsMonitor = options.rateLimitsSnapshotHandler
      ? new AppServerRateLimitsMonitor({
          read: async () => {
            const response = await this.send(
              "account/rateLimits/read",
              {},
              {
                timeoutMs: Math.min(this.options.timeoutMs, 5_000),
                abortSignal: this.options.abortSignal,
              },
            );
            if (response.error) {
              throw new Error(
                `codex_app_server_rate_limits_read_failed:${response.error.message ?? "unknown"}`,
              );
            }
            return response.result ?? {};
          },
          handle: options.rateLimitsSnapshotHandler,
          onBackgroundError: (error) => {
            this.warnings.push({
              code: "codex_app_server_rate_limits_update_failed",
              safeMessage: `Codex app-server rate-limit update failed: ${safeMessage(error)}`,
            });
          },
        })
      : null;
  }

  async start(): Promise<void> {
    throwIfAborted(this.options.abortSignal);
    this.exited = false;
    this.terminalError = null;
    this.stopping = null;
    this.stdoutDecoder.clear();
    const env: Record<string, string> = {
      ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
      ...this.options.session.env,
      CI: "true",
    };
    const hostJobId = (this.options.sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_HOST_JOB_ID;
    if (hostJobId !== undefined) env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID = hostJobId;
    this.child = this.options.processFactory({
      command: this.options.codexBinaryPath,
      args: codexAppServerProcessArgs(this.options),
      cwd: this.options.session.home,
      env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
    this.child.stderr.on("data", () => {
      // Keep stderr private. Codex may include environment or auth diagnostics.
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.recordTerminalError(
        new Error(`codex_app_server_exited:${code ?? signal}`),
      );
    });
    this.child.on("error", (error) => {
      this.recordTerminalError(error);
    });
    this.child.stdin.on?.("error", (error) => {
      this.recordTerminalError(error);
    });

    const response = await this.send(
      "initialize",
      {
        clientInfo: {
          name: "subscription-runtime",
          title: "ReviewRouter subscription runtime",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      {
        timeoutMs: this.options.startupTimeoutMs,
        abortSignal: this.options.abortSignal,
      },
    );
    if (response.error) {
      throw new Error(`codex_app_server_initialize_failed:${response.error.message ?? "unknown"}`);
    }
    try {
      await this.rateLimitsMonitor?.prime();
    } catch (error) {
      if (isCodexAppServerRateLimitsRejectedError(error)) throw error;
      this.warnings.push({
        code: "codex_app_server_rate_limits_read_failed",
        safeMessage: `Codex app-server rate-limit read failed: ${safeMessage(error)}`,
      });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    this.recordTerminalError(new Error("codex_app_server_stopped"));
    const stopping = this.stopChild();
    await stopping;
    await this.rateLimitsMonitor?.flush().catch(() => undefined);
  }

  drainWarnings(): AppServerWarning[] {
    return this.warnings.drain();
  }

  pushBackgroundWarning(warning: AppServerWarning): void {
    this.warnings.push(warning);
  }

  acquireExecution(): AppServerExecutionLease {
    return new AppServerExecutionLease(this.executionAdmission.acquire(), (id) => this.tokenUsage.pin(id));
  }

  async startThread(input: {
    readonly usageLease?: AppServerExecutionLease;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
  }): Promise<string> {
    const { disableTools, disableNativeEnvironments } = appServerThreadToolPolicy({
      disableTools: this.options.executionProfile.disableTools,
      nativeToolSurface: this.options.nativeToolSurface,
      goalMode: input.goalMode,
    });
    const threadPolicy = codexAppServerThreadRuntimePolicy({
      workspacePath: input.workspacePath,
      ...(input.sandboxMode === undefined
        ? {}
        : { sandboxMode: input.sandboxMode }),
      sourceEnv: this.options.sourceEnv,
      baseDeveloperInstructions:
        this.options.executionProfile.developerInstructions,
      ...(input.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.systemPrompt }),
    });
    const toolConfig = codexAppServerToolConfig({
      nativeToolSurface: this.options.nativeToolSurface,
      fastMode: input.serviceTier === "fast",
      goalMode: input.goalMode === true,
      trustedHooksEnabled: this.options.bypassHookTrust === true,
    });
    const response = await this.send(
      "thread/start",
      {
        runtimeWorkspaceRoots: threadPolicy.runtimeWorkspaceRoots,
        model: input.model,
        modelProvider: null,
        serviceTier: input.serviceTier ?? null,
        cwd: input.workspacePath,
        approvalPolicy: appServerApprovalPolicy(this.options.commandApprovalPolicy),
        approvalsReviewer: null,
        sandbox: threadPolicy.sandboxMode,
        config: {
          model_reasoning_effort: input.reasoningEffort,
          model_verbosity: "low",
          ...(input.serviceTier === undefined
            ? {}
            : { service_tier: input.serviceTier }),
          approval_policy:
            this.options.commandApprovalPolicy === undefined
              ? "never"
              : "on-request",
          sandbox_mode: threadPolicy.sandboxMode,
          web_search: "disabled",
          ...toolConfig,
          features: {
            ...(readRecord(toolConfig.features) ?? {}),
            ...codexAppServerRolloutBudgetConfig(this.options.rolloutBudget),
          },
          apps: {
            _default: {
              enabled: false,
              destructive_enabled: false,
              open_world_enabled: false,
            },
          },
        },
        serviceName: "subscription-runtime",
        baseInstructions: this.options.executionProfile.baseInstructions,
        developerInstructions: threadPolicy.developerInstructions,
        personality: null,
        ephemeral: input.goalMode ? false : true,
        sessionStartSource: "startup",
        threadSource: "user",
        ...(disableTools
          ? {
              environments: [],
              dynamicTools: [],
              experimentalRawEvents: false,
            }
          : disableNativeEnvironments
            ? {
                environments: [],
              }
            : {}),
      },
      input,
    );
    if (response.error) {
      const modelError = await this.modelUnavailableError({
        requestedModel: input.model,
        ...(response.error.message === undefined
          ? {}
          : { providerMessage: response.error.message }),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
      });
      if (modelError) throw modelError;
      throw new Error(`codex_app_server_thread_start_failed:${response.error.message ?? "unknown"}`);
    }

    const threadId = nestedString(response.result, ["thread", "id"]);
    if (!threadId) throw new Error("codex_app_server_thread_id_missing");
    return threadId;
  }

  async forkThread(input: {
    readonly usageLease?: AppServerExecutionLease;
    readonly threadId: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<string> {
    throwIfAborted(input.abortSignal);
    const response = await this.send(
      "thread/fork",
      { threadId: input.threadId },
      input,
    );
    if (response.error) {
      throw new CodexAppServerThreadForkError(
        response.error.message ?? "unknown",
      );
    }
    const threadId = nestedString(response.result, ["thread", "id"]);
    if (!threadId) throw new Error("codex_app_server_thread_id_missing");
    return threadId;
  }

  private async modelUnavailableError(input: {
    readonly requestedModel: string;
    readonly providerMessage?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexModelUnavailableError | null> {
    if (!isCodexModelUnavailableMessage(input.providerMessage ?? "")) {
      return null;
    }
    const availableModels = await this.readAvailableModels(input).catch(
      () => null,
    );
    if (
      availableModels === null ||
      hasCodexModel(availableModels, input.requestedModel)
    ) {
      return null;
    }
    return new CodexModelUnavailableError({
      requestedModel: input.requestedModel,
      availableModels,
    });
  }

  private async readAvailableModels(input: {
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly CodexModelCatalogEntry[] | null> {
    const entries: CodexModelCatalogEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const response = await this.send(
        "model/list",
        { cursor, limit: 100, includeHidden: true },
        input,
      );
      if (response.error) return null;
      const page = readCodexModelCatalogPage(response.result);
      if (!page) return null;
      entries.push(...page.data);
      if (entries.length > 500) return null;
      if (page.nextCursor === null)
        return entries.length === 0 ? null : entries;
      if (seenCursors.has(page.nextCursor)) return null;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return null;
  }

  async setGoal(input: {
    readonly threadId: string;
    readonly objective: string;
    readonly status: CodexThreadGoalStatus;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal> {
    const objectiveLimitError = appServerGoalObjectiveLimitError(
      input.objective,
    );
    if (objectiveLimitError) {
      throw new Error(
        `codex_app_server_goal_set_failed:${objectiveLimitError}`,
      );
    }
    const response = await this.send(
      "thread/goal/set",
      {
        threadId: input.threadId,
        objective: input.objective,
        status: input.status,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_set_failed:${formatGoalSetError(
          response.error.message,
          input.objective,
        )}`,
      );
    }
    const goal = readGoal(response.result?.goal);
    if (!goal) throw new Error("codex_app_server_goal_set_missing");
    return goal;
  }

  async getGoal(input: {
    readonly threadId: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<CodexThreadGoal | null> {
    const response = await this.send(
      "thread/goal/get",
      {
        threadId: input.threadId,
      },
      input,
    );
    if (response.error) {
      throw new Error(
        `codex_app_server_goal_get_failed:${response.error.message ?? "unknown"}`,
      );
    }
    return readGoal(response.result?.goal);
  }

  async startTurn(input: {
    readonly threadId: string;
    readonly prompt: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly workspacePath: string;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
    readonly turnNumber?: number;
    readonly onTextDelta?: (text: string) => void;
  }): Promise<AppServerTurnResult> {
    const release = this.turnAdmission.acquire(input.threadId);
    const usage = this.tokenUsage.activate(input.threadId);
    try {
      this.startingTurnThreads.add(input.threadId);
      const startedAt = Date.now();
      const { disableTools, disableNativeEnvironments } = appServerThreadToolPolicy({
        disableTools: this.options.executionProfile.disableTools,
        nativeToolSurface: this.options.nativeToolSurface,
        goalMode: input.goalMode,
      });
      let response: CodexAppServerJsonRpcResponse;
      try {
        response = await this.send(
          "turn/start",
          appServerTurnStartParams(input, {
            disableTools, disableNativeEnvironments,
            ...(this.options.commandApprovalPolicy === undefined ? {} : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
            sandboxPolicy: this.sandboxPolicyFor(input),
          }),
          input,
        );
      } catch (error) {
        this.clearStartingTurn(input.threadId);
        throw turnFailureError(error, {
          phase: "turn_start_rejected",
          turnNumber: input.turnNumber,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (response.error) {
        this.clearStartingTurn(input.threadId);
        throw turnFailureError(
          new Error(
            `codex_app_server_turn_start_failed:${response.error.message ?? "unknown"}`,
          ),
          {
            phase: "turn_start_rejected",
            turnNumber: input.turnNumber,
            elapsedMs: Date.now() - startedAt,
          },
        );
      }

      const turnId = nestedString(response.result, ["turn", "id"]);
      if (!turnId) {
        this.clearStartingTurn(input.threadId);
        throw turnFailureError(new AppServerRequestMayHaveReachedProviderError(
          new Error("codex_app_server_turn_id_missing"),
          "turn/start",
        ), {
          phase: "turn_start_rejected",
          turnNumber: input.turnNumber,
          elapsedMs: Date.now() - startedAt,
        });
      }
      let turn: TurnState;
      try {
        turn = await this.waitForTurn(turnId, input);
      } catch (error) {
        this.clearStartingTurn(input.threadId);
        throw turnFailureError(new AppServerExecutionMayHaveStartedError(error), {
          phase: "turn_error_before_output",
          turnNumber: input.turnNumber,
          elapsedMs: Date.now() - startedAt,
        });
      }
      this.startingTurnThreads.delete(input.threadId);
      this.clearIdleTurnState();
      if (!turn.error) return turn;
      return {
        ...turn,
        usage: turn.usage ?? usage.usage,
        error: turnFailureError(new AppServerExecutionMayHaveStartedError(turn.error), {
          phase:
            turn.outputText.length > 0
              ? "turn_error_after_output"
              : "turn_error_before_output",
          turnNumber: input.turnNumber,
          outputText: turn.outputText,
          elapsedMs: Date.now() - startedAt,
        }),
      };
    } catch (error) {
      if (usage.usage) throw new AppServerUsageError(error, usage.usage, true);
      throw error;
    } finally {
      this.tokenUsage.deactivate(input.threadId);
      release();
    }
  }

  private send(
    method: string,
    params: unknown,
    input: {
      readonly usageLease?: AppServerExecutionLease;
      readonly timeoutMs?: number;
      readonly abortSignal?: AbortSignal;
    } = {},
  ): Promise<CodexAppServerJsonRpcResponse> {
    if (!this.child) throw new Error("codex_app_server_not_started");
    throwIfAborted(input.abortSignal);
    if (this.terminalError) throw this.terminalError;
    const id = this.nextId;
    this.nextId += 1;

    return sendAppServerRequest({
      id,
      method,
      params,
      timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      ...(input.usageLease === undefined ? {} : { usageLease: input.usageLease }),
      pending: this.pending,
      write: (message) => this.child!.stdin.write(message),
    });
  }

  private sandboxPolicyFor(input: {
    readonly sandboxMode?: CodexSandboxMode;
    readonly workspacePath: string;
  }): CodexAppServerSandboxPolicy {
    return codexAppServerSandboxPolicy({
      ...input,
      sourceEnv: this.options.sourceEnv,
    });
  }

  private waitForTurn(
    turnId: string,
    input: {
      readonly threadId: string;
      readonly timeoutMs: number;
      readonly abortSignal: AbortSignal;
      readonly onTextDelta?: (text: string) => void;
    },
  ): Promise<TurnState> {
    const earlyTurnId = this.earlyTurnIdsByThread.get(input.threadId);
    if (earlyTurnId) {
      this.earlyTurnIdsByThread.delete(input.threadId);
      this.aliasTurnId(earlyTurnId, turnId);
    }
    const existing = this.turns.get(turnId);
    if (existing) this.attachTextDeltaSink(existing, input.onTextDelta);
    if (existing?.completed || existing?.error) {
      this.clearTurnTracking(turnId, input.threadId);
      return Promise.resolve(existing);
    }
    if (this.terminalError) {
      return Promise.resolve({
        ...createTurnState(),
        error: this.terminalError,
      });
    }

    const turn = existing ?? createTurnState();
    if (!existing) this.attachTextDeltaSink(turn, input.onTextDelta);
    if (turn.completed || turn.error) {
      this.clearTurnTracking(turnId, input.threadId);
      return Promise.resolve(turn);
    }
    return waitForAppServerTurn({
      turn,
      turnId,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      register: () => {
        this.turns.set(turnId, turn);
        this.pendingTurnIdsByThread.set(input.threadId, turnId);
      },
      clear: () => this.clearTurnTracking(turnId, input.threadId),
    });
  }

  private onStdout(chunk: string): void {
    handleAppServerStdout({
      decoder: this.stdoutDecoder, chunk, isTerminal: () => this.terminalError !== null,
      message: (message) => this.onMessage(message), fail: (error) => this.failProtocol(error),
    });
  }

  private onMessage(message: unknown): void {
    if (this.terminalError) return;
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (
      typeof record.id === "number" &&
      ("result" in record || "error" in record)
    ) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      this.tokenUsage.registerResponse(pending.method, record.result, pending.usageLease);
      pending.resolve(record as CodexAppServerJsonRpcResponse);
      return;
    }

    const params = readRecord(record.params);
    if (typeof record.id === "number" && typeof record.method === "string") {
      this.onServerRequest(record.id, record.method, params);
      return;
    }

    if (typeof record.method !== "string") return;
    if (record.method === "account/rateLimits/updated") {
      this.rateLimitsMonitor?.notifyRateLimitsUpdated();
      return;
    }
    if (record.method === "thread/tokenUsage/updated") {
      this.tokenUsage.observe(params, this.pendingTurnIdsByThread, this.earlyTurnIdsByThread, this.turnIdAliases, (id) => this.ensureTurn(id));
      return;
    }
    if (record.method === "item/agentMessage/delta") {
      const turnId = stringField(params, "turnId");
      const turn = this.ensureTurn(turnId);
      this.clearReconnectGraceTimer(turn);
      const delta = stringField(params, "delta") ?? "";
      if (appendTurnOutput({
        turn, text: delta, maxOutputBytes: this.options.maxOutputBytes,
        reject: () => this.resolveTurn(turn),
      })) this.emitTextDelta(turn, delta);
      return;
    }
    if (record.method === "turn/started") {
      const threadId = stringField(params, "threadId");
      const turn = readRecord(params?.turn);
      const actualTurnId = stringField(turn, "id");
      const expectedTurnId = threadId
        ? this.pendingTurnIdsByThread.get(threadId)
        : undefined;
      if (actualTurnId && expectedTurnId && actualTurnId !== expectedTurnId) {
        this.aliasTurnId(actualTurnId, expectedTurnId);
      } else if (
        actualTurnId &&
        threadId &&
        !expectedTurnId &&
        this.startingTurnThreads.has(threadId) &&
        !this.turnIdAliases.has(actualTurnId) &&
        this.earlyTurnIdsByThread.size < maxRetainedEarlyTurnIds
      ) {
        this.earlyTurnIdsByThread.set(threadId, actualTurnId);
      }
      return;
    }
    if (record.method === "item/completed") {
      const turnId = stringField(params, "turnId");
      const item = readRecord(params?.item);
      if (item?.type === "agentMessage") {
        const text = agentMessageText(item);
        if (text) {
          const turn = this.ensureTurn(turnId);
          this.clearReconnectGraceTimer(turn);
          replaceTurnOutput({
            turn, text, maxOutputBytes: this.options.maxOutputBytes,
            reject: () => this.resolveTurn(turn),
          });
        }
      }
      return;
    }
    if (record.method === "turn/completed") {
      const turn = readRecord(params?.turn);
      const turnId = stringField(turn, "id");
      const state = this.ensureTurn(turnId);
      state.completed = true;
      const status = readRecord(turn?.status);
      const statusType = stringField(turn, "status") ??
        stringField(status, "type");
      if (statusType === "failed") {
        state.error = codexAppServerProviderError(
          "codex_app_server_turn_failed",
          turn?.error ?? status ?? params ?? record,
        );
      }
      this.resolveTurn(state);
      return;
    }
    if (record.method === "turn/aborted" || record.method === "turn_aborted") {
      const turnId =
        stringField(params, "turnId") ??
        stringField(params, "turn_id") ??
        stringField(readRecord(params?.turn), "id");
      const reason =
        stringField(params, "reason") ??
        stringField(readRecord(params?.status), "reason") ??
        "unknown";
      const error = new Error(
        `codex_app_server_turn_aborted:${reason}:${turnId ?? "unknown"}`,
      );
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
      return;
    }
    if (record.method === "error") {
      const turnId = stringField(params, "turnId");
      const errorPayload = params?.error ?? params ?? record;
      const message = safeMessage(errorPayload);
      if (isCodexAppServerReconnectProgressMessage(message)) {
        this.deferTurnsForReconnectProgress(turnId, message);
        return;
      }
      const error = codexAppServerProviderError(
        "codex_app_server_error",
        errorPayload,
      );
      if (!turnId) {
        for (const turn of this.turns.values()) {
          turn.error = error;
          this.resolveTurn(turn);
        }
        return;
      }
      const turn = this.ensureTurn(turnId);
      turn.error = error;
      this.resolveTurn(turn);
    }
  }

  private deferTurnsForReconnectProgress(
    turnId: string | null,
    message: string,
  ): void {
    handleAppServerReconnectProgress({
      turnId, message, turns: () => this.turns.values(), findTurn: (id) => this.findTurn(id),
      warn: (safeMessage) => this.warnings.push({ code: "codex_app_server_reconnecting", safeMessage }),
      schedule: (turn, reconnectMessage) => this.scheduleReconnectGraceTimeout(turn, reconnectMessage),
    });
  }

  private scheduleReconnectGraceTimeout(
    turn: TurnState,
    message: string,
  ): void {
    this.clearReconnectGraceTimer(turn);
    turn.reconnectGraceTimer = setTimeout(() => {
      if (turn.completed || turn.error) return;
      turn.error = new Error(
        `codex_app_server_reconnect_timeout:${safeMessage(message)}`,
      );
      this.resolveTurn(turn);
    }, this.options.reconnectGraceMs);
  }

  private onServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    handleAppServerServerRequest({
      id,
      method,
      params,
      ...(this.options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      warn: (warning) => this.warnings.push(warning),
      respond: (requestId, result) => this.respondServerRequest(requestId, result),
      respondError: (requestId, message) => this.respondServerRequestError(requestId, message),
    });
  }

  private respondServerRequest(
    id: number,
    result: Record<string, unknown>,
  ): void {
    try {
      this.child?.stdin.write(encodeJsonRpcMessage({ id, result }));
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private respondServerRequestError(id: number, message: string): void {
    try {
      this.child?.stdin.write(
        encodeJsonRpcMessage({
          id,
          error: {
            code: -32000,
            message,
          },
        }),
      );
    } catch (error) {
      this.recordTerminalError(
        new Error(
          `codex_app_server_unsupported_response_failed:${safeMessage(error)}`,
        ),
      );
    }
  }

  private ensureTurn(turnId: string | null): TurnState {
    if (!turnId) return createTurnState();
    const canonicalTurnId = this.turnIdAliases.get(turnId) ?? turnId;
    let turn = this.turns.get(canonicalTurnId);
    if (!turn) {
      if (!this.hasActiveTurnWork()) return createTurnState();
      if (this.turns.size >= maxRetainedTurnStates) {
        this.failProtocol(new Error("codex_app_server_turn_state_limit_exceeded"));
        return createTurnState();
      }
      turn = createTurnState();
      this.turns.set(canonicalTurnId, turn);
    }
    return turn;
  }

  private findTurn(turnId: string): TurnState | null {
    return this.turns.get(this.turnIdAliases.get(turnId) ?? turnId) ?? null;
  }

  private resolveTurn(turn: TurnState): void {
    this.clearReconnectGraceTimer(turn);
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }

  private failOutstanding(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      turn.error = error;
      this.resolveTurn(turn);
    }
    this.turns.clear();
    this.pendingTurnIdsByThread.clear();
    this.earlyTurnIdsByThread.clear();
    this.startingTurnThreads.clear();
    this.turnIdAliases.clear();
  }

  private recordTerminalError(error: Error): void {
    this.terminalError = this.terminalError ?? error;
    this.stdoutDecoder.clear();
    this.failOutstanding(this.terminalError);
  }

  private failProtocol(error: unknown): void {
    const terminalError = error instanceof Error
      ? error
      : new Error("codex_app_server_json_rpc_frame_limit_exceeded");
    this.recordTerminalError(terminalError);
    void this.stopChild().catch(() => undefined);
  }

  private stopChild(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.child = null;
    this.stopping = stopAppServerProcess({
      child,
      exited: this.exited,
      signal: this.options.signalChildProcess,
    });
    return this.stopping;
  }

  private clearTurnTracking(turnId: string, threadId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) this.clearReconnectGraceTimer(turn);
    this.turns.delete(turnId);
    this.pendingTurnIdsByThread.delete(threadId);
    this.earlyTurnIdsByThread.delete(threadId);
    this.deleteTurnAliases(turnId);
  }

  private deleteTurnAliases(turnId: string): void {
    for (const [actualTurnId, expectedTurnId] of this.turnIdAliases) {
      if (actualTurnId === turnId || expectedTurnId === turnId) {
        this.turnIdAliases.delete(actualTurnId);
      }
    }
  }

  private aliasTurnId(actualTurnId: string, expectedTurnId: string): void {
    if (actualTurnId === expectedTurnId) return;
    if (
      !this.turnIdAliases.has(actualTurnId) &&
      this.turnIdAliases.size >= maxRetainedTurnAliases
    ) {
      this.failProtocol(new Error("codex_app_server_turn_alias_limit_exceeded"));
      return;
    }
    this.turnIdAliases.set(actualTurnId, expectedTurnId);
    const actual = this.turns.get(actualTurnId);
    if (!actual) return;
    const expected = this.turns.get(expectedTurnId);
    if (expected) {
      if (mergeTurnOutput({
        expected, actual, maxOutputBytes: this.options.maxOutputBytes,
        reject: () => this.resolveTurn(expected),
      })) {
        this.emitTextDelta(expected, actual.outputText);
      }
      expected.completed = expected.completed || actual.completed;
      expected.error = expected.error ?? actual.error;
      this.tokenUsage.adoptAliasedTurn(expected, actual);
      expected.waiters.push(...actual.waiters);
      if (expected.completed || expected.error) {
        this.resolveTurn(expected);
      }
    } else {
      this.turns.set(expectedTurnId, actual);
    }
    this.turns.delete(actualTurnId);
  }

  private hasActiveTurnWork(): boolean {
    if (
      this.pendingTurnIdsByThread.size > 0 ||
      this.earlyTurnIdsByThread.size > 0 ||
      this.startingTurnThreads.size > 0
    ) return true;
    for (const turn of this.turns.values()) {
      if (turn.waiters.length > 0) return true;
    }
    return false;
  }

  private clearStartingTurn(threadId: string): void {
    this.startingTurnThreads.delete(threadId);
    const earlyTurnId = this.earlyTurnIdsByThread.get(threadId);
    if (earlyTurnId) this.turns.delete(earlyTurnId);
    this.earlyTurnIdsByThread.delete(threadId);
    this.clearIdleTurnState();
  }

  private clearIdleTurnState(): void {
    if (this.hasActiveTurnWork()) return;
    for (const turn of this.turns.values()) this.clearReconnectGraceTimer(turn);
    this.turns.clear();
    this.earlyTurnIdsByThread.clear();
    this.turnIdAliases.clear();
  }

  private clearReconnectGraceTimer(turn: TurnState): void {
    if (!turn.reconnectGraceTimer) return;
    clearTimeout(turn.reconnectGraceTimer);
    turn.reconnectGraceTimer = null;
  }

  private attachTextDeltaSink(
    turn: TurnState,
    sink: ((text: string) => void) | undefined,
  ): void {
    turn.onTextDelta = sink ?? null;
    if (turn.outputText) this.emitTextDelta(turn, turn.outputText);
  }

  private emitTextDelta(turn: TurnState, text: string): void {
    if (!turn.onTextDelta || turn.error) return;
    try {
      turn.onTextDelta(text);
    } catch (error) {
      turn.error = new Error("codex_app_server_text_delta_sink_failed", {
        cause: error,
      });
      this.resolveTurn(turn);
    }
  }

}
