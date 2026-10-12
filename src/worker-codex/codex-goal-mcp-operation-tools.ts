import { withCodexGoalMcpStorage, type CodexGoalMcpStorageDefaults } from "./codex-goal-mcp-inputs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  goalInputSchema,
  statusInputSchema,
} from "./codex-goal-mcp-input-schemas";
import {
  type GoalMcpArgs,
  registryRootFromArgs,
  type StartMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  goalLaunchInput,
} from "./codex-goal-mcp-launch-input";
import {
  numberValue,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  dryRunCodexGoalLaunch,
  inspectCodexGoalDoctor,
  inspectCodexGoalStatus,
  startCodexGoalLaunch,
  tailCodexGoalRunLog,
} from "./application/codex-goal-operation-use-cases";

export function registerCodexGoalLaunchTools(server: McpServer, storageDefaults: CodexGoalMcpStorageDefaults = {}): void {
  server.registerTool(
    "codex_goal_dry_run",
    {
      title: "Codex Goal Dry Run",
      description:
        "Build the exact Codex goal worker command without starting a worker.",
      inputSchema: goalInputSchema(),
    },
    withCodexGoalMcpStorage(storageDefaults, async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      return mcpJson(dryRunCodexGoalLaunch({ launch }));
    })),
  );

  server.registerTool(
    "codex_goal_start",
    {
      title: "Start Codex Goal Worker",
      description:
        "Start a detached tmux Codex goal worker after explicit confirmation.",
      inputSchema: {
        ...goalInputSchema(),
        registryRootDir: z.string().optional(),
        confirmStart: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    withCodexGoalMcpStorage(storageDefaults, async (args) => withMcpErrors(async () => {
      const startArgs = args as StartMcpArgs;
      const launch = await goalLaunchInput(startArgs);
      return mcpJson(await startCodexGoalLaunch({
        launch,
        registryRootDir: registryRootFromArgs(startArgs),
        jobId: launch.config.jobId ?? launch.config.taskId,
        confirmStart: Boolean(startArgs.confirmStart),
        skipDoctor: Boolean(startArgs.skipDoctor),
        forceStart: Boolean(startArgs.forceStart),
      }));
    })),
  );
}

export function registerCodexGoalInspectionTools(server: McpServer, storageDefaults: CodexGoalMcpStorageDefaults = {}): void {
  server.registerTool(
    "codex_goal_status",
    {
      title: "Codex Goal Status",
      description:
        "Inspect tmux, result JSON, log freshness and workspace dirtiness.",
      inputSchema: statusInputSchema(),
    },
    withCodexGoalMcpStorage(storageDefaults, async (args) => withMcpErrors(async () => mcpJson(
      await inspectCodexGoalStatus({
        sourceEnv: (args as GoalMcpArgs).sourceEnv,
        storageRootDir: args.storageRootDir as string | undefined,
        jobId: stringValue(args.jobId),
        cwd: stringValue(args.cwd),
        jobRootDir: stringValue(args.jobRootDir),
        taskId: stringValue(args.taskId),
        workspacePath: stringValue(args.workspacePath),
        tmuxSession: stringValue(args.tmuxSession),
        logPath: stringValue(args.logPath),
        progressPath: stringValue(args.progressPath),
      }),
    ))),
  );

  server.registerTool(
    "codex_goal_doctor",
    {
      title: "Codex Goal Doctor",
      description:
        "Validate prompt, job root, auth root, workspace and account auth files.",
      inputSchema: goalInputSchema(),
    },
    withCodexGoalMcpStorage(storageDefaults, async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      return mcpJson(await inspectCodexGoalDoctor({ launch }));
    })),
  );

  server.registerTool(
    "codex_goal_tail",
    {
      title: "Codex Goal Tail",
      description: "Read the last lines from a Codex goal worker log.",
      inputSchema: {
        storageRootDir: z.string().optional(),
        jobId: z.string().optional(),
        jobRootDir: z.string().optional(),
        taskId: z.string().optional(),
        logPath: z.string().optional(),
        cwd: z.string().optional(),
        lines: z.number().int().positive().optional(),
      },
    },
    withCodexGoalMcpStorage(storageDefaults, async (args) => withMcpErrors(async () => mcpJson(
      await tailCodexGoalRunLog({
        sourceEnv: (args as GoalMcpArgs).sourceEnv,
        storageRootDir: args.storageRootDir as string | undefined,
        jobId: stringValue(args.jobId),
        cwd: stringValue(args.cwd),
        jobRootDir: stringValue(args.jobRootDir),
        taskId: stringValue(args.taskId),
        logPath: stringValue(args.logPath),
        lines: numberValue(args.lines),
      }),
    ))),
  );
}
