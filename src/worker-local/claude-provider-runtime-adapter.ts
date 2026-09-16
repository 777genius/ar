import {
  providerFailedRunObservationSnapshot,
  RunEventProviderKind,
  type ProjectAccessScope,
  type ProviderControlledAgentInput,
  type ProviderControlledAgentResult,
  type ProviderControllerProfile,
  type ProviderControllerProfileInput,
  type ProviderRunObservation,
  type ProviderRunObservationInput,
  type ProviderRuntimeAdapter,
} from "@vioxen/subscription-runtime/worker-core";
import type { ClaudeControlledAgentProfile } from "@vioxen/subscription-runtime/worker-claude";
import { ClaudeRunObservationAdapter } from "../worker-claude/claude-run-observation";
import {
  buildLocalClaudeControlledAgentProfile,
  createLocalClaudeControlledAgentProvider,
  loadScopedClaudeSessionArtifact,
  type LoadedClaudeSessionArtifact,
} from "./claude-controlled-agent-local";

type JsonObject = Readonly<Record<string, unknown>>;

// Structural views of the opaque goal launch / controller options payloads, so
// the Claude adapter reads exactly what it needs without depending on the
// worker-codex launch and option types.
type GoalLaunchView = {
  readonly config: {
    readonly workspacePath: string;
    readonly model?: string;
  };
};

type ClaudeControllerOptionsView = {
  readonly claudePath?: string;
  readonly maxGoalTurns?: number;
  readonly sessionArtifactPath?: string;
};

/** Claude `ProviderRuntimeAdapter`: wraps the local Claude profile, provider and observation building blocks. */
export function createClaudeProviderRuntimeAdapter(): ProviderRuntimeAdapter {
  return new ClaudeProviderRuntimeAdapter();
}

class ClaudeProviderRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly kind = RunEventProviderKind.Claude;

  observation(input: ProviderRunObservationInput): ProviderRunObservation {
    const adapter = new ClaudeRunObservationAdapter({
      ...(input.stateRootDir === undefined ? {} : { stateRootDir: input.stateRootDir }),
      ...(input.runArtifactsRootDir === undefined
        ? {}
        : { runArtifactsRootDir: input.runArtifactsRootDir }),
      ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
      ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
    });
    return {
      responseLocator: {
        ...(input.stateRootDir === undefined ? {} : { stateRootDir: input.stateRootDir }),
        ...(input.runArtifactsRootDir === undefined
          ? {}
          : { runArtifactsRootDir: input.runArtifactsRootDir }),
      },
      listRunIds: () => adapter.listRunIds(),
      observeRun: (request) => adapter.observeRun(request),
      observeFailedRun: async ({ runId, error }) =>
        providerFailedRunObservationSnapshot({
          runId,
          providerKind: RunEventProviderKind.Claude,
          error,
        }),
    };
  }

  controllerProfile(
    input: ProviderControllerProfileInput,
  ): ProviderControllerProfile {
    const profile = buildLocalClaudeControlledAgentProfile({
      stateDir: input.stateDir,
      ...(input.mcpServerName === undefined ? {} : { mcpServerName: input.mcpServerName }),
      ...(input.mcpCommand === undefined ? {} : { mcpCommand: input.mcpCommand }),
      ...(input.mcpArgs === undefined ? {} : { mcpArgs: input.mcpArgs }),
      ...(input.mcpCwd === undefined ? {} : { mcpCwd: input.mcpCwd }),
    });
    return claudeControllerProfile(profile);
  }

  async controlledAgentProvider(
    input: ProviderControlledAgentInput,
  ): Promise<ProviderControlledAgentResult> {
    const launch = input.launch as GoalLaunchView;
    const options = input.controllerOptions as ClaudeControllerOptionsView;
    const profile = input.profile.rawProfile as ClaudeControlledAgentProfile;
    const loaded = await controlledAgentClaudeSessionArtifact({
      scope: input.scope,
      options,
      cwd: input.cwd,
    });
    const controllerObjective = await input.controllerObjective();
    return {
      provider: createLocalClaudeControlledAgentProvider({
        profile,
        sessionArtifact: loaded.sessionArtifact,
        workspacePath: launch.config.workspacePath,
        ...(options.claudePath === undefined ? {} : { claudePath: options.claudePath }),
        ...(launch.config.model === undefined ? {} : { model: launch.config.model }),
        ...(options.maxGoalTurns === undefined ? {} : { maxTurns: options.maxGoalTurns }),
        controllerObjective,
      }),
      sessionArtifact: {
        path: loaded.path,
        sha256Prefix: loaded.sha256Prefix,
      },
      safeMessage:
        "Claude broker-only controlled-agent provider started with strict MCP broker tools.",
    };
  }
}

function claudeControllerProfile(
  profile: ClaudeControlledAgentProfile,
): ProviderControllerProfile {
  return {
    kind: RunEventProviderKind.Claude,
    enforcement: profile.enforcement,
    allowedTools: () => profile.allowedTools,
    sessionId: (controllerJobId) =>
      `${controllerJobId}:controlled-agent:${RunEventProviderKind.Claude}`,
    readyJson: (): JsonObject => ({
      allowedTools: profile.allowedTools,
      disallowedTools: profile.disallowedTools,
      configDir: profile.configDir,
      mcpConfig: profile.mcpConfig,
      strictMcpConfig: profile.strictMcpConfig,
      appendSystemPrompt: profile.appendSystemPrompt,
    }),
    rawProfile: profile,
  };
}

async function controlledAgentClaudeSessionArtifact(input: {
  readonly scope: ProjectAccessScope;
  readonly options: ClaudeControllerOptionsView;
  readonly cwd: string;
}): Promise<LoadedClaudeSessionArtifact> {
  if (!input.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  const rawPath = input.options.sessionArtifactPath;
  if (rawPath === undefined) {
    throw new Error("project_control_controller_session_artifact_path_required");
  }
  return loadScopedClaudeSessionArtifact({
    sessionArtifactPath: rawPath,
    authRoot: input.scope.authRoot,
    cwd: input.cwd,
  });
}
