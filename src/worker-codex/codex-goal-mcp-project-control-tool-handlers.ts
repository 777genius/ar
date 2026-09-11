import { projectControlRelocateControllerWorkspaceView } from "./codex-goal-mcp-project-controller-relocation";
import { mcpJson } from "./codex-goal-mcp-response";
import type {
  JobUpdateMcpArgs,
  ProjectControllerLaunchPlanMcpArgs,
  ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  projectControlAdmissionSnapshotView,
  projectControlRepairLegacyOutputDebtView,
  projectControlReconcileStaleIntegrationsView,
  projectControlRepairJobManifestView,
  projectControlUpdateControllerScopeView,
} from "./codex-goal-mcp-project-control-admin";
import { projectControlLedgerEpochMigrationView } from "./codex-goal-mcp-project-control-ledger-epoch";
import { projectControlLegacyAttemptQuarantineView } from
  "./codex-goal-mcp-project-control-legacy-attempt-quarantine";
import {
  projectControlImportFrozenOutputView,
  projectControlRetireLegacyJobSummaryView,
} from
  "./codex-goal-mcp-project-control-debt-remediation";
import {
  projectControlCreateWorktreeView,
  projectControlIntegrateCommitView,
  projectControlPushBranchView,
  projectControlStartStoredJobView,
  projectControlStopStoredJobView,
} from "./codex-goal-mcp-project-control-actions";
import { projectControlMarkReviewedView } from "./codex-goal-mcp-project-control-review";
import {
  projectControlRecordFailedNoOutputView,
} from "./codex-goal-mcp-project-control-terminal-output";
import {
  projectControlCreateCodexGoalJobView,
  projectControlOperationStatusView,
  projectControlPrepareVerifierView,
  projectControlRecoverOperationsView,
  projectControlRefillWorkerView,
} from "./codex-goal-mcp-project-control-jobs";
import {
  projectControllerConsumeGuidanceView,
  projectControllerLaunchPlanView,
  projectControllerReconcileView,
  projectControllerStartView,
  projectControllerStatusView,
  projectControllerStopView,
} from "./codex-goal-mcp-project-controller";
import {
  createInMemoryProjectControllerProviderRegistry,
} from "./application/project-control/codex-goal-project-controller-runtime";
import { createLocalProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-local";
import type { ProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-core";
import {
  codexProjectAdmissionDeps,
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
  projectControlEvidenceCustody,
} from "./codex-goal-mcp-project-control-deps";
import { subscriptionRuntimePackageVersion } from
  "./subscription-runtime-package-version";

const projectControllerProviderRegistry =
  createInMemoryProjectControllerProviderRegistry();

let cachedProviderRuntimeRegistry: ProviderRuntimeRegistry | undefined;

function defaultProviderRuntimeRegistry(): ProviderRuntimeRegistry {
  return (cachedProviderRuntimeRegistry ??= createLocalProviderRuntimeRegistry());
}

function projectControlAdminDeps() {
  return {
    loadProjectControlController,
    admissionDeps: codexProjectAdmissionDeps,
    evidenceCustody: projectControlEvidenceCustody,
  };
}

export async function projectControlAdmissionSnapshot(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlAdmissionSnapshotView(args, projectControlAdminDeps()));
}

export async function projectControlRepairLegacyOutputDebt(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlRepairLegacyOutputDebtView(
    args,
    projectControlAdminDeps(),
  ));
}

export async function projectControlRetireLegacyJobSummary(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlRetireLegacyJobSummaryView(
    args,
    projectControlAdminDeps(),
  ));
}

export async function projectControlImportFrozenOutput(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlImportFrozenOutputView(
    args,
    projectControlAdminDeps(),
  ));
}

export async function projectControlReconcileStaleIntegrations(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlReconcileStaleIntegrationsView(
    args,
    projectControlAdminDeps(),
  ));
}

export async function projectControlQuarantineLegacyIntegrationAttempts(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlLegacyAttemptQuarantineView(
    args,
    projectControlAdminDeps(),
  ));
}

export async function projectControlUpdateControllerScope(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlUpdateControllerScopeView(args, projectControlAdminDeps()));
}

export async function projectControlRepairJobManifest(
  args: ProjectControlMcpArgs & JobUpdateMcpArgs,
) {
  return mcpJson(await projectControlRepairJobManifestView(args, projectControlAdminDeps()));
}

export async function projectControlLedgerEpochMigration(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlLedgerEpochMigrationView(
    args,
    projectControlAdminDeps(),
  ));
}

function projectControllerDeps(providerRuntimeRegistry?: ProviderRuntimeRegistry) {
  return {
    loadProjectControlController,
    runtimeVersion: subscriptionRuntimePackageVersion,
    providerRegistry: projectControllerProviderRegistry,
    providerRuntimeRegistry: providerRuntimeRegistry ?? defaultProviderRuntimeRegistry(),
  };
}

export async function projectControllerLaunchPlan(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerLaunchPlanView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

export async function projectControllerStart(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerStartView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

export async function projectControllerStatus(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerStatusView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

export async function projectControllerConsumeGuidance(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerConsumeGuidanceView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

export async function projectControllerStop(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerStopView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

export async function projectControllerReconcile(
  args: ProjectControllerLaunchPlanMcpArgs,
  providerRuntimeRegistry?: ProviderRuntimeRegistry,
) {
  return mcpJson(await projectControllerReconcileView(
    args,
    projectControllerDeps(providerRuntimeRegistry),
  ));
}

function projectControlJobsDeps() {
  return {
    loadProjectControlController,
    codexProjectControlBroker,
  };
}

export async function projectControlCreateCodexGoalJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlCreateCodexGoalJobView(args, projectControlJobsDeps()));
}

export async function projectControlRefillWorker(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlRefillWorkerView(args, projectControlJobsDeps()));
}

export async function projectControlPrepareVerifier(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlPrepareVerifierView(args, projectControlJobsDeps()));
}

export async function projectControlOperationStatus(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlOperationStatusView(args, projectControlJobsDeps()));
}

export async function projectControlRecoverOperations(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlRecoverOperationsView(args, projectControlJobsDeps()));
}

function projectControlActionDeps() {
  return {
    loadProjectControlController,
    loadJobLaunch,
    codexProjectControlBroker,
  };
}

export async function projectControlStartStoredJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlStartStoredJobView(args, projectControlActionDeps()));
}

export async function projectControlCreateWorktree(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlCreateWorktreeView(args, projectControlActionDeps()));
}

export async function projectControlIntegrateCommit(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlIntegrateCommitView(args, projectControlActionDeps()));
}

export async function projectControlPushBranch(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlPushBranchView(args, projectControlActionDeps()));
}

export async function projectControlStopStoredJob(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlStopStoredJobView(args, projectControlActionDeps()));
}

export async function projectControlMarkReviewed(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlMarkReviewedView(args, projectControlActionDeps()));
}

export async function projectControlRecordFailedNoOutput(
  args: ProjectControlMcpArgs,
) {
  return mcpJson(await projectControlRecordFailedNoOutputView(
    args,
    projectControlActionDeps(),
  ));
}

export async function projectControlRelocateControllerWorkspace(args: ProjectControlMcpArgs) {
  return mcpJson(await projectControlRelocateControllerWorkspaceView(args, {
    ...projectControlAdminDeps(),
    assertNoHostedControllers: () => {
      if (projectControllerProviderRegistry.hasAny?.() !== false) {
        throw new Error("controller_relocation_hosted_controller_active");
      }
    },
  }));
}
