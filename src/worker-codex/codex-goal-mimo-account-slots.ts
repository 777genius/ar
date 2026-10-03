import { codexMimoApiKeyEnvVarDefault } from "@vioxen/subscription-runtime/provider-codex";

export type CodexGoalMimoAccountSlot = {
  readonly name: string;
  readonly envVarName?: string;
};

export function resolveCodexGoalMimoEnvVarName(
  account: { readonly name: string; readonly envVarName?: string },
  mimoAccountsByName: ReadonlyMap<string, CodexGoalMimoAccountSlot>,
): string {
  return account.envVarName ??
    mimoAccountsByName.get(account.name)?.envVarName ??
    codexMimoApiKeyEnvVarDefault;
}

export function optionalCodexGoalMimoAccountSlots(
  value: unknown,
  fieldName = "mimoAccounts",
): { readonly mimoAccounts?: readonly CodexGoalMimoAccountSlot[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return {
    mimoAccounts: value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${fieldName} entries must be objects`);
      }
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!name) throw new Error(`${fieldName}.name is required`);
      if (record.envVarName === undefined) return { name };
      const envVarName =
        typeof record.envVarName === "string" ? record.envVarName.trim() : "";
      if (!envVarName) throw new Error(`${fieldName}.envVarName must be non-empty`);
      return { name, envVarName };
    }),
  };
}
