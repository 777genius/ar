import type { ProviderTaskControls } from "@777genius/subscription-runtime/core";

export type CodexGoalEditMode = NonNullable<ProviderTaskControls["editMode"]>;
export type CodexGoalProviderSandboxMode = NonNullable<
  ProviderTaskControls["providerSandboxMode"]
>;

export const codexGoalEditModes = [
  "read-only",
  "allow-edits",
] as const satisfies readonly CodexGoalEditMode[];

export const codexGoalProviderSandboxModes = [
  "workspace-write",
  "danger-full-access",
] as const satisfies readonly CodexGoalProviderSandboxMode[];

const codexGoalEditModeSet = new Set<string>(codexGoalEditModes);
const codexGoalProviderSandboxModeSet = new Set<string>(
  codexGoalProviderSandboxModes,
);

export function parseCodexGoalEditMode(
  value: string,
  fieldName = "editMode",
): CodexGoalEditMode {
  if (codexGoalEditModeSet.has(value)) return value as CodexGoalEditMode;
  throw new Error(codexGoalEditModeError(value, fieldName));
}

export function optionalCodexGoalEditMode(
  value: string | undefined,
  fieldName = "editMode",
): CodexGoalEditMode | undefined {
  return value === undefined ? undefined : parseCodexGoalEditMode(value, fieldName);
}

export function parseCodexGoalProviderSandboxMode(
  value: string,
  fieldName = "providerSandboxMode",
): CodexGoalProviderSandboxMode {
  if (codexGoalProviderSandboxModeSet.has(value)) {
    return value as CodexGoalProviderSandboxMode;
  }
  throw new Error(codexGoalProviderSandboxModeError(value, fieldName));
}

export function optionalCodexGoalProviderSandboxMode(
  value: string | undefined,
  fieldName = "providerSandboxMode",
): CodexGoalProviderSandboxMode | undefined {
  return value === undefined
    ? undefined
    : parseCodexGoalProviderSandboxMode(value, fieldName);
}

export function assertCodexGoalProviderSandboxModeAllowed(input: {
  readonly editMode: CodexGoalEditMode | undefined;
  readonly providerSandboxMode: CodexGoalProviderSandboxMode | undefined;
  readonly fieldName?: string;
}): void {
  if (
    input.providerSandboxMode === undefined ||
    input.editMode === "allow-edits"
  ) {
    return;
  }
  throw new Error(
    `${input.fieldName ?? "providerSandboxMode"} requires editMode "allow-edits"`,
  );
}

export function codexGoalEditModeError(
  value: string,
  fieldName = "editMode",
): string {
  const supported = codexGoalEditModes.join(", ");
  const hint = value === "danger-full-access"
    ? " Use providerSandboxMode for low-level provider sandbox access."
    : "";
  return `codex_goal_edit_mode_invalid: ${fieldName} ${JSON.stringify(value)} is unsupported.${hint} Supported values: ${supported}.`;
}

export function codexGoalProviderSandboxModeError(
  value: string,
  fieldName = "providerSandboxMode",
): string {
  const supported = codexGoalProviderSandboxModes.join(", ");
  return `codex_goal_provider_sandbox_mode_invalid: ${fieldName} ${JSON.stringify(value)} is unsupported. Supported values: ${supported}.`;
}
