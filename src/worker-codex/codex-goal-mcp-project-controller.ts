import { admitHostedControllerLaunch } from "./hosted-readonly-controller-admission";
import { resolve } from "node:path";
import { RunEventProviderKind } from "@vioxen/subscription-runtime/worker-core";
import { bindControllerStateLocation } from "./application/project-control/codex-goal-controller-state-location";
import { withLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";
import {
  LaunchPlanStatus,
  type ProjectAccessScope,
  type ProviderRuntimeRegistry,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import {
  goalLaunchInput,
} from "./codex-goal-mcp-launch-input";
import {
  projectControllerOptionsFromMcpArgs,
} from "./codex-goal-mcp-project-controller-profile";
import {
  projectControllerLaunchInput,
  projectControllerState,
} from "./application/project-control/codex-goal-project-controller-profile";
import {
  projectControllerProviderKind,
  type ProjectControllerProviderKind,
} from "./application/project-control/codex-goal-project-controller-options";
import {
  projectControllerProvider,
} from "./codex-goal-mcp-project-controller-provider";
import {
  type ProjectControllerProviderRegistry,
} from "./application/project-control/codex-goal-project-controller-runtime";
import {
  projectControllerLaunchPlanViewJson,
  projectControllerReconcileDisconnectedViewJson,
  projectControllerReconcileProviderResultViewJson,
  projectControllerStartExistingRunViewJson,
  projectControllerStartLaunchBlockedViewJson,
  projectControllerStartReadyViewJson,
  projectControllerStartUseCaseBlockedViewJson,
  projectControllerStatusViewJson,
  projectControllerStopDisconnectedViewJson,
  projectControllerStopProviderResultViewJson,
  projectControllerViewBase,
} from "./application/project-control/codex-goal-project-controller-view";
import {
  observeProjectControllerControlledRun,
  reconcileProjectControllerControlledRun,
  startProjectControllerControlledRun,
  stopProjectControllerControlledRun,
} from "./application/project-control/codex-goal-project-controller-run-use-cases";
import type { ProjectControllerLaunchPlanMcpArgs } from "./codex-goal-mcp-inputs";
import {
  stringValue,
} from "./codex-goal-mcp-values";
import {
  workerControlDecisionJson,
} from "./application/codex-goal-worker-control-view";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./application/codex-goal-worker-control";

type JsonObject = Readonly<Record<string, unknown>>;

type LoadedProjectControlController = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
};

export type CodexGoalMcpProjectControllerDeps = {
  readonly loadProjectControlController: (
    args: ProjectControllerLaunchPlanMcpArgs,
  ) => Promise<LoadedProjectControlController>;
  readonly runtimeVersion: string;
  readonly providerRegistry: ProjectControllerProviderRegistry;
  readonly providerRuntimeRegistry: ProviderRuntimeRegistry;
};

export async function projectControllerLaunchPlanView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const options = projectControllerOptionsFromMcpArgs(args);
  const state = projectControllerState(options, controller, deps.providerRuntimeRegistry);
  const profile = state.profile;
  const plan = projectControllerLaunchInput(controller, state, profile);
  return projectControllerLaunchPlanViewJson({
    base: controllerViewBase(controller, state, projectControllerProviderKind(options)),
    rawShellMode: options.rawShellMode,
    profile,
    plan,
  });
}

export async function projectControllerStartView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const observed = await deps.loadProjectControlController(args);
  return await withLocalControllerActivityLease({
    controllerJobRootDir: observed.controller.jobRootDir,
    owner: `controller-start:${observed.controller.jobId}`,
    effect: async () => {
      const controller = await deps.loadProjectControlController(args);
      if (JSON.stringify(controller.controller) !== JSON.stringify(observed.controller)) {
        throw new Error("controller_start_manifest_drift");
      }
      const options = projectControllerOptionsFromMcpArgs(args);
      let state = projectControllerState(options, controller, deps.providerRuntimeRegistry);
      let profile = state.profile;
      const base = controllerViewBase(controller, state, projectControllerProviderKind(options));
      const plan = projectControllerLaunchInput(controller, state, profile);
      if (plan.status === LaunchPlanStatus.Blocked) {
        return projectControllerStartLaunchBlockedViewJson({ base, plan });
      }
      // Pure prerequisites belong inside the activity lease, but must not
      // consume the immutable state location when no provider effect occurred.
      const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
      if (profile.kind === RunEventProviderKind.Codex) {
        if (!controller.scope.authRoot) {
          throw new Error("project_control_controller_auth_root_scope_required");
        }
        if (resolve(launch.config.authRootDir) !== resolve(controller.scope.authRoot)) {
          throw new Error("project_control_controller_auth_root_outside_scope");
        }
      }
      if (profile.kind === RunEventProviderKind.Codex) await admitHostedControllerLaunch(launch);
      const canonicalStateDir = await bindControllerStateLocation(controller.controller, state.stateDir);
      state = projectControllerState({ ...options, stateDir: canonicalStateDir }, controller, deps.providerRuntimeRegistry);
      profile = state.profile;
      const providerInput = await projectControllerProvider({
        options,
        controller,
        launch,
        profile,
        state,
        registry: deps.providerRuntimeRegistry,
      });
      const started = await startProjectControllerControlledRun({
        controllerJobId: controller.controller.jobId,
        scope: controller.scope,
        profile,
        state,
        launch,
        providerInput,
        deps,
      });
      if (!started.result.ok) {
        if ("reason" in started.result) {
          return projectControllerStartExistingRunViewJson({
            base,
            result: started.result,
          });
        }
        return projectControllerStartUseCaseBlockedViewJson({
          base,
          result: started.result,
        });
      }
      return projectControllerStartReadyViewJson({
        base,
        profile,
        plan,
        result: started.result,
        owner: started.owner,
        providerEvidence: started.providerEvidence,
      });
    },
  });
}

