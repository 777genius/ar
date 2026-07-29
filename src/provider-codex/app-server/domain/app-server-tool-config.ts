import type { CodexAppServerNativeToolSurface } from "./app-server-types";

export function codexAppServerToolConfig(input: {
  readonly nativeToolSurface: CodexAppServerNativeToolSurface | undefined;
  readonly fastMode: boolean;
  readonly goalMode: boolean;
}): Readonly<Record<string, unknown>> {
  const nativeToolsDisabled = input.nativeToolSurface === "disabled";
  return {
    features: {
      apps: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      shell_snapshot: false,
      skill_mcp_dependency_install: false,
      ...(nativeToolsDisabled ? { shell_tool: false, unified_exec: false } : {}),
      ...(input.fastMode ? { fast_mode: true } : {}),
      ...(input.goalMode ? { goals: true } : {}),
    },
    ...(nativeToolsDisabled ? { tools: { view_image: false } } : {}),
  };
}
