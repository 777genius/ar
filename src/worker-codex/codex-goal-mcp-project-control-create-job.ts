import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import {
  readCodexGoalJob,
  summarizeCodexGoalJob,
  type CodexGoalJobManifestInput,
} from "./codex-goal-jobs";
import { projectAdmissionWorkerRoleArg } from "./application/project-control/codex-goal-project-admission";
import { projectControlChildManifestInput } from "./application/project-control/codex-goal-project-child-manifest";
import {
  projectControlDefaultAccountNames,
  rotateProjectControlAccountNames,
} from "./codex-goal-mcp-project-accounts";
import {
  type CodexProjectControlBrokerInput,
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import {
  assertProjectControlCreateManifestPaths,
  projectControlChildScope,
  projectControlRealPathOutsideWorkspaceScope,
} from "./codex-goal-mcp-project-scope";
import { uniqueProjectControlStrings } from "./codex-goal-mcp-project-utils";
import { booleanValue, tagValues } from "./codex-goal-mcp-values";
import type {
  JobCreateMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import type { CodexGoalMcpProjectControlJobsDeps } from "./codex-goal-mcp-project-control-jobs";
import { withCurrentControllerScopeActivity } from
  "./application/project-control/codex-goal-current-controller-activity";

type JsonObject = Readonly<Record<string, unknown>>;

export async function projectControlCreateCodexGoalJobView(
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  if (args.projectAccessScope !== undefined) {
    throw new Error("project_control_child_scope_is_controller_owned");
  }
  if (args.allowDangerFullAccess === true) {
    throw new Error("project_control_child_danger_full_access_denied");
  }
  if (controller.scope.preStartAdmission?.required) {
    throw new Error("project_control_pre_start_admission_refill_required");
  }

  const requested = projectControlChildManifestInput({
    args: args as JobCreateMcpArgs,
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
  });
  if (
    requested.accessBoundary === AccessBoundary.ProjectScopedControl ||
    requested.accessBoundary === AccessBoundary.DangerFullAccess
  ) {
    throw new Error("project_control_child_boundary_denied");
  }
  const accessBoundary =
    requested.accessBoundary ?? AccessBoundary.IsolatedWorkspaceWrite;
  const workerRole = projectAdmissionWorkerRoleArg(args.workerRole);
  const accounts = rotateProjectControlAccountNames(
    await projectControlDefaultAccountNames({
      ...(requested.authRootDir ? { authRootDir: requested.authRootDir } : {}),
      requestedAccounts: requested.accounts,
      allowedAccountIds: controller.scope.allowedAccountIds ?? [],
    }),
    requested.jobId,
  );
  const createManifest: CodexGoalJobManifestInput = {
    ...requested,
    accounts,
    accessBoundary,
    projectAccessScope: projectControlChildScope(
      controller.scope,
      requested.workspacePath,
    ),
    allowDangerFullAccess: false,
    networkAccess: requested.networkAccess ?? NetworkAccessMode.Restricted,
    ...(workerRole
      ? {
          tags: uniqueProjectControlStrings([
            ...tagValues(requested.tags),
            `worker-role-${workerRole}`,
          ]),
        }
      : {}),
  };
  assertProjectControlCreateManifestPaths({
    scope: controller.scope,
    registryRootDir: controller.registryRootDir,
    manifest: createManifest,
  });

  if (!args.confirmCreate) {
    return {
      ok: false,
      reason: "confirm_create_required",
      controllerJobId: controller.controller.jobId,
      targetJobId: createManifest.jobId,
      auditPath: projectControlAuditPath(controller.controller),
      manifestPreview: createManifest as unknown as JsonObject,
    };
  }

  const { result, manifest } = await withCurrentControllerScopeActivity({
    controllerJobRootDir: controller.controller.jobRootDir,
    owner: `project-control-create:${createManifest.jobId}`,
    expectedScope: controller.scope,
    loadCurrentScope: async () =>
      (await deps.loadProjectControlController(args)).scope,
    effect: async () => {
      const broker = deps.codexProjectControlBroker({
        registryRootDir: controller.registryRootDir,
        controller: controller.controller,
        scope: controller.scope,
        createManifest,
        createOverwrite: booleanValue(args.overwrite) ?? false,
      } satisfies Omit<CodexProjectControlBrokerInput, "admissionDeps">);
      const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(
        createManifest.workspacePath,
        controller.scope,
      );
      const result = await broker.createJob({
        jobId: createManifest.jobId,
        registryRoot: controller.registryRootDir,
        workspacePath: createManifest.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(createManifest.tmuxSession
          ? { tmuxSession: createManifest.tmuxSession }
          : {}),
        accounts: createManifest.accounts,
        ...(workerRole ? { workerRole } : {}),
        ...(createManifest.tags ? { tags: createManifest.tags } : {}),
      });
      const manifest = await readCodexGoalJob({
        registryRootDir: controller.registryRootDir,
        jobId: createManifest.jobId,
      });
      return { result, manifest };
    },
  });
  return {
    ok: true,
    mode: "project_control_create_job",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    auditPath: projectControlAuditPath(controller.controller),
    result: result as unknown as JsonObject,
    manifest,
    summary: summarizeCodexGoalJob(manifest, controller.registryRootDir),
  };
}
