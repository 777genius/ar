import { readFile } from "node:fs/promises";
import {
  type ProjectAccessScope,
  type ProviderControlledAgentResult,
  type ProviderControllerProfile,
  type ProviderRuntimeRegistry,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import type { ProjectControllerOptions } from "./application/project-control/codex-goal-project-controller-options";
import {
  projectControllerPendingGuidancePromptContext,
} from "./application/project-control/codex-goal-project-controller-guidance";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "./application/codex-goal-worker-control";

// The controller objective (base prompt plus any pending guidance) is provider
// neutral, so it is assembled here and handed to the provider runtime adapter,
// which owns the provider-specific account/session and provider construction.
export async function projectControllerProvider(input: {
  readonly options: ProjectControllerOptions;
  readonly controller: {
    readonly controller: CodexGoalJobManifest;
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
  };
  readonly launch: CodexGoalLaunchInput;
  readonly profile: ProviderControllerProfile;
  readonly state: {
    readonly cwd: string;
  };
  readonly registry: ProviderRuntimeRegistry;
}): Promise<ProviderControlledAgentResult> {
  return input.registry.get(input.profile.kind).controlledAgentProvider({
    profile: input.profile,
    scope: input.controller.scope,
    registryRootDir: input.controller.registryRootDir,
    // Lazy: the adapter reads the objective only after its own fail-closed
    // credential/scope checks pass, matching the pre-registry ordering.
    controllerObjective: () =>
      projectControllerObjectiveWithPendingGuidance(input.controller, input.launch),
    cwd: input.state.cwd,
    launch: input.launch,
    controllerOptions: input.options,
  });
}

async function projectControllerObjectiveWithPendingGuidance(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string> {
  const baseObjective = await readFile(launch.config.promptPath, "utf8");
  const guidanceContext = await projectControllerPendingGuidanceContext(controller, launch);
  return guidanceContext === undefined
    ? baseObjective
    : `${baseObjective}\n\n${guidanceContext}`;
}

async function projectControllerPendingGuidanceContext(
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  launch: CodexGoalLaunchInput,
): Promise<string | undefined> {
  try {
    const control = codexGoalWorkerControlService(launch);
    const target = codexGoalWorkerControlTarget({
      manifest: controller.controller,
      launch,
    });
    const decision = await control.getDecision({ target });
    return projectControllerPendingGuidancePromptContext({
      pendingCount: decision.pendingSignals.length,
      deliverableSignals: decision.deliverableSignals,
    });
  } catch {
    return undefined;
  }
}
