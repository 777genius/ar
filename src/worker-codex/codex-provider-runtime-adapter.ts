import { admitHostedControllerLaunch } from "./hosted-readonly-controller-admission";
import { withControlledAgentEgress } from "./controlled-agent/codex-controlled-agent-profile";
import { createCodexGoalObservationContext } from "./application/codex-goal-observation-context";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionArtifact } from "@vioxen/subscription-runtime/core";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import {
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
import {
  buildCodexControlledAgentProfile,
  CodexControlledAgentProvider,
  type CodexControlledAgentProfile,
} from "./controlled-agent";
import { CodexRunObservationAdapter } from "./codex-run-observation";
import {
  failedRunObservationSnapshot,
  observeOrphanCodexRun,
} from "./codex-goal-mcp-observation-projection";
import type { AgentRunWatchMcpArgs } from "./codex-goal-mcp-inputs";
import { listCodexGoalAccountStatuses, type CodexGoalLaunchInput } from "./codex-goal-ops";
import { codexGoalStateRootDir } from "./application/codex-goal-worker-control";
import {
  selectProjectControllerCodexAccountSlot,
} from "./application/project-control/codex-goal-project-controller-account-selection";
import type { ProjectControllerOptions } from "./application/project-control/codex-goal-project-controller-options";

type JsonObject = Readonly<Record<string, unknown>>;

const defaultStaleAfterMs = 10 * 60_000;
const defaultTailLines = 20;

/** Codex `ProviderRuntimeAdapter`: wraps the existing Codex profile, provider and observation building blocks. */
export function createCodexProviderRuntimeAdapter(): ProviderRuntimeAdapter {
  return new CodexProviderRuntimeAdapter();
}

class CodexProviderRuntimeAdapter implements ProviderRuntimeAdapter {
  readonly kind = RunEventProviderKind.Codex;

  observation(input: ProviderRunObservationInput): ProviderRunObservation {
    const registryRootDir = input.registryRootDir;
    const staleAfterMs = input.staleAfterMs ?? defaultStaleAfterMs;
    const tailLines = input.tailLines ?? defaultTailLines;
    const adapter = new CodexRunObservationAdapter({
      observationContext: createCodexGoalObservationContext(),
      registryRootDir,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
      ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
    });
    return {
      responseLocator: { registryRootDir },
      listRunIds: () => adapter.listRunIds(),
      observeRun: (request) => adapter.observeRun(request),
      observeFailedRun: async ({ runId, error }) => {
        const orphan = await observeOrphanCodexRun({
          runId,
          error,
          args: {
            ...(input.runArtifactsRootDir === undefined
              ? {}
              : { runArtifactsRootDir: input.runArtifactsRootDir }),
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            includeLogTail: input.includeLogTail,
          } as AgentRunWatchMcpArgs,
          providerKind: RunEventProviderKind.Codex,
          staleAfterMs,
          tailLines,
        });
        if (orphan) return orphan;
        return failedRunObservationSnapshot({
          runId,
          providerKind: RunEventProviderKind.Codex,
          error,
        });
      },
    };
  }

  controllerProfile(
    input: ProviderControllerProfileInput,
  ): ProviderControllerProfile {
    const profile = buildCodexControlledAgentProfile({
      stateDir: input.stateDir,
      ...(input.mcpServerName === undefined ? {} : { mcpServerName: input.mcpServerName }),
      ...(input.mcpCommand === undefined ? {} : { mcpCommand: input.mcpCommand }),
      ...(input.mcpArgs === undefined ? {} : { mcpArgs: input.mcpArgs }),
      ...(input.mcpCwd === undefined ? {} : { mcpCwd: input.mcpCwd }),
      rawShellMode: input.rawShellMode ?? "disabled-by-provider",
    });
    return codexControllerProfile(profile);
  }

  async controlledAgentProvider(
    input: ProviderControlledAgentInput,
  ): Promise<ProviderControlledAgentResult> {
    const launch = input.launch as CodexGoalLaunchInput;
    const options = input.controllerOptions as ProjectControllerOptions;
    if (!input.scope.authRoot) throw new Error("project_control_controller_auth_root_scope_required");
    if (resolve(launch.config.authRootDir) !== resolve(input.scope.authRoot)) {
      throw new Error("project_control_controller_auth_root_outside_scope");
    }
    const admitted = await admitHostedControllerLaunch(launch);
    const profile = withControlledAgentEgress(input.profile.rawProfile as CodexControlledAgentProfile, admitted.policy);
    const account = await controlledAgentCodexAccount({
      scope: input.scope,
      launch,
    });
    const controllerObjective = await input.controllerObjective();
    return {
      provider: new CodexControlledAgentProvider({
        profile,
        processFactory: admitted.processFactory,
        sourceEnv: launch.config.sourceEnv ?? process.env,
        sessionArtifact: account.sessionArtifact,
        workspacePath: launch.config.workspacePath,
        codexBinaryPath: launch.config.codexBinaryPath ?? "codex",
        controllerObjective,
        controllerRegistryRootDir: input.registryRootDir,
        ...(launch.config.model === undefined ? {} : { model: launch.config.model }),
        ...(launch.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: launch.config.reasoningEffort }),
        ...(launch.config.serviceTier === undefined
          ? {}
          : { serviceTier: launch.config.serviceTier }),
        ...(options.maxGoalTurns === undefined
          ? {}
          : { maxGoalTurns: options.maxGoalTurns }),
      }),
      account: {
        name: account.name,
        ...(account.authJsonSha256Prefix === undefined
          ? {}
          : { authJsonSha256Prefix: account.authJsonSha256Prefix }),
      },
      safeMessage:
        "Codex broker-only controlled-agent provider started with native app-server environments disabled.",
    };
  }
}