export async function projectControllerStatusView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const options = projectControllerOptionsFromMcpArgs(args);
  const state = projectControllerState(options, controller, deps.providerRuntimeRegistry);
  const observed = await observeProjectControllerControlledRun({ state, deps });
  return projectControllerStatusViewJson({
    base: controllerViewBase(
      controller,
      state,
      projectControllerProviderKind(options),
    ),
    result: observed.result,
    providerAttached: observed.providerAttached,
    observed: observed.observed,
    providerStatusError: observed.providerStatusError,
    owner: observed.owner,
  });
}

export async function projectControllerConsumeGuidanceView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const options = projectControllerOptionsFromMcpArgs(args);
  const launch = await goalLaunchInput(codexGoalJobToArgs(controller.controller));
  const control = codexGoalWorkerControlService(launch);
  const target = codexGoalWorkerControlTarget({
    manifest: controller.controller,
    launch,
  });
  const deliveryAttemptId = options.deliveryAttemptId ??
    `${controller.controller.jobId}:controller-guidance:${new Date().toISOString()}`;
  const batch = await control.consumeForContinuation({
    target,
    deliveryAttemptId,
  });
  const decision = await control.getDecision({ target });
  return {
    ok: true,
    mode: "project_controller_consume_guidance",
    controllerJobId: controller.controller.jobId,
    registryRootDir: controller.registryRootDir,
    deliveryAttemptId: batch.deliveryAttemptId,
    consumedCount: batch.signalIds.length,
    signalIds: batch.signalIds,
    ...(batch.message === undefined ? {} : { message: batch.message }),
    decision: workerControlDecisionJson(decision, false),
  };
}

export async function projectControllerStopView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const options = projectControllerOptionsFromMcpArgs(args);
  const state = projectControllerState(options, controller, deps.providerRuntimeRegistry);
  const base = controllerViewBase(
    controller,
    state,
    projectControllerProviderKind(options),
  );
  const stopped = await stopProjectControllerControlledRun({
    state,
    reason: options.reason ?? "project_controller_stop",
    deps,
  });
  if (stopped.stopped !== undefined) {
    return projectControllerStopProviderResultViewJson({
      base,
      statusResult: stopped.statusResult,
      stopped: stopped.stopped,
      owner: stopped.owner,
    });
  }
  return projectControllerStopDisconnectedViewJson({
    base,
    result: stopped.result,
    owner: stopped.owner,
  });
}

export async function projectControllerReconcileView(
  args: ProjectControllerLaunchPlanMcpArgs,
  deps: CodexGoalMcpProjectControllerDeps,
): Promise<JsonObject> {
  const controller = await deps.loadProjectControlController(args);
  const options = projectControllerOptionsFromMcpArgs(args);
  const state = projectControllerState(options, controller, deps.providerRuntimeRegistry);
  const base = controllerViewBase(
    controller,
    state,
    projectControllerProviderKind(options),
  );
  const reconciled = await reconcileProjectControllerControlledRun({
    controllerJobId: controller.controller.jobId,
    state,
    loadLaunch: () => goalLaunchInput(codexGoalJobToArgs(controller.controller)),
    deps,
  });
  if (reconciled.reconciled !== undefined) {
    return projectControllerReconcileProviderResultViewJson({
      base,
      reconciled: reconciled.reconciled,
      owner: reconciled.owner,
    });
  }
  return projectControllerReconcileDisconnectedViewJson({
    base,
    result: reconciled.result,
    owner: reconciled.owner,
  });
}

function controllerViewBase(
  controller: LoadedProjectControlController,
  state: {
    readonly stateDir: string;
    readonly sessionId: string;
  },
  providerKind: ProjectControllerProviderKind,
) {
  return projectControllerViewBase({
    controllerJobId: controller.controller.jobId,
    providerKind,
    registryRootDir: controller.registryRootDir,
    stateDir: state.stateDir,
    sessionId: state.sessionId,
  });
}
