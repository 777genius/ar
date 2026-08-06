import { EventEmitter } from "node:events";

export type FakeAppServerFactoryOptions = {
  readonly failThreadStart?: boolean;
  readonly failThreadStartNumbers?: readonly number[];
  readonly threadStartError?: string;
  readonly threadForkError?: string;
  readonly suppressThreadForkResponse?: boolean;
  readonly availableModels?: readonly {
    readonly model: string;
    readonly supportedReasoningEfforts?: readonly string[];
    readonly hidden?: boolean;
    readonly isDefault?: boolean;
  }[];
  readonly suppressInitializeResponse?: boolean;
  readonly initializeError?: string;
  readonly emitUnsupportedServerRequestOnTurn?: boolean;
  readonly throwOnUnsupportedServerResponse?: boolean;
  readonly emitTransientTopLevelErrorOnTurn?: string;
  readonly emitTopLevelErrorOnTurn?: string;
  readonly emitTopLevelErrorsOnTurns?: readonly (string | null)[];
  readonly emitCodexErrorOnTurn?: {
    readonly message: string;
    readonly codexErrorInfo: string;
  };
  readonly completeTurnWithError?: {
    readonly message: string;
    readonly codexErrorInfo: string;
  };
  readonly emitStdinErrorAfterTurnStartResponse?: boolean;
  readonly emitProcessErrorOnTurn?: boolean;
  readonly emitProcessErrorAfterTurnStartResponse?: boolean;
  readonly emitTurnEventsWithStartResponse?: boolean;
  readonly emitTurnCompletionBeforeStarted?: boolean;
  readonly completedAgentMessageContentOnly?: boolean;
  readonly appendCompletedAgentMessageToolContent?: boolean;
  readonly throwOnRequestMethod?: string;
  readonly exitOnStdinEnd?: boolean;
  readonly ignoreSigterm?: boolean;
  readonly abortTurnNumbers?: readonly number[];
  readonly abortTurnReason?: string;
  readonly suppressOutputTurnNumbers?: readonly number[];
  readonly goalStatusesAfterTurns?: readonly string[];
  readonly turnUsage?: Record<string, unknown>;
  readonly mismatchTurnStartResponseId?: boolean;
  readonly reuseActualTurnId?: string;
  readonly effectiveModel?: string;
  readonly omitThreadReceiptMetadata?: boolean;
  readonly emitModelRerouted?: boolean;
  readonly duplicateTurnCompletion?: boolean;
  readonly lateDuplicateTurnCompletion?: boolean;
  readonly postTerminalTokenUsage?: boolean;
  readonly postTerminalAgentMessageDelta?: boolean;
  readonly wrongTurnCompletionId?: string;
  readonly suppressTokenUsage?: boolean;
  readonly wrongTokenUsageThreadId?: string;
  readonly wrongTokenUsageTurnId?: string;
  readonly duplicateTokenUsage?: boolean;
  readonly tokenUsageUpdates?: readonly Record<string, unknown>[];
  readonly suppressTurnCompletion?: boolean;
  readonly emitServerRequestOnTurn?: {
    readonly id?: number;
    readonly method: string;
    readonly params?: Record<string, unknown>;
  };
  readonly onPrompt?: (prompt: string) => void;
  readonly onRequest?: (request: FakeAppServerRequest) => void;
  readonly onResponse?: (response: FakeAppServerResponse) => void;
};

export type FakeAppServerRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

export type FakeAppServerResponse = {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
};

export class FakeAppServerFactory {
  spawnCount = 0;
  readonly codexHomes: string[] = [];
  readonly cwds: string[] = [];
  readonly prompts: string[] = [];
  readonly requests: FakeAppServerRequest[] = [];
  readonly responses: FakeAppServerResponse[] = [];
  readonly processes: FakeAppServerProcess[] = [];

  constructor(private readonly options: FakeAppServerFactoryOptions = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
  }) => {
    this.spawnCount += 1;
    this.codexHomes.push(input.env.CODEX_HOME ?? "");
    this.cwds.push(input.cwd);
    const process = new FakeAppServerProcess({
      ...this.options,
      onPrompt: (prompt) => this.prompts.push(prompt),
      onRequest: (request) => {
        this.requests.push(request);
        this.options.onRequest?.(request);
      },
      onResponse: (response) => {
        this.responses.push(response);
        this.options.onResponse?.(response);
      },
    });
    this.processes.push(process);
    return process;
  };
}

