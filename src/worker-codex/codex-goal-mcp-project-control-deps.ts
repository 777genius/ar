import { CodexGoalObservationMode } from "./application/codex-goal-registered-job-observation";
import { observeResearchJobWriterAuthority, prepareResearchJobWriterObservation, createResearchJobWriterObservationPreparer } from "./research-writer-observation";
import { LocalConsumedOutputLedgerMutationLock } from "../worker-local/consumed-output-ledger-local-adapter";
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

/** `includeRetired` is for read-only observation only, never from tool arguments. */
export async function loadProjectControlController(
  args: ProjectControlMcpArgs,
  options: { readonly includeRetired?: true } = {},
): Promise<LoadedProjectControlController> {
  const registryRootDir = registryRootFromArgs(args);
  const controller = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.controllerJobId, "controllerJobId"),
    ...options,
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
  // Admission projects every registration, retired ones included; the effect
  // on the target job is refused by its own Start or create path.
  readJob: input => readCodexGoalJob({ ...input, includeRetired: true }),
  readWriterWritableRoots: observeResearchJobWriterAuthority,
  prepareWriterObservation: prepareResearchJobWriterObservation,
  createWriterObservationPreparer: createResearchJobWriterObservationPreparer,
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

/** Public query composition; command/Status dependencies retain reconciliation. */
export const codexProjectAdmissionQueryDeps: CodexProjectAdmissionDeps = {
  ...codexProjectAdmissionDeps,
  buildOverviewItems: inputs => buildCodexGoalOverviewItems(inputs, CodexGoalObservationMode.ReadOnly),
};

export function codexProjectControlBroker(
  input: Omit<CodexProjectControlBrokerInput, "admissionDeps">,
): ProjectControlBroker {
  return createCodexProjectControlBroker({
    ...input,
    admissionDeps: codexProjectAdmissionDeps,
  });
}

export { openProjectControlRecoveryStore as projectControlRecoveryStore } from
  "../worker-local/project-control-recovery-file-store";
export { localProjectControlRecoveryDirectories as projectControlRecoveryDirectories } from
  "../worker-local/project-control-recovery-directory-identity";

export const projectControlLedgerMutationLocks = new LocalConsumedOutputLedgerMutationLock();
