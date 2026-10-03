import { AppServerUsageError } from "./app-server-usage-error";
import { randomUUID } from "node:crypto";
import type {
  AgentUsage,
  ManagedRunInputRequest,
} from "@vioxen/subscription-runtime/core";
import {
  appServerGoalObjectiveMaxChars,
  type CodexThreadGoal,
} from "./app-server-types";

export function normalizeRunId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : `codex-managed-run-${randomUUID()}`;
}

export function buildGoalResumePrompt(input: {
  readonly requestId: string;
  readonly answer: string;
  readonly goalContinuePrompt: string;
}): string {
  const answer = input.answer.trim() || "(empty answer)";
  return [
    `Additional information for pending request ${input.requestId}:`,
    answer,
    "",
    input.goalContinuePrompt,
  ].join("\n");
}

export function goalInputRequest(input: {
  readonly runId: string;
  readonly goal: CodexThreadGoal;
  readonly outputText: string;
}): ManagedRunInputRequest {
  const question =
    input.outputText.trim() ||
    `Codex goal is ${input.goal.status} and needs input before it can continue.`;
  return {
    id: `managed-input-${randomUUID()}`,
    kind: input.goal.status === "paused" ? "decision_required" : "missing_context",
    question,
    contextSummary: `Goal: ${input.goal.objective}\nStatus: ${input.goal.status}`,
    audience: "orchestrator",
  };
}

export function goalMaxTurnsExceededError(input: {
  readonly maxGoalTurns: number;
  readonly outputText: string;
  readonly usage?: AgentUsage;
}): AppServerGoalMaxTurnsExceededError {
  return new AppServerGoalMaxTurnsExceededError(input);
}

export class AppServerGoalMaxTurnsExceededError extends AppServerUsageError {
  readonly lastOutputText?: string;

  constructor(input: {
    readonly maxGoalTurns: number;
    readonly outputText: string;
    readonly usage?: AgentUsage;
  }) {
    super(new Error(`codex_app_server_goal_max_turns_exceeded:${input.maxGoalTurns}`), input.usage);
    this.name = "AppServerGoalMaxTurnsExceededError";
    const outputText = input.outputText.trim();
    if (outputText) this.lastOutputText = outputText;
  }
}

export function formatGoalSetError(
  message: string | undefined,
  objective: string,
): string {
  if (
    message &&
    /goal objective must be at most 4000 characters/i.test(message)
  ) {
    return appServerGoalObjectiveLimitError(objective) ?? message;
  }
  return message ?? "unknown";
}

export function appServerGoalObjectiveLimitError(
  objective: string,
): string | null {
  const length = objective.length;
  if (length <= appServerGoalObjectiveMaxChars) return null;
  return `Prompt too long: ${length}/${appServerGoalObjectiveMaxChars} chars. Use compact prompt with docs links.`;
}
