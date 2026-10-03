import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";

export function uniqueManifestStrings(
  values: readonly string[],
): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function assertJobId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error("codex_goal_job_id_invalid");
  }
}

export function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`codex_goal_job_${field}_required`);
  return text;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function requiredIsoDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`codex_goal_job_${field}_invalid`);
  }
  return text;
}

export function readStringArray(
  value: unknown,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`codex_goal_job_${field}_invalid`);
  return value.map((item) => requiredString(item, field));
}

export function optionalPositiveIntegerProperty(
  value: unknown,
  key:
    | "taskTimeoutMs"
    | "appServerStartupTimeoutMs"
    | "staleLockMs"
    | "maxAccountCycles"
    | "progressHeartbeatMs",
): Partial<Pick<CodexGoalJobManifest, typeof key>> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`codex_goal_job_${key}_invalid`);
  }
  return { [key]: value } as Partial<Pick<CodexGoalJobManifest, typeof key>>;
}

export function optionalBooleanProperty(
  value: unknown,
  key:
    | "allowDuplicateAccountIdentities"
    | "allowDangerFullAccess"
    | "requireGitWorkspace"
    | "prewarmOnStart",
): Partial<Pick<CodexGoalJobManifest, typeof key>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error(`codex_goal_job_${key}_invalid`);
  }
  return { [key]: value } as Partial<Pick<CodexGoalJobManifest, typeof key>>;
}

export function optionalWorkerReportMode(
  value: unknown,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("codex_goal_job_workerReportMode_invalid");
}

export function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
