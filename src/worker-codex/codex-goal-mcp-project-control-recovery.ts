import {
  ProjectControlOperationStatus,
  projectControlOperationView,
  projectControlOperationsRoot,
  recoverProjectControlOperations,
} from "./project-control-operation-lifecycle";
import { booleanValue } from "./codex-goal-mcp-values";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type { CodexGoalMcpProjectControlJobsDeps } from
  "./codex-goal-mcp-project-control-jobs-types";

type JsonObject = Readonly<Record<string, unknown>>;

export async function buildProjectControlRecoverOperationsView(input: {
  readonly args: ProjectControlMcpArgs;
  readonly deps: CodexGoalMcpProjectControlJobsDeps;
  readonly invokeTool: (
    toolName: string,
    args: ProjectControlMcpArgs,
  ) => Promise<JsonObject>;
}): Promise<JsonObject> {
  const controller = await input.deps.loadProjectControlController(input.args);
  if (booleanValue(input.args.confirmRecoverOperations) !== true) {
    return {
      ok: false,
      reason: "confirm_recover_operations_required",
      mode: "project_control_recover_operations",
      controllerJobId: controller.controller.jobId,
      registryRootDir: controller.registryRootDir,
    };
  }
  const summary = await recoverProjectControlOperations({
    operationsRootDir: projectControlOperationsRoot(controller.controller.jobRootDir),
    invokeTool: async (toolName, operationArgs) => await input.invokeTool(
      toolName,
      operationArgs as ProjectControlMcpArgs,
    ),
  });
  return {
    ok: summary.failed === 0 && summary.invalid === 0,
    mode: "project_control_recover_operations",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    scanned: summary.scanned,
    attempted: summary.attempted,
    recovered: summary.recovered,
    reconciled: summary.reconciled,
    alreadyRunning: summary.alreadyRunning,
    terminal: summary.terminal,
    failed: summary.failed,
    invalid: summary.invalid,
    operations: summary.results.map((result) => ({
      ok: result.ok,
      disposition: result.disposition,
      operation: projectControlOperationView({ operation: result.operation }),
    })),
  };
}
