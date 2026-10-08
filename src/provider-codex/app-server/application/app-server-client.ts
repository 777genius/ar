import { nativeWebId } from "@vioxen/subscription-runtime/core";
import { AppServerNativeWebCapture } from "./app-server-native-web";
import { appServerThreadToolPolicy } from "./app-server-thread-tool-policy";
import { hostedCodexPermissionProfileId } from "../../hosted-codex-permissions";
import { codexProviderHasPublicSources } from "../../codex-provider-egress-policy";
import { attachAppServerTextDeltaSink, clearAppServerReconnectTimer, emitAppServerTextDelta } from "./app-server-turn-state";
import { assertAppServerExecutionActive, observeAppServerExecutionLifetime, sendAppServerLifetimeRequest, AppServerExecutionLifetime, AppServerChildLifetime } from "./app-server-child-lifetime";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { AppServerAdmission, AppServerExecutionLease, appServerTurnCapacity } from "./app-server-admission";
import { AppServerUsageError } from "../domain/app-server-usage-error";
import { appServerTurnStartParams } from "./app-server-turn-start-params";
import { AppServerTokenUsageTracker } from "./app-server-turn-usage";
import { pruneCodexChildEnv } from "../../codex-cli-domain";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import {
  CodexModelBackend,
} from "../../codex-model-backend";
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
  type AppServerAcknowledgedTurnResult,
  createTurnState,
  type PendingRequest,
  type TurnState,
} from "./app-server-turn-state";
import { waitForAppServerTurn } from "./app-server-turn-waiter";
import {
  type CodexAppServerRolloutBudget,
} from "../domain/app-server-rollout-budget";
import { isCodexAppServerReconnectProgressMessage } from "../protocol/app-server-event-parser";
import { readGoal } from "../protocol/app-server-goal-protocol";
import {
  encodeJsonRpcMessage,
  type CodexAppServerJsonRpcResponse,
} from "../protocol/app-server-json-rpc";
import {
  AppServerJsonRpcLineDecoder,
  appServerJsonRpcFrameLimit,
} from "../protocol/app-server-json-rpc-line-decoder";
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
import { codexAppServerProcessArgs } from "./app-server-process-args";
import { handleAppServerServerRequest } from "./app-server-server-request-handler";
import { stopAppServerProcess } from "./app-server-process-stopper";
import { handleAppServerReconnectProgress } from "./app-server-reconnect-handler";
import { handleAppServerStdout } from "./app-server-stdout-handler";
import {
  AppServerRateLimitsMonitor,
  isCodexAppServerRateLimitsRejectedError,
  type CodexAppServerRateLimitsSnapshotHandler,
} from "./app-server-rate-limits-monitor";
import { createBoundedAppServerWarningCollector } from "./app-server-warning-collector";
import { appServerThreadStartParams } from "./app-server-thread-start-params";
import { PublicResearchToolSession } from "./public-research-source-tool";
import type { PublicResearchSourceReader } from "./public-research-source-port";
import { codexProviderWebSearchMode, CodexWebSearchMode, CodexProviderEgressProfileId, type CodexProviderEgressPolicy } from "../../codex-provider-egress-policy";
import { type HostedControllerDynamicToolAdapter } from "../domain/hosted-controller-dynamic-tools";
import { AppServerDynamicToolHandler } from "./app-server-dynamic-tool-handler";
import { modelUnavailableError } from "./app-server-model-unavailable";
export {
  CodexAppServerTurnError,
  type AppServerTurnFailureDetails,
  type AppServerTurnFailurePhase,
} from "./app-server-turn-failure";
export { CodexAppServerThreadForkError, turnFailureError };

export type { AppServerTurnResult, AppServerAcknowledgedTurnResult } from "./app-server-turn-state";

const maxRetainedTurnStates = appServerTurnCapacity;
const maxRetainedEarlyTurnIds = 128;
const maxRetainedTurnAliases = 128;
const maxRetainedServerRequestIds = 4096;