export class FakeAppServerProcess extends EventEmitter {
  readonly pid = undefined;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly signals: NodeJS.Signals[] = [];
  private readonly stdinEmitter = new EventEmitter();
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: () => {
      if (this.options.exitOnStdinEnd) {
        this.emitExit("SIGTERM");
      }
    },
    on: (event: "error", listener: (error: Error) => void) =>
      this.stdinEmitter.on(event, listener),
  };
  private nextThreadId = 1;
  private nextTurnId = 1;
  private threadStartCount = 0;
  private emittedTurnErrors = 0;
  private completedTurnCount = 0;
  private exited = false;
  private readonly goals = new Map<
    string,
    { objective: string; status: string }
  >();

  constructor(private readonly options: FakeAppServerFactoryOptions) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.options.ignoreSigterm) return true;
    queueMicrotask(() => this.emitExit(signal));
    return true;
  }

  isExited(): boolean {
    return this.exited;
  }

  private emitExit(signal: string): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", null, signal);
  }

  private handleRequest(chunk: string): void {
    if (
      this.options.throwOnUnsupportedServerResponse &&
      chunk.includes("unsupported_server_request")
    ) {
      throw new Error("fake app-server unsupported response write failed");
    }
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as FakeAppServerRequest;
      if (request.method === undefined && ("result" in request || "error" in request)) {
        this.options.onResponse?.(request as FakeAppServerResponse);
        continue;
      }
      if (request.method === this.options.throwOnRequestMethod) {
        throw new Error("fake app-server stdin write failed");
      }
      this.options.onRequest?.(request);
      if (request.method === "initialize") {
        if (this.options.suppressInitializeResponse) continue;
        if (this.options.initializeError) {
          this.respondError(request.id, this.options.initializeError);
          continue;
        }
        this.respond(request.id, {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
        });
        continue;
      }
      if (request.method === "model/list") {
        this.respond(request.id, {
          data: (this.options.availableModels ?? []).map((entry) => ({
            id: entry.model,
            model: entry.model,
            displayName: entry.model,
            description: "Fake Codex model",
            hidden: entry.hidden ?? false,
            isDefault: entry.isDefault ?? false,
            supportedReasoningEfforts: (
              entry.supportedReasoningEfforts ?? []
            ).map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
          })),
          nextCursor: null,
        });
        continue;
      }
      if (request.method === "thread/start") {
        this.threadStartCount += 1;
        if (
          this.options.failThreadStart ||
          this.options.failThreadStartNumbers?.includes(this.threadStartCount)
        ) {
          this.respondError(
            request.id,
            this.options.threadStartError ?? "fake thread start failure",
          );
          continue;
        }
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        this.respond(request.id, {
          thread: { id: threadId },
          ...(this.options.omitThreadReceiptMetadata
            ? {}
            : {
                model: this.options.effectiveModel ?? request.params?.model,
                modelProvider: "openai",
                serviceTier: request.params?.serviceTier ?? null,
                reasoningEffort:
                  (request.params?.config as Record<string, unknown> | undefined)
                    ?.model_reasoning_effort,
              }),
        });
        continue;
      }
      if (request.method === "thread/fork") {
        if (this.options.suppressThreadForkResponse) continue;
        if (this.options.threadForkError) {
          this.respondError(request.id, this.options.threadForkError);
          continue;
        }
        const threadId = `thread-${this.nextThreadId}`;
        this.nextThreadId += 1;
        this.respond(request.id, {
          thread: { id: threadId },
        });
        continue;
      }
      if (request.method === "thread/goal/set") {
        const threadId = String(request.params?.threadId ?? "");
        const objective = String(request.params?.objective ?? "");
        const status = String(request.params?.status ?? "active");
        this.goals.set(threadId, { objective, status });
        this.respond(request.id, {
          goal: {
            threadId,
            objective,
            status,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        });
        continue;
      }
      if (request.method === "thread/goal/get") {
        const threadId = String(request.params?.threadId ?? "");
        const goal = this.goals.get(threadId);
        this.respond(request.id, {
          goal: goal
            ? {
                threadId,
                objective: goal.objective,
                status: goal.status,
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 0,
                updatedAt: 0,
              }
            : null,
        });
        continue;
      }
      if (request.method === "turn/start") {
        const turnNumber = this.nextTurnId;
        const generatedTurnId = `turn-${turnNumber}`;
        const turnId = this.options.reuseActualTurnId ?? generatedTurnId;
        this.nextTurnId += 1;
        const prompt = extractFakePrompt(request.params);
        this.options.onPrompt?.(prompt);
        const responseTurnId = this.options.mismatchTurnStartResponseId
          ? `response-${generatedTurnId}`
          : turnId;
        if (this.options.emitTurnEventsWithStartResponse) {
          this.stdout.emit(
            "data",
            [
              JSON.stringify({
                id: request.id,
                result: { turn: { id: responseTurnId } },
              }),
              JSON.stringify({
                method: "turn/started",
                params: {
                  threadId: String(request.params?.threadId ?? ""),
                  turn: { id: turnId, status: "inProgress" },
                },
              }),
              JSON.stringify({
                method: "item/agentMessage/delta",
                params: {
                  turnId,
                  delta: `app-server output:${prompt}`,
                },
              }),
              ...(this.options.turnUsage
                ? [JSON.stringify({
                    method: "thread/tokenUsage/updated",
                    params: {
                      threadId: String(request.params?.threadId ?? ""),
                      turnId,
                      tokenUsage: this.threadTokenUsage(this.options.turnUsage),
                    },
                  })]
                : []),
              JSON.stringify({
                method: "turn/completed",
                params: {
                  turn: this.completedTurn(turnId),
                },
              }),
            ].join("\n") + "\n",
          );
          continue;
        }
        this.respond(request.id, {
          turn: {
            id: responseTurnId,
          },
        });
        if (this.options.emitStdinErrorAfterTurnStartResponse) {
          this.stdinEmitter.emit(
            "error",
            new Error("fake app-server stdin stream failed"),
          );
          continue;
        }
        if (this.options.emitUnsupportedServerRequestOnTurn) {
          this.stdout.emit(
            "data",
            `${JSON.stringify({
              id: 9_001,
              method: "client/unsupported",
              params: { turnId },
            })}\n`,
          );
          continue;
        }
        if (this.options.emitProcessErrorAfterTurnStartResponse) {
          this.emit("error", new Error("fake app-server process failed"));
          continue;
        }
        if (this.options.emitServerRequestOnTurn) {
          this.stdout.emit(
            "data",
            `${JSON.stringify({
              id: this.options.emitServerRequestOnTurn.id ?? 9_002,
              method: this.options.emitServerRequestOnTurn.method,
              params: this.options.emitServerRequestOnTurn.params ?? {},
            })}\n`,
          );
        }
        setTimeout(() => {
          if (this.options.emitModelRerouted) {
            this.notify("model/rerouted", {
              threadId: String(request.params?.threadId ?? ""),
              turnId,
              fromModel: request.params?.model,
              toModel: "gpt-rerouted",
              reason: "safety",
            });
          }
          if (this.options.emitTurnCompletionBeforeStarted) {
            this.notify("item/agentMessage/delta", {
              turnId,
              delta: `app-server output:${prompt}`,
            });
            this.notify("turn/completed", {
              turn: this.completedTurn(turnId),
            });
            this.notify("turn/started", {
              threadId: String(request.params?.threadId ?? ""),
              turn: { id: turnId, status: "inProgress" },
            });
            return;
          }
          this.notify("turn/started", {
            threadId: String(request.params?.threadId ?? ""),
            turn: { id: turnId, status: "inProgress" },
          });
          if (this.options.emitTransientTopLevelErrorOnTurn) {
            this.stdout.emit(
              "data",
              `${JSON.stringify({
                method: "error",
                message: this.options.emitTransientTopLevelErrorOnTurn,
              })}\n`,
            );
          }
          const topLevelError = this.configuredTurnError();
          if (topLevelError) {
            this.stdout.emit(
              "data",
              `${JSON.stringify({
                method: "error",
                message: topLevelError,
              })}\n`,
            );
            return;
          }
          if (this.options.emitCodexErrorOnTurn) {
            this.notify("error", {
              turnId,
              error: this.options.emitCodexErrorOnTurn,
            });
            return;
          }
          if (this.options.emitProcessErrorOnTurn) {
            this.emit("error", new Error("fake app-server process failed"));
            return;
          }
          if (this.options.abortTurnNumbers?.includes(turnNumber)) {
            this.notify("turn/aborted", {
              turnId,
              reason: this.options.abortTurnReason ?? "aborted",
            });
            return;
          }
          this.markGoalAfterCompletedTurn(String(request.params?.threadId ?? ""));
          if (!this.options.suppressOutputTurnNumbers?.includes(turnNumber)) {
            if (this.options.completedAgentMessageContentOnly) {
              this.notify("item/completed", {
                turnId,
                item: {
                  type: "agentMessage",
                  content: [
                    {
                      type: "output_text",
                      text: `app-server output:${prompt}`,
                    },
                    ...(this.options.appendCompletedAgentMessageToolContent
                      ? [
                          {
                            type: "tool_output",
                            content: "wrong app-server output",
                          },
                          {
                            type: "message",
                            role: "user",
                            content: JSON.stringify({ verdict: "REJECT" }),
                          },
                        ]
                      : []),
                  ],
                },
              });
            } else {
              this.notify("item/agentMessage/delta", {
                turnId,
                delta: `app-server output:${prompt}`,
              });
            }
          }
          const completedTurnId = this.options.wrongTurnCompletionId ?? turnId;
          const usageUpdates = this.options.tokenUsageUpdates ??
            (this.options.turnUsage ? [this.options.turnUsage] : []);
          if (usageUpdates.length > 0 && !this.options.suppressTokenUsage) {
            const usageParams = {
              threadId: this.options.wrongTokenUsageThreadId ??
                String(request.params?.threadId ?? ""),
              turnId: this.options.wrongTokenUsageTurnId ?? turnId,
              tokenUsage: this.threadTokenUsage(usageUpdates[0] ?? {}),
            };
            for (const usage of usageUpdates) {
              this.notify("thread/tokenUsage/updated", {
                ...usageParams,
                tokenUsage: this.threadTokenUsage(usage),
              });
            }
            if (this.options.duplicateTokenUsage) {
              this.notify("thread/tokenUsage/updated", usageParams);
            }
          }
          if (!this.options.suppressTurnCompletion) {
            this.notify("turn/completed", {
              turn: this.completedTurn(completedTurnId),
            });
            if (this.options.duplicateTurnCompletion) {
              this.notify("turn/completed", {
                turn: this.completedTurn(turnId),
              });
            }
            if (this.options.lateDuplicateTurnCompletion) {
              setTimeout(() => this.notify("turn/completed", {
                turn: this.completedTurn(turnId),
              }), 0);
            }
            if (this.options.postTerminalTokenUsage) {
              setTimeout(() => this.notify("thread/tokenUsage/updated", {
                threadId: String(request.params?.threadId ?? ""),
                turnId,
                tokenUsage: this.threadTokenUsage(this.options.turnUsage ?? {}),
              }), 0);
            }
            if (this.options.postTerminalAgentMessageDelta) {
              setTimeout(() => this.notify("item/agentMessage/delta", {
                turnId,
                delta: "late output",
              }), 0);
            }
          }
        }, 5);
        continue;
      }
      this.respondError(request.id, `unsupported:${request.method}`);
    }
  }

  private configuredTurnError(): string | null {
    const sequence = this.options.emitTopLevelErrorsOnTurns;
    if (sequence) {
      const value = sequence[this.emittedTurnErrors];
      this.emittedTurnErrors += 1;
      return value ?? null;
    }
    return this.options.emitTopLevelErrorOnTurn ?? null;
  }

  private completedTurn(turnId: string): Record<string, unknown> {
    if (this.options.completeTurnWithError) {
      return {
        id: turnId,
        status: "failed",
        error: this.options.completeTurnWithError,
      };
    }
    return {
      id: turnId,
      status: "completed",
    };
  }

  private threadTokenUsage(usage: Record<string, unknown>): Record<string, unknown> {
    const breakdown = {
      inputTokens: usage.inputTokens ?? usage.input_tokens,
      cachedInputTokens: usage.cachedInputTokens ?? usage.cached_input_tokens,
      outputTokens: usage.outputTokens ?? usage.output_tokens,
      reasoningOutputTokens:
        usage.reasoningOutputTokens ?? usage.reasoning_output_tokens,
      totalTokens: usage.totalTokens ?? usage.total_tokens,
    };
    return { last: breakdown, total: breakdown, modelContextWindow: 200_000 };
  }

  private markGoalAfterCompletedTurn(threadId: string): void {
    const goal = this.goals.get(threadId);
    if (!goal) return;
    const nextStatus =
      this.options.goalStatusesAfterTurns?.[this.completedTurnCount] ??
      "complete";
    this.completedTurnCount += 1;
    this.goals.set(threadId, {
      ...goal,
      status: nextStatus,
    });
    this.notify("thread/goal/updated", {
      threadId,
      turnId: null,
      goal: {
        threadId,
        objective: goal.objective,
        status: nextStatus,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    });
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.emit("data", `${JSON.stringify({ id, error: { message } })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

export function extractFakePrompt(
  params: Record<string, unknown> | undefined,
): string {
  const input = params?.input;
  if (!Array.isArray(input)) return "";
  const first = input[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}
