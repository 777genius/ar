import {
  AgentRuntimeTool,
  type ProviderTask,
  type ProviderTaskControls,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeTaskProvider,
  type ProviderName,
} from "./ports";

const claudeToolMap: ReadonlyMap<AgentRuntimeTool, readonly string[]> = new Map([
  [AgentRuntimeTool.ReadFile, ["Read"]],
  [AgentRuntimeTool.EditFile, ["Edit"]],
  [AgentRuntimeTool.WriteFile, ["Write"]],
  [AgentRuntimeTool.SearchFiles, ["Grep", "Glob"]],
  [AgentRuntimeTool.Shell, ["Bash"]],
  [AgentRuntimeTool.WebAccess, ["WebFetch", "WebSearch"]],
  [
    AgentRuntimeTool.DelegateAgent,
    [
      "Agent",
      "Task",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
    ],
  ],
  [AgentRuntimeTool.WorktreeControl, ["EnterWorktree", "ExitWorktree"]],
  [AgentRuntimeTool.NotebookEdit, ["NotebookEdit"]],
]);

export function mapProviderToolPolicy(
  provider: ProviderName,
  task: ProviderTask,
): ProviderTask {
  const controls = task.controls;
  if (!controls?.toolPolicy) return task;
  const mappedControls = mapProviderTaskControls(provider, controls);
  if (mappedControls === controls) return task;
  return {
    ...task,
    controls: mappedControls,
  };
}

function mapProviderTaskControls(
  provider: ProviderName,
  controls: ProviderTaskControls,
): ProviderTaskControls {
  const allowedTools =
    controls.allowedTools ??
    mapToolPolicy(provider, controls.toolPolicy?.allow, controls.toolPolicy?.allowProviderTools);
  const disallowedTools =
    controls.disallowedTools ??
    mapToolPolicy(provider, controls.toolPolicy?.deny, controls.toolPolicy?.denyProviderTools);

  return {
    ...controls,
    ...(allowedTools ? { allowedTools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
  };
}

function mapToolPolicy(
  provider: ProviderName,
  tools: readonly string[] | undefined,
  providerTools: readonly string[] | undefined,
): readonly string[] | undefined {
  if (tools === undefined && providerTools === undefined) return undefined;
  const mapped = tools?.flatMap((tool) => mapTool(provider, tool)) ?? [];
  const merged = [...mapped, ...(providerTools ?? [])];
  return [...new Set(merged)];
}

function mapTool(
  provider: ProviderName,
  tool: string,
): readonly string[] {
  if (provider === AgentRuntimeTaskProvider.Claude) {
    return claudeToolMap.get(tool as AgentRuntimeTool) ?? [tool];
  }
  return [tool];
}
