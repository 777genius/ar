import { join } from "node:path";
import {
  LocalControlledAgentStateStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  NetworkAccessMode,
  buildControlledAgentLaunchPlan,
  type ProjectAccessScope,
  type ProviderControllerProfile,
  type ProviderControllerProfileInput,
  type ProviderRuntimeRegistry,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { resolvePath } from "../codex-goal-input-values";
import {
  projectControllerProviderKind,
  type ProjectControllerOptions,
} from "./codex-goal-project-controller-options";

// Provider-neutral controller profile. Kept as a local alias so downstream
// project-control modules do not need to reach into worker-core directly.
export type ProjectControllerProfile = ProviderControllerProfile;

export function projectControllerState(
  options: ProjectControllerOptions,
  controller: {
    readonly controller: CodexGoalJobManifest;
  },
  registry: ProviderRuntimeRegistry,
): {
  readonly stateDir: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly store: LocalControlledAgentStateStore;
  readonly profile: ProjectControllerProfile;
} {
  const stateDir = resolvePath(
    options.cwd,
    options.stateDir ?? join(controller.controller.jobRootDir, "controlled-agent"),
  );
  const profile = registry
    .get(projectControllerProviderKind(options))
    .controllerProfile(projectControllerProfileInput(options, stateDir));
  return {
    cwd: options.cwd,
    stateDir,
    sessionId: profile.sessionId(controller.controller.jobId),
    store: new LocalControlledAgentStateStore({ rootDir: stateDir }),
    profile,
  };
}

function projectControllerProfileInput(
  options: ProjectControllerOptions,
  stateDir: string,
): ProviderControllerProfileInput {
  return {
    stateDir,
    ...(options.mcpServerName === undefined
      ? {}
      : { mcpServerName: options.mcpServerName }),
    ...(options.mcpCommand === undefined
      ? {}
      : { mcpCommand: options.mcpCommand }),
    ...(options.mcpArgs === undefined ? {} : { mcpArgs: options.mcpArgs }),
    ...(options.mcpCwd === undefined
      ? {}
      : { mcpCwd: resolvePath(options.cwd, options.mcpCwd) }),
    ...(options.rawShellMode === undefined
      ? {}
      : { rawShellMode: options.rawShellMode }),
  };
}

export function projectControllerLaunchInput(
  controller: {
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
  },
  state: {
    readonly sessionId: string;
    readonly stateDir: string;
  },
  profile: ProjectControllerProfile,
) {
  return buildControlledAgentLaunchPlan({
    controllerJobId: controller.controller.jobId,
    sessionId: state.sessionId,
    stateDir: state.stateDir,
    boundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: controller.scope,
    provider: profile.enforcement,
    networkAccess: NetworkAccessMode.Restricted,
  });
}
