import { childConfigFromRecord } from "./child-execution-confinement";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

type ExecutionConfig = Pick<CodexGoalRunConfig,
  "childLifetime" | "maxGoalTurns" | "safeExecutionPolicy">;

/** Ordinary launch metadata stays optional; child confinement keeps its stricter contract. */
export function goalExecutionConfigFromRecord(
  value: Readonly<Record<string, unknown>>,
): ExecutionConfig {
  if (value.childLifetime !== undefined) return childConfigFromRecord(value);
  const maxGoalTurns = optionalPositiveInteger(value.maxGoalTurns, "maxGoalTurns");
  const raw = value.safeExecutionPolicy;
  if (raw === undefined) return maxGoalTurns === undefined ? {} : { maxGoalTurns };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const policy = raw as Readonly<Record<string, unknown>>;
  const boolKeys = ["retryOnCapacity", "retryOnAccountUnavailable", "retryOnReconnectRequired",
    "retryUnknownCleanWorkspace", "retryUnknownChangedWorkspace"] as const;
  const allowed = new Set<string>([...boolKeys, "maxAttempts", "continuationMode"]);
  for (const key of Object.keys(policy)) if (!allowed.has(key)) invalid();
  const retryOnCapacity = optionalBoolean(policy.retryOnCapacity);
  const retryOnAccountUnavailable = optionalBoolean(policy.retryOnAccountUnavailable);
  const retryOnReconnectRequired = optionalBoolean(policy.retryOnReconnectRequired);
  const retryUnknownCleanWorkspace = optionalBoolean(policy.retryUnknownCleanWorkspace);
  const retryUnknownChangedWorkspace = optionalBoolean(policy.retryUnknownChangedWorkspace);
  const maxAttempts = optionalPositiveInteger(policy.maxAttempts, "maxAttempts");
  const continuationMode = policy.continuationMode;
  if (continuationMode !== undefined && continuationMode !== "disabled" &&
      continuationMode !== "packet_first") invalid();
  return {
    ...(maxGoalTurns === undefined ? {} : { maxGoalTurns }),
    safeExecutionPolicy: {
      ...(retryOnCapacity === undefined ? {} : { retryOnCapacity }),
      ...(retryOnAccountUnavailable === undefined ? {} : { retryOnAccountUnavailable }),
      ...(retryOnReconnectRequired === undefined ? {} : { retryOnReconnectRequired }),
      ...(retryUnknownCleanWorkspace === undefined ? {} : { retryUnknownCleanWorkspace }),
      ...(retryUnknownChangedWorkspace === undefined ? {} : { retryUnknownChangedWorkspace }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(continuationMode === undefined ? {} : { continuationMode }),
    },
  };
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`codex_goal_execution_${field}_invalid`);
  }
  return value;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid();
  return value;
}
function invalid(): never { throw new Error("codex_goal_execution_policy_invalid"); }
