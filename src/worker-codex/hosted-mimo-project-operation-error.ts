/** Public failure codes only. Diagnostic DATA never grants execution or release. */
export function hostedMimoProjectOperationErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":", 1)[0]! : "";
  return code === "mimo_project_runtime_routing_invalid" ||
    /^(?:mimo_project_bridge_|project_control_|hosted_research_|codex_goal_|owned_mimo_)[a-z0-9_]{1,100}$/.test(code)
    ? code : "mimo_project_bridge_operation_failed";
}
