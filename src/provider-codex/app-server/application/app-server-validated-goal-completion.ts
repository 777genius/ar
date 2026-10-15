import { AppServerOutputValidationError, AppServerOutputValidationStage, AppServerOutputValidationCode } from "./app-server-output-validation-error";
import type { CodexAppServerClient } from "./app-server-client";
import type { CodexThreadGoal } from "../domain/app-server-types";

/** Trusted host acceptance of normalized output; never serialized task controls. */
export type AppServerCompletedGoalOutputValidator = (
  output: unknown,
  context: { readonly runId: string; readonly turnNumber: number },
) => boolean | Promise<boolean>;

export type AppServerGoalTurnOutputValidator = (
  outputText: string,
  context: { readonly runId: string; readonly turnNumber: number },
) => Promise<void>;

/** Complete only the same active native Goal after host acceptance of this turn. */
export async function completeValidatedNativeGoal(input: {
  readonly client: Pick<CodexAppServerClient, "getGoal" | "setGoal" | "assertExecutionActive">;
  readonly goal: CodexThreadGoal;
  readonly threadId: string;
  readonly objective: string;
  readonly runId: string;
  readonly turnNumber: number;
  readonly outputText: string;
  readonly timeoutMs: number;
  readonly abortSignal: AbortSignal;
  readonly validate: AppServerGoalTurnOutputValidator;
}): Promise<CodexThreadGoal> {
  const sameGoal = (goal: CodexThreadGoal | null): goal is CodexThreadGoal =>
    goal !== null && goal.threadId === input.threadId && goal.objective === input.objective;
  if (!sameGoal(input.goal)) throw new Error("codex_goal_completion_identity_conflict");
  if (input.goal.status !== "active" && input.goal.status !== "complete") return input.goal;
  input.client.assertExecutionActive(input.abortSignal);
  try {
    await input.validate(input.outputText, { runId: input.runId, turnNumber: input.turnNumber });
  } catch (cause) {
    if (cause instanceof AppServerOutputValidationError) throw cause;
    throw new AppServerOutputValidationError(AppServerOutputValidationStage.Unknown,
      AppServerOutputValidationCode.Unknown);
  }
  input.client.assertExecutionActive(input.abortSignal);
  const request = { threadId: input.threadId, timeoutMs: input.timeoutMs, abortSignal: input.abortSignal };
  const current = await input.client.getGoal(request);
  input.client.assertExecutionActive(input.abortSignal);
  if (!sameGoal(current)) throw new Error("codex_goal_completion_identity_conflict");
  if (current.status === "complete") return current;
  // A host validator may await external acceptance. Never overwrite a pause or blocker.
  if (current.status !== "active") throw new Error("codex_goal_completion_status_changed");
  input.client.assertExecutionActive(input.abortSignal);
  const completed = await input.client.setGoal({ ...request, objective: input.objective, status: "complete" });
  if (!sameGoal(completed) || completed.status !== "complete") {
    throw new Error("codex_goal_completion_not_confirmed");
  }
  input.client.assertExecutionActive(input.abortSignal);
  const confirmed = await input.client.getGoal(request);
  input.client.assertExecutionActive(input.abortSignal);
  if (!sameGoal(confirmed) || confirmed.status !== "complete") {
    throw new Error("codex_goal_completion_not_confirmed");
  }
  return confirmed;
}
