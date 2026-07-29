import {
  AgentRuntimeTool,
  type AgentRuntimeToolName,
} from "@vioxen/subscription-runtime/core";

const boundedWorkspaceTools = new Set<AgentRuntimeToolName>([
  AgentRuntimeTool.ReadFile,
  AgentRuntimeTool.EditFile,
  AgentRuntimeTool.WriteFile,
  AgentRuntimeTool.SearchFiles,
]);

export function isBoundedWorkspaceTool(
  tool: AgentRuntimeToolName,
): boolean {
  return boundedWorkspaceTools.has(tool);
}

export function normalizeBoundedWorkspaceTools(
  tools: readonly AgentRuntimeToolName[],
): readonly AgentRuntimeToolName[] {
  for (const tool of tools) {
    if (!isBoundedWorkspaceTool(tool)) {
      throw new Error(`workspace_tool_unsupported:${tool}`);
    }
  }
  return [...new Set(tools)].sort();
}
