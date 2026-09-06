import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CODEX_GOAL_CONTROL_SURFACE_SCHEMA,
} from "./codex-goal-mcp-decision-contracts";
import {
  goalInputSchema,
} from "./codex-goal-mcp-input-schemas";
import {
  jobIdInputSchema,
  jobRegistryInputSchema,
  CodexGoalBriefDetail,
  type JobBriefMcpArgs,
  type JobCreateMcpArgs,
  type JobDecisionMcpArgs,
  type JobHandoffMcpArgs,
  type JobIdMcpArgs,
  type JobLifecycleMcpArgs,
  type JobOverviewMcpArgs,
  type JobRegistryMcpArgs,
  type JobResultReconcileMcpArgs,
  type JobUpdateMcpArgs,
  type JobWatchMcpArgs,
} from "./codex-goal-mcp-inputs";
import { buildCodexGoalBriefMcpResponse } from "./codex-goal-mcp-brief-response";
import {
  mcpJson,
  withMcpErrors,
} from "./codex-goal-mcp-response";
import {
  assertSingleCodexWriterUseCase,
  buildCodexGoalBriefUseCase,
  buildCodexGoalDecisionUseCase,
  buildCodexGoalHandoffUseCase,
  buildCodexGoalOverviewUseCase,
  continueStoredJobUseCase,
  createCodexGoalJobUseCase,
  getCodexGoalJobUseCase,
  getCodexGoalStatusByIdUseCase,
  listCodexGoalJobsUseCase,
  maintenancePauseStoredJobUseCase,
  markCodexGoalReviewedUseCase,
  recommendCodexGoalNextActionUseCase,
  reconcilePreviewCodexGoalJobsUseCase,
  reconcileStoredJobRuntimeResultUseCase,
  stopStoredJobUseCase,
  updateCodexGoalJobUseCase,
} from "./application/codex-goal-job-use-cases";

