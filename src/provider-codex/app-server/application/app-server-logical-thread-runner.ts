import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexLogicalThreadExecutionResult,
} from "../../codex-json-execution-engine";
import { codexOutputSchemaPayload } from "../../codex-json-execution-engine";
import type {
  AppServerRunResult,
  AppServerWarning,
} from "../domain/app-server-types";
import { appServerOutputSchemaNotNativeWarning } from "../domain/app-server-errors";
import type { AppServerGoalRunner } from "./app-server-goal-runner";

type LogicalThreadInput = CodexExecutionInput & {
  readonly previousCheckpoint?: string;
};

export async function runCodexAppServerLogicalThread(
  input: LogicalThreadInput,
  deps: {
    readonly goalMode: boolean;
    readonly timeoutMs: number;
    readonly maxGoalTurns: number;
    readonly goalContinuePrompt: string;
    runGoal(
      input: Parameters<AppServerGoalRunner["runLogicalThreadGoal"]>[0],
    ): ReturnType<AppServerGoalRunner["runLogicalThreadGoal"]>;
    redact(
      result: AppServerRunResult,
      schemaWarnings: readonly AppServerWarning[],
    ): CodexExecutionResult;
    parse(
      result: CodexExecutionResult,
      input: LogicalThreadInput,
    ): Promise<CodexExecutionResult>;
    disposeSession(): Promise<void>;
  },
): Promise<CodexLogicalThreadExecutionResult> {
  if (!deps.goalMode) {
    throw new Error("codex_app_server_logical_thread_requires_goal_mode");
  }
  try {
    const outputSchema = codexOutputSchemaPayload(input.outputSchema);
    const schemaWarnings = input.outputSchema && outputSchema === undefined
      ? [appServerOutputSchemaNotNativeWarning()]
      : [];
    const result = await deps.runGoal({
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      prompt: input.prompt,
      ...(input.goalObjective === undefined
        ? {}
        : { goalObjective: input.goalObjective }),
      ...(input.systemPrompt === undefined
        ? {}
        : { systemPrompt: input.systemPrompt }),
      ...(input.previousCheckpoint === undefined
        ? {}
        : { previousCheckpoint: input.previousCheckpoint }),
      workspacePath: input.workspacePath,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.serviceTier === undefined
        ? {}
        : { serviceTier: input.serviceTier }),
      sandboxMode: input.sandboxMode ?? "read-only",
      ...(outputSchema === undefined ? {} : { outputSchema }),
      timeoutMs: deps.timeoutMs,
      abortSignal: input.abortSignal,
      maxGoalTurns: deps.maxGoalTurns,
      goalContinuePrompt: deps.goalContinuePrompt,
    });
    const redacted = deps.redact(result, schemaWarnings);
    if (redacted.status === "waiting_for_input") {
      throw new Error("codex_logical_thread_goal_waiting_for_input_invalid");
    }
    const parsed = await deps.parse(redacted, input);
    if (parsed.status === "waiting_for_input") {
      throw new Error("codex_logical_thread_goal_waiting_for_input_invalid");
    }
    return {
      ...parsed,
      providerCheckpoint: result.providerCheckpoint,
      outcome: result.outcome,
    };
  } catch (error) {
    await deps.disposeSession();
    throw error;
  }
}
