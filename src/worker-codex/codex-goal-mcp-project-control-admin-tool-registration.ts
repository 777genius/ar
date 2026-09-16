import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jobIdInputSchema,
  jobRegistryInputSchema,
  type JobUpdateMcpArgs,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { withMcpErrors } from "./codex-goal-mcp-response";
import {
  projectControlAdmissionSnapshot,
  projectControlRepairLegacyOutputDebt,
  projectControlReconcileStaleIntegrations,
  projectControlQuarantineLegacyIntegrationAttempts,
  projectControlLedgerEpochMigration,
  projectControlRepairJobManifest,
  projectControlUpdateControllerScope,
} from "./codex-goal-mcp-project-control-tool-handlers";
import {
  projectAdmissionOperationSchemaValues,
  projectAdmissionWorkerRoleSchemaValues,
} from "./codex-goal-mcp-project-control-tool-schemas";

export function registerCodexGoalProjectControlAdminTools(server: McpServer): void {
  server.registerTool(
    "codex_goal_project_reconcile_stale_integrations",
    {
      title: "Project Reconcile Stale Integration Lifecycles",
      description:
        "Preview or confirm hash-bound reconciliation of stale integration attempts only when canonical target and patch/commit evidence prove safe terminalization.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        expectedStaleIntegrationPlanSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        confirmStaleIntegrationReconciliation: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlReconcileStaleIntegrations(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_quarantine_legacy_integration_attempts",
    {
      title: "Project Quarantine Legacy Integration Attempts",
      description:
        "Preview or confirm immutable retirement of exact investigated nonterminal legacy attempts that automatic reconciliation refuses. Attempt lifecycle bytes remain unchanged and visible as quarantine debt.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        sourceStaleIntegrationPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
        legacyAttemptQuarantineCutoff: z.string().datetime(),
        expectedLegacyAttemptQuarantinePlanSha256:
          z.string().regex(/^[a-f0-9]{64}$/).optional(),
        confirmLegacyAttemptQuarantine: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlQuarantineLegacyIntegrationAttempts(
        args as ProjectControlMcpArgs,
      ),
    ),
  );

  server.registerTool(
    "codex_goal_project_repair_legacy_output_debt",
    {
      title: "Project Repair Legacy Consumed Output Debt",
      description:
        "Preview or explicitly confirm a brokered bulk quarantine of admission-validated legacy consumed-output records. Preview is the default.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        confirmLegacyOutputRepair: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRepairLegacyOutputDebt(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_admission_snapshot",
    {
      title: "Project Admission Snapshot",
      description:
        "Read project output debt used by the ProjectScopedControl admission gate. This is read-only.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        operation: z.enum(projectAdmissionOperationSchemaValues).optional(),
        workerRole: z.enum(projectAdmissionWorkerRoleSchemaValues).optional(),
        includeDetails: z.boolean().optional(),
        maxDebtItems: z.number().int().min(0).optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlAdmissionSnapshot(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_update_controller_scope",
    {
      title: "Project Control Update Controller Scope",
      description:
        "Safely repair limited ProjectScopedControl controller scope fields through a brokered manifest update path.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        projectAccessScope: z.record(z.string(), z.unknown()).optional(),
        confirmUpdate: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlUpdateControllerScope(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "codex_goal_project_migrate_consumed_output_ledger_epoch",
    {
      title: "Project Control Migrate Consumed Output Ledger Epoch",
      description:
        "Preview or atomically activate a hash-bound consumed-output ledger epoch while preserving and explicitly quarantining legacy evidence.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string().optional(),
        oldLedgerRoot: z.string(),
        newLedgerRoot: z.string(),
        ledgerEpochCutoff: z.string().datetime(),
        expectedLedgerEpochPlanSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        confirmLedgerEpochMigration: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlLedgerEpochMigration(args as ProjectControlMcpArgs),
    ),
  );

  server.registerTool(
    "brokered_project_manifest_repair",
    {
      title: "Brokered Project Manifest Repair",
      description:
        "Safely repair limited project-owned child job manifest fields through a ProjectScopedControl controller.",
      inputSchema: {
        ...jobIdInputSchema(),
        controllerJobId: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
        serviceTier: z.enum(["default", "fast"]).optional(),
        reviewedOutputId: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        confirmRepair: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      projectControlRepairJobManifest(args as ProjectControlMcpArgs & JobUpdateMcpArgs),
    ),
  );
}