export function registerCodexGoalJobTools(server: McpServer): void {
  server.registerTool(
    "codex_goal_list_jobs",
    {
      title: "List Codex Goal Jobs",
      description: "List stored Codex goal job manifests.",
      inputSchema: jobRegistryInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await listCodexGoalJobsUseCase(args as JobRegistryMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_overview",
    {
      title: "Codex Goal Overview",
      description:
        "Summarize all stored Codex goal jobs with compact status, account and next-action hints.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        jobIdPrefix: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await buildCodexGoalOverviewUseCase(args as JobOverviewMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_reconcile_preview",
    {
      title: "Codex Goal Reconcile Preview",
      description:
        "Run one safe reconciliation-preview pass over stored jobs. Dry-run by default; continues only when continueSafeJobs is true and each job is safe. This is not pure watch.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        jobIds: z.union([z.string(), z.array(z.string())]).optional(),
        continueSafeJobs: z.boolean().optional(),
        maxContinuesPerRun: z.number().int().positive().optional(),
        skipDoctor: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await reconcilePreviewCodexGoalJobsUseCase(args as JobWatchMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_get_job",
    {
      title: "Get Codex Goal Job",
      description: "Read one Codex goal job manifest by jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await getCodexGoalJobUseCase(args as JobIdMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_create_job",
    {
      title: "Create Codex Goal Job",
      description:
        "Create a versioned job.json manifest so future tools can operate by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await createCodexGoalJobUseCase(args as JobCreateMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_update_job",
    {
      title: "Update Codex Goal Job",
      description: "Patch an existing job.json manifest by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await updateCodexGoalJobUseCase(args as JobUpdateMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_status_by_id",
    {
      title: "Codex Goal Status By Job",
      description: "Inspect a stored Codex goal job using only jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await getCodexGoalStatusByIdUseCase(args as JobIdMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_recommend_next_action",
    {
      title: "Recommend Codex Goal Action",
      description: "Return the next safe lifecycle action for a stored job.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await recommendCodexGoalNextActionUseCase(args as JobIdMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_assert_single_writer",
    {
      title: "Assert Single Codex Writer",
      description:
        "Check whether starting another writer for this job would be safe.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await assertSingleCodexWriterUseCase(
        args as JobIdMcpArgs & Readonly<Record<string, unknown>>,
      )),
    ),
  );

  server.registerTool(
    "codex_goal_reconcile_result",
    {
      title: "Reconcile Codex Goal Runtime Result",
      description:
        "Write a strict latest-result.json for a stopped or stale Codex goal when the worker crashed, was stopped, or left a non-strict result.",
      inputSchema: {
        ...jobIdInputSchema(),
        forceWrite: z.boolean().optional(),
        preservePatch: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await reconcileStoredJobRuntimeResultUseCase(
        args as JobResultReconcileMcpArgs,
      )),
    ),
  );

  server.registerTool(
    "codex_goal_continue",
    {
      title: "Continue Codex Goal",
      description:
        "Safely continue a stored job by jobId when status allows continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmContinue: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await continueStoredJobUseCase(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmContinue",
        mode: "continue",
      })),
    ),
  );

  server.registerTool(
    "codex_goal_recover",
    {
      title: "Recover Codex Goal",
      description:
        "Recover a stored job after quota, auth, reconnect or timeout status.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmRecover: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await continueStoredJobUseCase(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmRecover",
        mode: "recover",
      })),
    ),
  );

  server.registerTool(
    "codex_goal_stop",
    {
      title: "Stop Codex Goal Worker",
      description:
        "Stop a stored job's tmux worker after explicit confirmation. Default guard allows silent-stale workers only.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmStop: z.boolean().optional(),
        forceStop: z.boolean().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await stopStoredJobUseCase(args as JobLifecycleMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_maintenance_pause",
    {
      title: "Maintenance Pause Codex Goal Worker",
      description:
        "Stop a stored job's tmux worker for planned maintenance without reconciling it as a runtime failure.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmPause: z.boolean().optional(),
        forcePause: z.boolean().optional(),
        reason: z.string().optional(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await maintenancePauseStoredJobUseCase(args as JobLifecycleMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_mark_reviewed",
    {
      title: "Mark Codex Goal Reviewed",
      description:
        "Write a local review marker after a human or orchestrator has inspected the result.",
      inputSchema: {
        ...jobIdInputSchema(),
        note: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await markCodexGoalReviewedUseCase(
        args as JobIdMcpArgs & Readonly<{ note?: unknown }>,
      )),
    ),
  );

  server.registerTool(
    "codex_goal_brief",
    {
      title: "Codex Goal Brief",
      description:
        "Poll one job. Compact is the default, stays within a 64 KiB MCP envelope, and returns a revision; pass it as afterRevision on the next poll to receive a small unchanged response. Inspect truncation guidance or use full for complete diagnostics, and request a log tail only when needed.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        includeLogTail: z.boolean().optional(),
        detail: z.enum(CodexGoalBriefDetail).optional(),
        afterRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
      },
    },
    async (rawArgs) => withMcpErrors(async () => {
      const args = rawArgs as JobBriefMcpArgs;
      const detail = args.detail ?? CodexGoalBriefDetail.Compact;
      const logTailLines = detail === CodexGoalBriefDetail.Full
        ? args.tailLines ?? 20
        : args.tailLines ?? (args.includeLogTail === true ? 20 : 0);
      const full = await buildCodexGoalBriefUseCase({
        ...args,
        tailLines: logTailLines,
      });
      return mcpJson(buildCodexGoalBriefMcpResponse(full, {
        detail,
        logTailLines,
        ...(args.registryRootDir === undefined ? {} : { registryRootDir: args.registryRootDir }),
        ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
        ...(args.staleAfterMs === undefined ? {} : { staleAfterMs: args.staleAfterMs }),
        ...(args.targetCommit === undefined ? {} : { targetCommit: args.targetCommit }),
        ...(args.targetWorkspacePath === undefined
          ? {}
          : { targetWorkspacePath: args.targetWorkspacePath }),
        ...(args.afterRevision === undefined ? {} : { afterRevision: args.afterRevision }),
      }));
    }),
  );

  server.registerTool(
    "codex_goal_decision",
    {
      title: "Codex Goal Decision",
      description:
        "Return a conservative agent decision report with blockers, evidence and exact next command.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
        includeRegistryConflicts: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        registryRootDir: z.string(),
        jobId: z.string(),
        decision: z.object({
          controlSurface: CODEX_GOAL_CONTROL_SURFACE_SCHEMA,
        }).passthrough(),
        status: z.unknown().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await buildCodexGoalDecisionUseCase(args as JobDecisionMcpArgs)),
    ),
  );

  server.registerTool(
    "codex_goal_handoff",
    {
      title: "Codex Goal Handoff",
      description:
        "Build a copy-paste safe handoff bundle for another agent by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
        targetCommit: z.string().optional(),
        targetWorkspacePath: z.string().optional(),
        includeCliFallback: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      mcpJson(await buildCodexGoalHandoffUseCase(args as JobHandoffMcpArgs)),
    ),
  );
}
