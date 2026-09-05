const generatedGoalTaskIdMaxLength = 160;
const generatedGoalSummaryMaxLength = 600;

export function resolveCodexGoalObjective(input: {
  readonly codexGoalObjective?: string;
  readonly goalSummary?: string;
  readonly taskId: string;
}): string {
  if (input.codexGoalObjective !== undefined) {
    return input.codexGoalObjective;
  }
  const taskId = boundedGoalLabel(input.taskId, generatedGoalTaskIdMaxLength);
  const summary = boundedGoalLabel(
    input.goalSummary,
    generatedGoalSummaryMaxLength,
  );
  const task = taskId === undefined ? "the assigned task" : `task ${taskId}`;
  const description = summary === undefined ? "" : `: ${summary}`;
  return [
    `Complete ${task}${description}.`,
    "Follow the full instructions and acceptance criteria in the initial user message.",
  ].join(" ");
}

function boundedGoalLabel(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > maxLength) return undefined;
  return normalized;
}
