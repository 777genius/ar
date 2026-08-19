import {
  AccessBoundary,
  type ProjectAccessScope,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness } from
  "./codex-goal-ops";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import {
  registryRootFromArgs,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import { buildCodexGoalOverviewItems } from "./codex-goal-mcp-overview-item";
import {
  createCodexProjectControlBroker,
  type CodexProjectControlBrokerInput,
} from "./codex-goal-mcp-project-broker";
import type { CodexProjectAdmissionDeps } from "./application/project-control/codex-goal-project-admission";
import { requiredRawString } from "./codex-goal-mcp-values";
import { assertProjectControlCustodyScopeCanonical } from
  "./codex-goal-mcp-project-scope";
import { LocalProjectControlEvidenceCustody } from
  "../worker-local/project-control-evidence-custody-local-adapter";
export {
  loadJobLaunch,
  type LoadedCodexGoalJobLaunch,
} from "./application/codex-goal-job-launch-loader";

export type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export async function loadProjectControlController(
  args: ProjectControlMcpArgs,
): Promise<LoadedProjectControlController> {
  const registryRootDir = registryRootFromArgs(args);
  const controller = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.controllerJobId, "controllerJobId"),
  });
  if (controller.accessBoundary !== AccessBoundary.ProjectScopedControl) {
    throw new Error("project_control_controller_boundary_required");
  }
  if (!controller.projectAccessScope) {
    throw new Error("project_control_controller_scope_required");
  }
  await assertProjectControlCustodyScopeCanonical(controller.projectAccessScope);
  return {
    registryRootDir,
    controller,
    scope: controller.projectAccessScope,
  };
}

export const projectControlEvidenceCustody =
  new LocalProjectControlEvidenceCustody();

export const codexProjectAdmissionDeps: CodexProjectAdmissionDeps = {
  listJobs: listCodexGoalJobs,
  readJob: readCodexGoalJob,
  buildOverviewItems: (inputs) => buildCodexGoalOverviewItems(inputs),
  observeManifestRuntime: async (manifest) => {
    const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
    const status = await collectCodexGoalStatus(
      codexGoalStatusInputFromLaunch(launch),
    );
    const resultPath = status.resultPath;
    return {
      workspaceDirty: status.workspaceDirty === true,
      workerAlive: resolveCodexGoalWorkerLiveness({
        status,
        progressStale: false,
      }).alive,
      resultExists: status.resultExists === true,
      ...(resultPath === undefined ? {} : { resultPath }),
    };
  },
  evidenceCustody: projectControlEvidenceCustody,
};

export function codexProjectControlBroker(
  input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
): ProjectControlBroker {
  return createCodexProjectControlBroker({
    ...input,
    admissionDeps: codexProjectAdmissionDeps,
  });
}
