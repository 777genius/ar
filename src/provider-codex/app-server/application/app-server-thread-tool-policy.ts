import type { CodexAppServerNativeToolSurface } from "../domain/app-server-types";

export function appServerThreadToolPolicy(input: {
  readonly disableTools: boolean;
  readonly nativeToolSurface: CodexAppServerNativeToolSurface | undefined;
  readonly goalMode: boolean | undefined;
}): { readonly disableTools: boolean; readonly disableNativeEnvironments: boolean } {
  const disableTools = input.disableTools && input.goalMode !== true;
  return {
    disableTools,
    disableNativeEnvironments:
      input.nativeToolSurface === "disabled" && (input.goalMode === true || !disableTools),
  };
}
