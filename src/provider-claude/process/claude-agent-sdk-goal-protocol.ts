import type {
  HookCallback,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const claudeGoalCompletionToolName =
  "mcp__agent_runtime_goal__report_completion";

export type ClaudeAgentSdkGoalProtocol = {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly stopHook: HookCallback;
  isComplete(): boolean;
  noteToolUse(toolName: string): void;
};

export function createClaudeAgentSdkGoalProtocol(input: {
  readonly completionCondition: string;
}): ClaudeAgentSdkGoalProtocol {
  let completionReported = false;
  const reportCompletion = tool(
    "report_completion",
    [
      "Report that the Agent Runtime Goal is complete.",
      "Call this only after inspecting the final workspace state and verifying",
      `this completion condition: ${input.completionCondition}`,
    ].join(" "),
    {
      evidence: z.string().min(1).max(2_000).describe(
        "A concise description of the workspace evidence checked before completion.",
      ),
    },
    async () => {
      completionReported = true;
      return {
        content: [{
          type: "text" as const,
          text: "Goal completion recorded. Return the final concise result without making further changes.",
        }],
      };
    },
  );
  const server = createSdkMcpServer({
    name: "agent_runtime_goal",
    version: "1.0.0",
    instructions:
      "This server provides the mandatory completion report for Agent Runtime Goal execution.",
    alwaysLoad: true,
    tools: [reportCompletion],
  });

  return {
    mcpServers: { agent_runtime_goal: server },
    stopHook: async (hookInput) => {
      if (hookInput.hook_event_name !== "Stop" || completionReported) {
        return { continue: true };
      }
      const feedback =
        `The Goal is not complete until ${claudeGoalCompletionToolName} is called after verifying the completion condition. Continue working and report completion only when verified.`;
      return {
        decision: "block",
        reason: feedback,
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: feedback,
        },
      };
    },
    isComplete: () => completionReported,
    noteToolUse(toolName) {
      if (
        completionReported &&
        toolName !== claudeGoalCompletionToolName
      ) {
        completionReported = false;
      }
    },
  };
}
