import { hostname } from "node:os";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { projectControlAuditPath } from "./codex-goal-mcp-project-broker";
import {
  createOrReuseProjectControlOperation,
  ProjectControlOperationStatus,
  projectControlOperationView,
  projectControlOperationsRoot,
  startProjectControlOperationRunner,
  updateProjectControlOperation,
  type JsonRecord,
  type ProjectControlOperationRecord,
  type ProjectControlOperationToolName,
} from "./project-control-operation-lifecycle";

type JsonObject = Readonly<Record<string, unknown>>;

export async function createBoundedProjectControlOperationView(input: {
  readonly controller: CodexGoalJobManifest;
  readonly registryRootDir: string;
  readonly operationToolName: ProjectControlOperationToolName;
  readonly operationArgs: JsonRecord;
  readonly targetJobId: string;
}): Promise<JsonObject> {
  const creation = await createOrReuseProjectControlOperation({
    operationsRootDir: projectControlOperationsRoot(input.controller.jobRootDir),
    controllerJobId: input.controller.jobId,
    toolName: input.operationToolName,
    args: input.operationArgs,
    targetJobId: input.targetJobId,
  });
  if (!creation.created) {
    return operationView({
      controller: input.controller,
      registryRootDir: input.registryRootDir,
      targetJobId: input.targetJobId,
      operation: creation.operation,
    });
  }
  const runner = await startProjectControlOperationRunner({
    operationFilePath: creation.operation.operationFilePath,
    cwd: input.controller.workspacePath,
  });
  const updated = await updateProjectControlOperation({
    operationFilePath: creation.operation.operationFilePath,
    update: (current) => current.status === ProjectControlOperationStatus.Queued &&
        current.runner === undefined
      ? { runner: {
          hostname: hostname(), pid: runner.pid, command: runner.command,
          startedAt: new Date().toISOString(),
        } }
      : {},
  });
  return operationView({
    controller: input.controller,
    registryRootDir: input.registryRootDir,
    targetJobId: input.targetJobId,
    operation: updated,
  });
}

function operationView(input: {
  readonly controller: CodexGoalJobManifest;
  readonly registryRootDir: string;
  readonly targetJobId: string;
  readonly operation: ProjectControlOperationRecord;
}): JsonObject {
  return {
    ok: true,
    mode: "project_control_refill_worker_operation_started",
    executionMode: "bounded",
    controllerJobId: input.controller.jobId,
    registryRootDir: input.registryRootDir,
    auditPath: projectControlAuditPath(input.controller),
    operationId: input.operation.operationId,
    operationStatusTool: "codex_goal_project_operation_status",
    operationStatusArgs: {
      registryRootDir: input.registryRootDir,
      controllerJobId: input.controller.jobId,
      operationId: input.operation.operationId,
    },
    targetJobId: input.targetJobId,
    ...(input.operation.runner ? { runnerPid: input.operation.runner.pid } : {}),
    operation: projectControlOperationView({ operation: input.operation }),
  };
}
