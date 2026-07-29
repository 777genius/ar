import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { booleanValue, requiredRawString } from "./codex-goal-mcp-values";
import {
  projectControlOperationView,
  projectControlOperationsRoot,
  readProjectControlOperationById,
} from "./project-control-operation-lifecycle";

type JsonObject = Readonly<Record<string, unknown>>;

type ProjectControlOperationStatusDeps = {
  readonly loadProjectControlController: (
    args: ProjectControlMcpArgs,
  ) => Promise<{
    readonly registryRootDir: string;
    readonly controller: {
      readonly jobId: string;
      readonly jobRootDir: string;
    };
  }>;
};

export async function projectControlOperationStatusView(
  args: ProjectControlMcpArgs,
  deps: ProjectControlOperationStatusDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const operationId = requiredRawString(args.operationId, "operationId");
  const operation = await readProjectControlOperationById({
    operationsRootDir: projectControlOperationsRoot(
      controller.controller.jobRootDir,
    ),
    operationId,
  });
  return {
    ok: true,
    mode: "project_control_operation_status",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    operation: projectControlOperationView({
      operation,
      includeResult: booleanValue(args.includeResult) === true,
    }),
  };
}