function codexControllerProfile(
  profile: CodexControlledAgentProfile,
): ProviderControllerProfile {
  return {
    kind: RunEventProviderKind.Codex,
    enforcement: profile.enforcement,
    allowedTools: () => profile.enabledTools,
    sessionId: (controllerJobId) => `${controllerJobId}:controlled-agent`,
    readyJson: (): JsonObject => ({
      allowedTools: profile.enabledTools,
      codexHome: profile.codexHome,
      configToml: profile.configToml,
      rulesText: profile.rulesText,
    }),
    rawProfile: profile,
  };
}

async function controlledAgentCodexAccount(input: {
  readonly scope: ProjectAccessScope;
  readonly launch: CodexGoalLaunchInput;
}): Promise<{
  readonly name: string;
  readonly authJsonSha256Prefix?: string;
  readonly sessionArtifact: SessionArtifact;
}> {
  if (!input.scope.authRoot) {
    throw new Error("project_control_controller_auth_root_scope_required");
  }
  if (resolve(input.launch.config.authRootDir) !== resolve(input.scope.authRoot)) {
    throw new Error("project_control_controller_auth_root_outside_scope");
  }
  const slots = await listCodexGoalAccountStatuses({
    authRootDir: input.launch.config.authRootDir,
    accounts: input.launch.config.accounts.map((account) => account.name),
    stateRootDir: codexGoalStateRootDir(input.launch),
  });
  const selected = selectProjectControllerCodexAccountSlot({
    slots,
    allowedAccountIds: input.scope.allowedAccountIds,
  });
  if (!selected) {
    throw new Error("project_control_controller_no_available_account");
  }
  const authJsonBytes = await readFile(selected.authJsonPath, "utf8");
  return {
    name: selected.name,
    ...(selected.authJsonSha256Prefix === undefined
      ? {}
      : { authJsonSha256Prefix: selected.authJsonSha256Prefix }),
    sessionArtifact: sessionArtifactFromCodexAuthJson(authJsonBytes),
  };
}
