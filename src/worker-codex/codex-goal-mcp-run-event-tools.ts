import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderRuntimeRegistry } from "./codex-goal-provider-runtime";
import {
  jobRegistryInputSchema,
  type AgentRunEventCompactionMcpArgs,
  type AgentRunEventsMcpArgs,
  type AgentRunProjectEventsMcpArgs,
  type AgentRunStateMcpArgs,
  type AgentRunWatchMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  compactAgentRunEvents,
  planAgentRunEventCompaction,
  projectAgentRunEvents,
  readAgentRunEvents,
  readAgentRunState,
  watchAgentRuns,
} from "./codex-goal-mcp-run-events";

export type CodexGoalRunEventToolOptions = {
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistry;
};

export function registerCodexGoalRunEventTools(
  server: McpServer,
  options: CodexGoalRunEventToolOptions = {},
): void {
  const providerRuntimeRegistry = options.providerRuntimeRegistry;
  const agentRunWatchTool = {
    title: "Agent Run Watch",
    description:
      "Read-only provider-neutral run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers. Defaults to 25 runs (max 100) and a 64 KiB complete response; follow nextCursor using cursor with unchanged filters. Summary covers only returned snapshots; oversized snapshots are explicitly omitted.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string().optional(),
      jobIds: z.union([z.string(), z.array(z.string())]).optional(),
      stateRootDir: z.string().optional(),
      runArtifactsRootDir: z.string().optional(),
      staleAfterMs: z.number().int().positive().optional(),
      tailLines: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional(),
      includeChangedFiles: z.boolean().optional(),
      includeLogTail: z.boolean().optional(),
    },
  };

  server.registerTool(
    "agent_run_watch",
    agentRunWatchTool,
    async (args) => withMcpErrors(async () => {
      const watch = await watchAgentRuns(
        args as AgentRunWatchMcpArgs,
        providerRuntimeRegistry,
      );
      return mcpJson(watch);
    }),
  );

  server.registerTool(
    "codex_goal_run_watch",
    {
      ...agentRunWatchTool,
      title: "Codex Goal Run Watch",
      description:
        "Codex-scoped read-only run observation. Reports status, liveness, progress, logs, workspace changes, capacity hints and read-only recommendations without starting, stopping or continuing workers. Defaults to 25 runs (max 100) and a 64 KiB complete response; follow nextCursor using cursor with unchanged filters. Summary covers only returned snapshots; oversized snapshots are explicitly omitted.",
    },
    async (args) => withMcpErrors(async () => {
      const watch = await watchAgentRuns(
        args as AgentRunWatchMcpArgs,
        providerRuntimeRegistry,
      );
      return mcpJson(watch);
    }),
  );

  const agentRunEventsTool = {
    title: "Agent Run Events",
    description:
      "Read normalized durable run events in pages of 100 events by default (maximum 500), with bounded scans and a 64 KiB MCP response. Large payloads use explicit hashed omission envelopes. Pass nextCursor until hasMore is false. This is read-only and does not control workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string().optional(),
      eventRootDir: z.string().optional(),
      cursor: z.string().optional(),
      type: z.union([z.string(), z.array(z.string())]).optional(),
      types: z.union([z.string(), z.array(z.string())]).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
  };

  server.registerTool(
    "agent_run_events",
    agentRunEventsTool,
    async (args) => withMcpErrors(async () => {
      const events = await readAgentRunEvents(args as AgentRunEventsMcpArgs);
      return mcpJson(events);
    }),
  );

  server.registerTool(
    "codex_goal_events",
    {
      ...agentRunEventsTool,
      title: "Codex Goal Events",
      description:
        "Read normalized durable Codex goal run events in pages of 100 events by default (maximum 500), with bounded scans and a 64 KiB MCP response. Large payloads use explicit hashed omission envelopes. Pass nextCursor until hasMore is false. This is read-only and does not control workers.",
    },
    async (args) => withMcpErrors(async () => {
      const events = await readAgentRunEvents({
        ...(args as AgentRunEventsMcpArgs),
        providerKind: "codex",
      });
      return mcpJson(events);
    }),
  );

  const agentRunStateTool = {
    title: "Agent Run State",
    description:
      "Read projected run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      providerKind: z.string().optional(),
      jobId: z.string(),
      eventRootDir: z.string().optional(),
    },
  };

  server.registerTool(
    "agent_run_state",
    agentRunStateTool,
    async (args) => withMcpErrors(async () => {
      const state = await readAgentRunState(args as AgentRunStateMcpArgs);
      return mcpJson(state);
    }),
  );

  server.registerTool(
    "codex_goal_state",
    {
      ...agentRunStateTool,
      title: "Codex Goal State",
      description:
        "Read projected Codex goal run read-model state from the local event projection store. This is read-only and does not observe, start, stop, continue or recover workers.",
    },
    async (args) => withMcpErrors(async () => {
      const state = await readAgentRunState({
        ...(args as AgentRunStateMcpArgs),
        providerKind: "codex",
      });
      return mcpJson(state);
    }),
  );

  const agentRunEventCompactionTool = {
    title: "Agent Run Event Compaction",
    description:
      "Plan or run explicit local RunEvent JSONL compaction. This touches only the event outbox and delivery cursors; it does not observe, start, stop, continue or recover workers.",
    inputSchema: {
      ...jobRegistryInputSchema(),
      eventRootDir: z.string().optional(),
      keepEventsAfter: z.string().optional(),
      keepLatestEventsPerRun: z.number().int().positive().optional(),
      compactDeliveredEvents: z.boolean().optional(),
      dropInvalidLines: z.boolean().optional(),
      safetyMode: z.string().optional(),
      confirmCompact: z.boolean().optional(),
    },
  };

  server.registerTool(
    "agent_run_event_compaction_plan",
    {
      ...agentRunEventCompactionTool,
      title: "Agent Run Event Compaction Plan",
      description:
        "Read-only plan for local RunEvent JSONL compaction. No files are rewritten.",
    },
    async (args) => withMcpErrors(async () => {
      const plan = await planAgentRunEventCompaction(
        args as AgentRunEventCompactionMcpArgs,
      );
      return mcpJson(plan);
    }),
  );

  server.registerTool(
    "agent_run_event_compact",
    {
      ...agentRunEventCompactionTool,
      title: "Agent Run Event Compact",
      description:
        "Run explicit local RunEvent JSONL compaction. Requires confirmCompact=true and never controls workers.",
    },
    async (args) => withMcpErrors(async () => {
      const result = await compactAgentRunEvents(
        args as AgentRunEventCompactionMcpArgs,
      );
      return mcpJson(result);
    }),
  );

  const agentRunProjectEventsTool = {
    title: "Agent Run Project Events",
    description:
      "Observe runs and project normalized durable RunEvent records in one append. limit selects runs; eventLimit returns 100 events by default (maximum 500). Pages use bounded scans and a 64 KiB MCP response; large payloads use explicit hashed omission envelopes. Pass nextCursor until hasMore is false. This writes event/projection state only and does not control workers.",
    inputSchema: {
      ...agentRunWatchTool.inputSchema,
      eventRootDir: z.string().optional(),
      hostId: z.string().optional(),
      cursor: z.string().optional(),
      eventLimit: z.number().int().positive().max(500).optional(),
      type: z.union([z.string(), z.array(z.string())]).optional(),
      types: z.union([z.string(), z.array(z.string())]).optional(),
    },
  };

  server.registerTool(
    "agent_run_project_events",
    agentRunProjectEventsTool,
    async (args) => withMcpErrors(async () => {
      const projected = await projectAgentRunEvents(
        args as AgentRunProjectEventsMcpArgs,
        providerRuntimeRegistry,
      );
      return mcpJson(projected);
    }),
  );

  server.registerTool(
    "codex_goal_project_events",
    {
      ...agentRunProjectEventsTool,
      title: "Codex Goal Project Events",
      description:
        "Observe Codex goal runs and project normalized durable RunEvent records in one append. limit selects runs; eventLimit returns 100 events by default (maximum 500). Pages use bounded scans and a 64 KiB MCP response; large payloads use explicit hashed omission envelopes. Pass nextCursor until hasMore is false. This writes event/projection state only and does not control workers.",
    },
    async (args) => withMcpErrors(async () => {
      const projected = await projectAgentRunEvents({
        ...(args as AgentRunProjectEventsMcpArgs),
        providerKind: "codex",
      }, providerRuntimeRegistry);
      return mcpJson(projected);
    }),
  );

}
