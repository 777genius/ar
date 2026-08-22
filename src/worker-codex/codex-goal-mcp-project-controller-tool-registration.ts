import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-core";
import {
  jobRegistryInputSchema,
  type ProjectControllerLaunchPlanMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControllerConsumeGuidance,
  projectControllerLaunchPlan,
  projectControllerReconcile,
  projectControllerStart,
  projectControllerStatus,
  projectControllerStop,
} from "./codex-goal-mcp-project-control-tool-handlers";
import {
  controllerProviderKindSchemaValues,
} from "./codex-goal-mcp-project-control-tool-schemas";

export type CodexGoalProjectControllerToolOptions = {
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistry;
};

export function registerCodexGoalProjectControllerTools(
  server: McpServer,
  options: CodexGoalProjectControllerToolOptions = {},
): void {
  const providerRuntimeRegistry = options.providerRuntimeRegistry;
  server.registerTool(
    "codex_goal_project_controller_launch_plan",
    {
      title: "Project Controller Controlled-Agent Launch Plan",
      description:
        "Build a fail-closed broker-only LLM controller launch plan for a ProjectScopedControl controller manifest. Does not start an LLM.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
        stateDir: z.string().optional(),
        sessionArtifactPath: z.string().optional(),
        claudePath: z.string().optional(),
        mcpServerName: z.string().optional(),
        mcpCommand: z.string().optional(),
        mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
        mcpCwd: z.string().optional(),
        rawShellMode: z.enum([
          "disabled-by-provider",
          "sandboxed-deny-rules-only",
        ]).optional(),
        maxGoalTurns: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerLaunchPlan(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_start",
    {
      title: "Project Controller Controlled-Agent Start",
      description:
        "Start a broker-only LLM controller when the provider adapter can enforce the controlled-agent launch plan. Fails closed when no safe provider runner is available.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
        stateDir: z.string().optional(),
        sessionArtifactPath: z.string().optional(),
        claudePath: z.string().optional(),
        mcpServerName: z.string().optional(),
        mcpCommand: z.string().optional(),
        mcpArgs: z.union([z.string(), z.array(z.string())]).optional(),
        mcpCwd: z.string().optional(),
        rawShellMode: z.enum([
          "disabled-by-provider",
          "sandboxed-deny-rules-only",
        ]).optional(),
        maxGoalTurns: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStart(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_status",
    {
      title: "Project Controller Controlled-Agent Status",
      description:
        "Read the persisted controlled-agent controller session/run state for a ProjectScopedControl manifest.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
        stateDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStatus(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_consume_guidance",
    {
      title: "Project Controller Consume Guidance",
      description:
        "Consume pending control guidance for the ProjectScopedControl controller's own inbox and record delivery receipts. Does not consume child-worker inboxes.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        deliveryAttemptId: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerConsumeGuidance(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_stop",
    {
      title: "Project Controller Controlled-Agent Stop",
      description:
        "Stop a broker-only LLM controller through its provider adapter. Fails closed while no safe provider runner is connected.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
        stateDir: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerStop(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_controller_reconcile",
    {
      title: "Project Controller Controlled-Agent Reconcile",
      description:
        "Reconcile a broker-only LLM controller run through its provider adapter. Fails closed while no safe provider runner is connected.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        providerKind: z.enum(controllerProviderKindSchemaValues).optional(),
        stateDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControllerReconcile(
        args as ProjectControllerLaunchPlanMcpArgs,
        providerRuntimeRegistry,
      ),
    ),
  );
}