export class CodexAppServerClient {
  private readonly publicResearchTools = new PublicResearchToolSession();
  private readonly executionAdmission = new AppServerAdmission();
  private readonly turnAdmission = new AppServerAdmission();
  private nextId = 1;
  readonly executionLifetime: AppServerExecutionLifetime | undefined;
  private readonly childLifetime: AppServerChildLifetime | undefined;
  private child: CodexAppServerChildProcess | null = null;
  private readonly stdoutDecoder: AppServerJsonRpcLineDecoder;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly serverRequestIds = new Set<string>();
  private readonly tokenUsage = new AppServerTokenUsageTracker((warning) => this.warnings.push(warning));
  private readonly nativeWebCaptures = new Map<string, AppServerNativeWebCapture>();
  private readonly turns = new Map<string, TurnState>();
  private readonly startingTurnThreads = new Set<string>();
  private readonly pendingTurnIdsByThread = new Map<string, string>();
  private readonly earlyTurnIdsByThread = new Map<string, string>();
  private readonly turnIdAliases = new Map<string, string>();
  private readonly dynamicTools: AppServerDynamicToolHandler;
  private readonly warnings = createBoundedAppServerWarningCollector();
  private exited = false;
  private terminalError: Error | null = null;
  private stopping: Promise<void> | null = null;
  private readonly rateLimitsMonitor: AppServerRateLimitsMonitor | null;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly childBudget?: ChildExecutionBudget;
      readonly sourceEnv: Readonly<Record<string, string | undefined>>;
      readonly providerEgressPolicy?: CodexProviderEgressPolicy;
      readonly publicSourceReader?: PublicResearchSourceReader;
      readonly hostedPermissionProfiles?: boolean;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly session: CodexMaterializedSession;
      readonly workspacePath: string;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly hostedControllerTools?: HostedControllerDynamicToolAdapter;
      readonly rolloutBudget?: CodexAppServerRolloutBudget;
      readonly bypassHookTrust?: boolean;
      readonly timeoutMs: number;
      readonly startupTimeoutMs: number;
      readonly reconnectGraceMs: number;
      readonly maxOutputBytes: number;
      readonly abortSignal: AbortSignal;
      readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
      /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior is unchanged. */
      readonly modelBackend?: CodexModelBackend;
    },
  ) {
    this.executionLifetime = observeAppServerExecutionLifetime(options.session, error => this.failProtocol(error));
    this.childLifetime = options.childBudget ? new AppServerChildLifetime(options.childBudget, {
      isTerminal: () => this.terminalError !== null,
      activeTurns: () => [...this.pendingTurnIdsByThread],
      recordTerminal: error => this.recordTerminalError(error),
      interrupt: (threadId, turnId) => { this.child?.stdin.write(encodeJsonRpcMessage({ id: this.nextId++, method: "turn/interrupt", params: { threadId, turnId } })); },
      stop: () => this.stopChild(),
    }) : undefined;
    this.dynamicTools = new AppServerDynamicToolHandler({
      ...(options.hostedControllerTools ? { adapter: options.hostedControllerTools } : {}),
      isActiveTurn: (threadId, turnId) => {
        const expected = this.pendingTurnIdsByThread.get(threadId);
        const early = this.startingTurnThreads.has(threadId)
          ? this.earlyTurnIdsByThread.get(threadId) : undefined;
        const canonical = this.turnIdAliases.get(turnId) ?? turnId;
        return (expected === canonical || early === turnId) &&
          !this.findTurn(turnId)?.completed && !this.findTurn(turnId)?.error;
      },
      logicalTurnId: (turnId) => this.turnIdAliases.get(turnId) ?? turnId,
      isTerminal: () => this.terminalError !== null,
      respond: (id, result) => this.respondServerRequest(id, result),
    });
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

  get childBudget(): ChildExecutionBudget | undefined { return this.options.childBudget; }

  async start(): Promise<void> {
    this.executionLifetime?.assertActive(this.options.abortSignal);
    this.executionLifetime?.beforeProviderStart();
    this.childLifetime?.beforeProviderStart(this.options.nativeToolSurface, Boolean(this.options.hostedControllerTools));
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
    this.assertExecutionActive(this.options.abortSignal);
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

    this.childLifetime?.armDeadline();
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
    this.assertExecutionActive(this.options.abortSignal);
    this.executionLifetime?.markInitialized();
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
    this.executionLifetime?.close();
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

  releasePublicResearchThread(threadId: string): void {
    this.publicResearchTools.closeThread(threadId);
  }

  acquireExecution(): AppServerExecutionLease {
    return new AppServerExecutionLease(this.executionAdmission.acquire(), (id) => {
      const release = this.tokenUsage.pin(id);
      return () => { this.publicResearchTools.closeThread(id); release(); };
    });
  }

  /** Reopen only after the goal runner has validated its retained runtime scope.
   * Codex 0.159.2 has no dynamicTools parameter on resume or fork. Those tools
   * must be inherited from the rollout; a target canary must prove that behavior. */
  async resumePublicResearchThread(input: Parameters<typeof appServerThreadStartParams>[0] & {
    readonly threadId: string; readonly timeoutMs: number; readonly abortSignal: AbortSignal;
  }): Promise<void> {
    if (!codexProviderHasPublicSources(this.options.providerEgressPolicy)) return;
    const plan = appServerThreadStartParams({ ...input, goalMode: true }, this.options);
    const response = await this.send("thread/resume", { threadId: input.threadId,
      ...this.retainedThreadParams(plan.params) }, input);
    if (response.error || nestedString(response.result, ["thread", "id"]) !== input.threadId) {
      throw new Error("codex_app_server_research_resume_failed");
    }
    if (plan.researchToolsEnabled) this.publicResearchTools.admit(input.threadId);
  }

  private retainedThreadParams(params: ReturnType<typeof appServerThreadStartParams>["params"]) {
    // Exact supported resume/fork schema subset; never claim to re-register
    // dynamic tools through fields the target does not support.
    return { config: params.config, cwd: params.cwd, model: params.model,
      modelProvider: params.modelProvider, serviceTier: "serviceTier" in params ? params.serviceTier : null,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots, approvalPolicy: params.approvalPolicy,
      ...("permissions" in params ? { permissions: params.permissions } : { sandbox: params.sandbox }),
      baseInstructions: params.baseInstructions, developerInstructions: params.developerInstructions };
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
    this.assertExecutionActive(input.abortSignal);
    const plan = appServerThreadStartParams(input, this.options);
    const response = await this.send("thread/start", plan.params, input);
    if (response.error) {
      const modelError = await modelUnavailableError({
        sendPage: (cursor) => this.send("model/list", { cursor, limit: 100, includeHidden: true }, input),
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
    this.assertExecutionActive(input.abortSignal);
    if (!threadId?.trim() || (this.executionLifetime && !/^[A-Za-z0-9_.:-]{1,128}$/.test(threadId))) throw new Error("codex_app_server_thread_id_missing");
    if (this.options.hostedControllerTools) this.dynamicTools.addThread(threadId);
    if (plan.researchToolsEnabled) this.publicResearchTools.admit(threadId);
    return threadId;
  }

  async forkThread(input: Parameters<typeof appServerThreadStartParams>[0] & {
    readonly usageLease?: AppServerExecutionLease;
    readonly threadId: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<string> {
    throwIfAborted(input.abortSignal);
    const plan = appServerThreadStartParams(input, this.options);
    const response = await this.send("thread/fork", { threadId: input.threadId,
      // Preserve ordinary behavior. Captured research/closed tool policy is
      // explicitly overlaid whenever the runtime has selected a finite profile.
      ...(codexProviderHasPublicSources(this.options.providerEgressPolicy)
        ? { ...this.retainedThreadParams(plan.params), deferGoalContinuation: true }
        : this.options.providerEgressPolicy ? { config: { web_search: plan.params.config.web_search } } : {}),
    }, input);
    if (response.error) throw new CodexAppServerThreadForkError(response.error.message ?? "unknown");
    const threadId = nestedString(response.result, ["thread", "id"]);
    this.assertExecutionActive(input.abortSignal);
    if (!threadId?.trim() || (this.executionLifetime && !/^[A-Za-z0-9_.:-]{1,128}$/.test(threadId))) throw new Error("codex_app_server_thread_id_missing");
    if (this.options.hostedControllerTools) this.dynamicTools.addThread(threadId);
    if (plan.researchToolsEnabled) this.publicResearchTools.admit(threadId);
    return threadId;
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
    readonly sandboxMode?: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly goalMode?: boolean;
    readonly turnNumber?: number;
    readonly onTextDelta?: (text: string) => void;
  }): Promise<AppServerAcknowledgedTurnResult> {
    if (!nativeWebId(input.threadId)) throw new Error("codex_app_server_thread_id_invalid");
    const targetedThreadId = input.threadId;
    const release = this.turnAdmission.acquire(input.threadId);
    const usage = this.tokenUsage.activate(input.threadId);
    const nativeWeb = new AppServerNativeWebCapture(input.threadId);
    try {
      this.nativeWebCaptures.set(input.threadId, nativeWeb);
      this.startingTurnThreads.add(input.threadId);
      this.publicResearchTools.beginTurn(input.threadId, input.abortSignal);
      const startedAt = Date.now();
      const { disableTools, disableNativeEnvironments } = appServerThreadToolPolicy({
        disableTools: this.options.executionProfile.disableTools,
        nativeToolSurface: this.options.nativeToolSurface,
        goalMode: input.goalMode,
      });
      let response: CodexAppServerJsonRpcResponse;
      try {
        const hostedPermissions = this.options.hostedPermissionProfiles
          ? hostedCodexPermissionProfileId(
              input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode },
            )
          : null;
        response = await this.send(
          "turn/start",
          appServerTurnStartParams({
            ...input,
            ...(this.options.modelBackend === undefined
              ? {}
              : { modelBackend: this.options.modelBackend }),
          }, {
            disableTools, disableNativeEnvironments,
            ...(this.options.commandApprovalPolicy === undefined ? {} : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
            ...(hostedPermissions
              ? { permissions: hostedPermissions }
              : { sandboxPolicy: codexAppServerSandboxPolicy({ ...input, sourceEnv: this.options.sourceEnv }) }),
          }),
          { ...input, observeResponse: response => {
            const id = nestedString(response.result, ["turn", "id"]);
            if (!response.error && id) {
              nativeWeb.bind(id);
              this.publicResearchTools.bindTurn(input.threadId, id);
            }
          } },
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
      if (!nativeWebId(turnId)) {
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
      const identity = { threadId: targetedThreadId, acknowledgedTurnId: turnId };
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
      const evidence = nativeWeb.result();
      const receipt = evidence === undefined ? {} : { nativeWeb: evidence };
      if (!turn.error) return { ...turn, ...identity, ...receipt };
      return {
        ...turn,
        ...identity,
        ...receipt,
        usage: turn.usage ?? usage.usage,
        error: turnFailureError(new AppServerExecutionMayHaveStartedError(turn.error), {
          phase: turn.outputText.length > 0 ? "turn_error_after_output" : "turn_error_before_output",
          turnNumber: input.turnNumber,
          outputText: turn.outputText,
          elapsedMs: Date.now() - startedAt,
        }),
      };
    } catch (error) {
      const evidence = nativeWeb.result();
      if (usage.usage || evidence) throw new AppServerUsageError(error, usage.usage, true, evidence);
      throw error;
    } finally {
      this.nativeWebCaptures.delete(input.threadId);
      this.publicResearchTools.endTurn(input.threadId);
      this.tokenUsage.deactivate(input.threadId);
      release();
    }
  }

  private async send(
    method: string,
    params: unknown,
    input: {
      readonly usageLease?: AppServerExecutionLease;
      readonly observeResponse?: (response: CodexAppServerJsonRpcResponse) => void;
      readonly timeoutMs?: number;
      readonly abortSignal?: AbortSignal;
    } = {},
  ): Promise<CodexAppServerJsonRpcResponse> {
    return await sendAppServerLifetimeRequest(method, params, input, {
      child: this.child, terminalError: this.terminalError, id: this.nextId++,
      pending: this.pending, timeoutMs: this.options.timeoutMs,
      childBudget: this.options.childBudget, childLifetime: this.childLifetime,
      executionLifetime: this.executionLifetime,
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
    const remainingMs = this.executionLifetime || this.options.childBudget ? this.assertExecutionActive(input.abortSignal) : undefined;
    const earlyTurnId = this.earlyTurnIdsByThread.get(input.threadId);
    if (earlyTurnId) {
      this.earlyTurnIdsByThread.delete(input.threadId);
      this.aliasTurnId(earlyTurnId, turnId);
    }
    const existing = this.turns.get(turnId);
    if (existing) attachAppServerTextDeltaSink(existing, input.onTextDelta, () => this.resolveTurn(existing));
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
    if (!existing) attachAppServerTextDeltaSink(turn, input.onTextDelta, () => this.resolveTurn(turn));
    if (turn.completed || turn.error) {
      this.clearTurnTracking(turnId, input.threadId);
      return Promise.resolve(turn);
    }
    return waitForAppServerTurn({
      turn,
      turnId,
      timeoutMs: remainingMs === undefined ? input.timeoutMs : Math.min(input.timeoutMs, remainingMs),
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
    try { this.assertExecutionActive(); } catch { return; }
    if (this.childLifetime && !this.childLifetime.eventAllowed()) return;
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
    if ((typeof record.id === "number" || typeof record.id === "string") && typeof record.method === "string") {
      this.onServerRequest(record.id, record.method, params);
      return;
    }

    if (typeof record.method !== "string") return;
    if (record.method === "thread/closed" || record.method === "thread/archived") {
      const threadId = stringField(params, "threadId");
      if (threadId) this.publicResearchTools.closeThread(threadId);
      return;
    }
    if (record.method === "serverRequest/resolved") {
      this.dynamicTools.resolve(params?.threadId, params?.requestId);
      return;
    }
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
      clearAppServerReconnectTimer(turn);
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
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      // A specific pre-ACK failure already owns its TurnState, even when no
      // notification identifies the capture. Reject later input by that fact;
      // only the response ACK may admit the retained preterminal buffer.
      if (threadId && !(turnId && this.findTurn(turnId)?.error)) {
        this.nativeWebCaptures.get(threadId)?.observe(params, false);
      }
      const item = readRecord(params?.item);
      if (item?.type === "agentMessage") {
        const text = agentMessageText(item);
        if (text) {
          const turn = this.ensureTurn(turnId);
          clearAppServerReconnectTimer(turn);
          replaceTurnOutput({
            turn, text, maxOutputBytes: this.options.maxOutputBytes,
            reject: () => this.resolveTurn(turn),
          });
        }
      }
      return;
    }
    if (record.method === "turn/completed") {
      const threadId = stringField(params, "threadId");
      if (threadId) this.nativeWebCaptures.get(threadId)?.observe(params, true);
      const turn = readRecord(params?.turn);
      const turnId = stringField(turn, "id");
      if (turnId) this.publicResearchTools.endTurnId(this.turnIdAliases.get(turnId) ?? turnId);
      if (turnId) this.dynamicTools.cancelTurn(turnId);
      const state = this.ensureTurn(turnId);
      for (const [thread, pendingId] of this.pendingTurnIdsByThread) {
        if (pendingId === (this.turnIdAliases.get(turnId ?? "") ?? turnId)) this.nativeWebCaptures.get(thread)?.finish();
      }
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
      if (turnId) this.dynamicTools.cancelTurn(turnId);
      const reason =
        stringField(params, "reason") ??
        stringField(readRecord(params?.status), "reason") ??
        "unknown";
      const error = new Error(
        `codex_app_server_turn_aborted:${reason}:${turnId ?? "unknown"}`,
      );
      this.failTurnOrAll(turnId, error, stringField(params, "threadId"));
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
      this.failTurnOrAll(turnId, error, stringField(params, "threadId"));
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
    clearAppServerReconnectTimer(turn);
    turn.reconnectGraceTimer = setTimeout(() => {
      if (turn.completed || turn.error) return;
      turn.error = new Error(
        `codex_app_server_reconnect_timeout:${safeMessage(message)}`,
      );
      this.resolveTurn(turn);
    }, this.options.reconnectGraceMs);
  }

  private onServerRequest(
    id: string | number,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    if ((typeof id === "string" && (id.length === 0 || id.length > 128)) ||
        (typeof id === "number" && !Number.isSafeInteger(id))) {
      this.failProtocol(new Error("codex_app_server_server_request_id_invalid"));
      return;
    }
    const requestKey = `${typeof id}:${id}`;
    if (this.serverRequestIds.has(requestKey)) return;
    if (this.serverRequestIds.size >= maxRetainedServerRequestIds) {
      this.failProtocol(new Error("codex_app_server_server_request_id_limit_exceeded"));
      return;
    }
    this.serverRequestIds.add(requestKey);
    handleAppServerServerRequest({
      id,
      method,
      params,
      ...(this.options.publicSourceReader ? { publicSourceTools: {
        reader: this.options.publicSourceReader, session: this.publicResearchTools,
      } } : {}),
      ...(this.options.hostedControllerTools ? {
        dynamicToolCall: (requestId: string | number, requestParams: Record<string, unknown> | null) => {
          void this.dynamicTools.call(requestId, requestParams);
        },
      } : {}),
      ...(this.options.childBudget
        ? { commandApprovalPolicy: { reviewCommand: () => ({ approved: false, reason: "child_native_tools_denied" }) } }
        : this.options.commandApprovalPolicy === undefined ? {} : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      warn: (warning) => this.warnings.push(warning),
      respond: (requestId, result) => this.respondServerRequest(requestId, result),
      respondError: (requestId, message) => this.respondServerRequestError(requestId, message),
    });
  }

  private respondServerRequest(
    id: string | number,
    result: Record<string, unknown>,
  ): void {
    this.writeServerResponse({ id, result });
  }

  private respondServerRequestError(id: string | number, message: string): void {
    this.writeServerResponse({ id, error: { code: -32000, message } });
  }

  private writeServerResponse(payload: {
    readonly id: string | number;
    readonly result?: Record<string, unknown>;
    readonly error?: { readonly code: number; readonly message: string };
  }): void {
    try {
      if (this.terminalError) return;
      this.assertExecutionActive();
      const write = () => this.child?.stdin.write(encodeJsonRpcMessage(payload)) ?? false;
      if (this.childLifetime) this.childLifetime.write("tool/response", write); else write();
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
    clearAppServerReconnectTimer(turn);
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }

  private failTurnOrAll(turnId: string | null | undefined, error: Error, threadId?: string | null): void {
    const canonicalTurnId = turnId ? this.turnIdAliases.get(turnId) ?? turnId : "";
    // Seal capture input synchronously, before any failure waiter can settle.
    // Early/output identities select the owner; only response ACK binds receipts.
    for (const [thread, capture] of this.nativeWebCaptures) {
      if (!turnId || thread === threadId || capture.matchesAcknowledgedTurn(canonicalTurnId) ||
        this.pendingTurnIdsByThread.get(thread) === canonicalTurnId ||
        this.earlyTurnIdsByThread.get(thread) === turnId) capture.finish();
    }
    if (!turnId) {
      for (const thread of this.startingTurnThreads) this.publicResearchTools.endTurn(thread);
      for (const thread of this.pendingTurnIdsByThread.keys()) this.publicResearchTools.endTurn(thread);
      for (const turn of this.turns.values()) {
        turn.error = error;
        this.resolveTurn(turn);
      }
      return;
    }
    this.publicResearchTools.endTurnId(this.turnIdAliases.get(turnId) ?? turnId);
    const turn = this.ensureTurn(turnId);
    turn.error = error;
    this.resolveTurn(turn);
  }

  private failOutstanding(error: Error): void {
    this.publicResearchTools.stop();
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
    this.executionLifetime?.close(error);
    this.dynamicTools.close();
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

  /** Scoped process stop request only; this does not prove host custody release. */
  requestChildCleanup(error: unknown): void {
    if (this.childLifetime) this.childLifetime.cleanup(error); else this.failProtocol(error);
  }

  assertExecutionActive(signal?: AbortSignal): number {
    return assertAppServerExecutionActive(this.executionLifetime, this.options.childBudget, this.terminalError, signal);
  }

  private stopChild(): Promise<void> {
    this.childLifetime?.disposeTimer();
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
    this.publicResearchTools.endTurn(threadId);
    this.dynamicTools.cancelTurn(turnId);
    const turn = this.turns.get(turnId);
    if (turn) clearAppServerReconnectTimer(turn);
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
    this.dynamicTools.aliasTurn(actualTurnId, expectedTurnId);
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
    this.publicResearchTools.endTurn(threadId);
    const earlyTurnId = this.earlyTurnIdsByThread.get(threadId);
    if (earlyTurnId) this.dynamicTools.cancelTurn(earlyTurnId);
    this.startingTurnThreads.delete(threadId);
    if (earlyTurnId) this.turns.delete(earlyTurnId);
    this.earlyTurnIdsByThread.delete(threadId);
    this.clearIdleTurnState();
  }

  private clearIdleTurnState(): void {
    if (this.hasActiveTurnWork()) return;
    for (const turn of this.turns.values()) clearAppServerReconnectTimer(turn);
    this.turns.clear();
    this.earlyTurnIdsByThread.clear();
    this.turnIdAliases.clear();
  }

  private emitTextDelta(turn: TurnState, text: string): void {
    emitAppServerTextDelta(turn, text, () => this.resolveTurn(turn));
  }
}
