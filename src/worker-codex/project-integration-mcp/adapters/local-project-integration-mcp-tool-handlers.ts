import { LocalReviewedOutputIntegrationIntegrity } from "../../reviewed-worker-output/adapters/local-reviewed-output-integration-integrity";
import { dirname, join } from "node:path";
import { LocalIntegrationAttemptStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  LocalGitIntegrationAdapter,
  ConfiguredCommitIdentityAdapter,
  LocalIntegratedOutputLedgerAdapter,
  LocalProjectCheckRunner,
  LocalWorkspaceIntegrationLock,
  SimpleSecretScanner,
} from "@vioxen/subscription-runtime/worker-local";
import {
  createProjectIntegrationMcpToolHandlers,
  type CreateProjectIntegrationMcpToolHandlersOptions,
  type ProjectIntegrationMcpUseCaseDeps,
} from "../application/create-project-integration-mcp-tool-handlers";
import type {
  ProjectIntegrationMcpController,
  ProjectIntegrationMcpToolHandlers,
} from "../ports/project-integration-mcp-tool-handlers";
import {
  localProjectIntegrationSnapshotRoot,
  validateLocalWorkerHandoffArtifact,
} from "./local-worker-handoff-artifact-validator";
import { readCodexGoalJob } from "../../codex-goal-jobs";
import {
  LocalReviewedWorkerOutputStore,
  resolveReviewedWorkerOutput,
  reviewedWorkerOutputRoot,
} from "../../reviewed-worker-output";
import { projectControlWorkspaceLockRoot } from "../../codex-goal-project-workspace-lock";
import { projectControlConsumedOutputEvidenceRoot } from
  "../../codex-goal-mcp-project-scope";

export type CreateLocalProjectIntegrationMcpToolHandlersOptions = Pick<
  CreateProjectIntegrationMcpToolHandlersOptions,
  "loadController" | "resolvePathArg" | "assertAttemptMutable"
>;

export function createLocalProjectIntegrationMcpToolHandlers(
  options: CreateLocalProjectIntegrationMcpToolHandlersOptions,
): ProjectIntegrationMcpToolHandlers {
  return createProjectIntegrationMcpToolHandlers({
    ...options,
    integrationDeps: localProjectIntegrationDeps,
    validateWorkerHandoffArtifact: async (input) => {
      const registeredWorker = await readRegisteredWorkerOwnership(
        input.controller,
        input.workerJobId,
      );
      return validateLocalWorkerHandoffArtifact({
        ...input,
        ...(registeredWorker ? { registeredWorker } : {}),
      });
    },
    resolveReviewedOutput: async (controller, input) =>
      resolveReviewedWorkerOutput({
        store: new LocalReviewedWorkerOutputStore({
          rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
        }),
        projectId: controller.scope.projectId,
        reviewedOutputId: input.reviewedOutputId,
        ...(input.expectedWorkerJobId
          ? { expectedWorkerJobId: input.expectedWorkerJobId }
          : {}),
      }),
  });
}

async function readRegisteredWorkerOwnership(
  controller: ProjectIntegrationMcpController,
  workerJobId: string,
) {
  try {
    const worker = await readCodexGoalJob({
      registryRootDir: controller.registryRootDir,
      jobId: workerJobId,
    });
    return {
      jobId: worker.jobId,
      jobRootDir: worker.jobRootDir,
      workspacePath: worker.workspacePath,
      ...(worker.projectAccessScope
        ? { projectAccessScope: worker.projectAccessScope }
        : {}),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function localProjectIntegrationDeps(
  controller: ProjectIntegrationMcpController,
): ProjectIntegrationMcpUseCaseDeps {
  const rootDir = join(controller.controller.jobRootDir, "project-integration");
  const controllerArchiveRoot = projectIntegrationArchiveRoot(controller);
  const evidenceRoots = controller.scope.consumedOutputEvidenceRoots ?? [];
  const activeEvidenceRoot = evidenceRoots.length > 0
    ? projectControlConsumedOutputEvidenceRoot(controller.scope)
    : undefined;
  return {
    store: new LocalIntegrationAttemptStore({ rootDir }),
    git: new LocalGitIntegrationAdapter({
      allowedPatchRoots: projectIntegrationAllowedPatchRoots(controller),
      workerJobRootParent: dirname(controller.controller.jobRootDir),
      controllerArchiveRoot,
    }),
    commitIdentity: new ConfiguredCommitIdentityAdapter(
      controller.scope.commitIdentity,
    ),
    integratedOutputLedger: new LocalIntegratedOutputLedgerAdapter({
      ledgerRoots: controller.scope.consumedOutputLedgerRoots ?? [],
      evidenceRoots,
      ...(activeEvidenceRoot ? { activeEvidenceRoot } : {}),
      custodyRoot: dirname(dirname(controller.registryRootDir)),
    }),
    checks: new LocalProjectCheckRunner(),
    scanner: new SimpleSecretScanner(),
    reviewedOutputIntegrity: new LocalReviewedOutputIntegrationIntegrity({
      rootDir: reviewedWorkerOutputRoot(controller.registryRootDir),
      projectId: controller.scope.projectId,
    }),
    locks: new LocalWorkspaceIntegrationLock({
      rootDir: projectControlWorkspaceLockRoot(controller.registryRootDir),
      staleLockMs: 30 * 60_000,
    }),
  };
}

function projectIntegrationAllowedPatchRoots(
  controller: ProjectIntegrationMcpController,
): readonly string[] {
  return [
    ...(controller.scope.workspaceRoots ?? []),
    ...(controller.scope.worktreeRoots ?? []),
    localProjectIntegrationSnapshotRoot(controller),
    reviewedWorkerOutputRoot(controller.registryRootDir),
  ];
}

function projectIntegrationArchiveRoot(
  controller: ProjectIntegrationMcpController,
): string {
  return join(controller.controller.jobRootDir, "archives");
}
