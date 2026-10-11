import { HostedMimoProfile } from "../../hosted-mimo-profile";
import type { CodexAppServerNativeToolSurface } from "./app-server-types";

export function codexAppServerToolConfig(input: {
  readonly nativeToolSurface: CodexAppServerNativeToolSurface | undefined;
  readonly fastMode: boolean;
  readonly goalMode: boolean;
  readonly trustedHooksEnabled: boolean;
}): Readonly<Record<string, unknown>> {
  // Pure rendering only: engine and thread boundaries own admission.
  if (input.nativeToolSurface === HostedMimoProfile.CodingV1) {
    if (input.goalMode || input.trustedHooksEnabled) throw new Error("hosted_mimo_coding_engine_profile_invalid");
    return { features: { apps: false, hooks: false, memories: false, multi_agent: false, shell_snapshot: false,
      skill_mcp_dependency_install: false, shell_tool: true, unified_exec: true, goals: false, default_mode_request_user_input: false },
      tools: { view_image: false, experimental_request_user_input: { enabled: false } } };
  }
  const nativeToolsDisabled = input.nativeToolSurface === "disabled";
  return {
    features: {
      apps: false,
      hooks: input.trustedHooksEnabled,
      memories: false,
      multi_agent: false,
      shell_snapshot: false,
      skill_mcp_dependency_install: false,
      ...(nativeToolsDisabled ? { shell_tool: false, unified_exec: false } : {}),
      ...(input.fastMode ? { fast_mode: true } : {}),
      // External GoalAPI works on persistent threads without exposing native
      // goal or request-input tools to the model.
      ...(nativeToolsDisabled
        ? { goals: false, default_mode_request_user_input: false }
        : input.goalMode
          ? { goals: true }
          : {}),
    },
    ...(nativeToolsDisabled
      ? { tools: { view_image: false, experimental_request_user_input: { enabled: false } } }
      : {}),
  };
}
