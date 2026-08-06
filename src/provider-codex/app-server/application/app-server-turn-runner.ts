import type { AgentUsage } from "@vioxen/subscription-runtime/core";
import type {
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";
import {
  cleanThreadPrewarmWarning,
} from "../domain/app-server-errors";
import {
  normalizeSystemPrompt,
  type AppServerWarning,
  type AppServerThreadExecutionReceipt,
  type PreparedThread,
} from "../domain/app-server-types";
import type { CodexAppServerClient } from "./app-server-client";

export class AppServerTurnRunner {
  private preparedThread: PreparedThread | null = null;
  private prepareThreadInFlight: Promise<void> | null = null;

  constructor(
    private readonly options: {
      readonly client: CodexAppServerClient;
      readonly cleanThreadPrewarm: boolean;
    },
  ) {}

  async runCleanTurn(input: {
    readonly prompt: string;
    readonly systemPrompt?: string;
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode: CodexSandboxMode;
    readonly outputSchema?: unknown;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
    readonly prepareNext?: boolean;
    readonly onTextDelta?: (text: string) => void;
  }): Promise<{
    readonly status?: "completed";
    readonly outputText: string;
    readonly usage?: AgentUsage;
    readonly executionReceipt: {
      readonly threadId: string;
      readonly turnId: string;
      readonly model: string;
      readonly modelProvider: string;
      readonly reasoningEffort: CodexReasoningEffort;
      readonly serviceTier?: CodexServiceTier;
    };
    readonly warnings: readonly AppServerWarning[];
  }> {
    const warnings = this.options.client.drainWarnings();
    const preparedThread = this.takePreparedThread(input);
    let emittedText = false;
    const onTextDelta = input.onTextDelta === undefined
      ? undefined
      : (text: string): void => {
          emittedText = true;
          input.onTextDelta?.(text);
        };
    let threadReceipt = preparedThread === null
      ? await this.options.client.startThreadWithReceipt(input)
      : threadReceiptFromPrepared(preparedThread);
    assertEffectiveThreadSelection(threadReceipt, input);
    const turn = await this.options.client.startTurn({
      ...input,
      ...(onTextDelta === undefined ? {} : { onTextDelta }),
      threadId: threadReceipt.threadId,
    }).catch(
      async (error: unknown) => {
        if (!preparedThread || emittedText) throw error;
        warnings.push({
          code: "codex_app_server_prepared_thread_failed",
          safeMessage:
            "Codex app-server prepared thread failed; retried with a fresh thread.",
        });
        const retryReceipt = await this.options.client.startThreadWithReceipt(input);
        assertEffectiveThreadSelection(retryReceipt, input);
        threadReceipt = retryReceipt;
        return await this.options.client.startTurn({
          ...input,
          ...(onTextDelta === undefined ? {} : { onTextDelta }),
          threadId: retryReceipt.threadId,
        });
      },
    );
    if (turn.error) throw turn.error;
    if (!turn.outputText.trim()) {
      throw new Error("codex_app_server_final_message_missing");
    }
    if (input.prepareNext ?? true) {
      this.prepareCleanThreadBestEffort(input);
    }
    warnings.push(...this.options.client.drainWarnings());
    return {
      outputText: turn.outputText,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      executionReceipt: {
        ...threadReceipt,
        turnId: turn.turnId,
      },
      warnings,
    };
  }

  async prewarmCleanThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<readonly AppServerWarning[]> {
    if (!this.cleanThreadPrewarmEnabled()) return [];
    try {
      await this.prepareCleanThreadNow(input);
      return this.options.client.drainWarnings();
    } catch (error) {
      return [cleanThreadPrewarmWarning(error)];
    }
  }

  private takePreparedThread(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
  }): PreparedThread | null {
    const prepared = this.preparedThread;
    if (!prepared) return null;
    this.preparedThread = null;
    if (
      prepared.workspacePath !== input.workspacePath ||
      prepared.model !== input.model ||
      prepared.reasoningEffort !== input.reasoningEffort ||
      prepared.serviceTier !== input.serviceTier ||
      prepared.sandboxMode !== (input.sandboxMode ?? "read-only") ||
      prepared.systemPrompt !== normalizeSystemPrompt(input.systemPrompt)
    ) {
      this.options.client.pushBackgroundWarning({
        code: "codex_app_server_prepared_thread_discarded",
        safeMessage:
          "Codex app-server discarded a prepared thread because the next task used a different runtime context.",
      });
      return null;
    }
    return prepared;
  }

  private prepareCleanThreadBestEffort(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): void {
    if (!this.cleanThreadPrewarmEnabled() || input.abortSignal.aborted) return;
    void this.prepareCleanThreadNow(input).catch((error: unknown) => {
      this.options.client.pushBackgroundWarning(cleanThreadPrewarmWarning(error));
    });
  }

  private async prepareCleanThreadNow(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
    readonly timeoutMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<void> {
    if (!this.cleanThreadPrewarmEnabled()) return;
    if (this.preparedThread && this.preparedThreadMatches(input)) return;
    if (this.prepareThreadInFlight) return await this.prepareThreadInFlight;

    this.prepareThreadInFlight = this.options.client.startThreadWithReceipt(input)
      .then((receipt) => {
        assertEffectiveThreadSelection(receipt, input);
        this.preparedThread = {
          threadId: receipt.threadId,
          workspacePath: input.workspacePath,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          ...(input.serviceTier === undefined
            ? {}
            : { serviceTier: input.serviceTier }),
          sandboxMode: input.sandboxMode ?? "read-only",
          systemPrompt: normalizeSystemPrompt(input.systemPrompt),
          modelProvider: receipt.modelProvider,
        };
      })
      .finally(() => {
        this.prepareThreadInFlight = null;
      });
    await this.prepareThreadInFlight;
  }

  private preparedThreadMatches(input: {
    readonly workspacePath: string;
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
    readonly systemPrompt?: string;
  }): boolean {
    return (
      this.preparedThread?.workspacePath === input.workspacePath &&
      this.preparedThread.model === input.model &&
      this.preparedThread.reasoningEffort === input.reasoningEffort &&
      this.preparedThread.serviceTier === input.serviceTier &&
      this.preparedThread.sandboxMode === (input.sandboxMode ?? "read-only") &&
      this.preparedThread.systemPrompt === normalizeSystemPrompt(input.systemPrompt)
    );
  }

  private cleanThreadPrewarmEnabled(): boolean {
    return this.options.cleanThreadPrewarm;
  }
}

function threadReceiptFromPrepared(
  prepared: PreparedThread,
): AppServerThreadExecutionReceipt {
  return {
    threadId: prepared.threadId,
    model: prepared.model,
    modelProvider: prepared.modelProvider,
    reasoningEffort: prepared.reasoningEffort,
    ...(prepared.serviceTier === undefined
      ? {}
      : { serviceTier: prepared.serviceTier }),
  };
}

function assertEffectiveThreadSelection(
  receipt: AppServerThreadExecutionReceipt,
  requested: {
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
  },
): void {
  if (
    receipt.model !== requested.model ||
    receipt.reasoningEffort !== requested.reasoningEffort ||
    receipt.serviceTier !== requested.serviceTier
  ) {
    throw new Error("codex_app_server_effective_selection_mismatch");
  }
}
