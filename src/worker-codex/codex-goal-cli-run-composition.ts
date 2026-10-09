import type { RunCommand } from "./codex-goal-cli";
import type { CodexGoalRunDeps } from "./codex-goal-runner";
import type { buildCodexGoalCliLaunchInput } from "./hosted-readonly-lifecycle-cli";
import { isHostedGoalLaunch } from "./hosted-readonly-goal-launch";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";

export function assertInProcessRunComposition(command: RunCommand, deps: CodexGoalRunDeps | undefined, launchInput: () => ReturnType<typeof buildCodexGoalCliLaunchInput>): void {
  const hasStorageData = command.config.storage !== undefined || command.config.sessionHomeProfile !== undefined;
  if (!hasTrustedRunDeps(deps) && !hasStorageData) return;
  // Refuse before builders/lifecycle can lose NEW data or trusted ports.
  if (command.lifecycle || (command.tmuxSession && !(command.dryRun || command.printCommand))) {
    throw new Error("codex_goal_cli_trusted_run_process_boundary_unsupported");
  }
  if (command.dryRun || command.printCommand) {
    assertStorageCommandSerializationSupported(command);
    return;
  }
  assertStorageRegistrySupported(command);
  if (isHostedGoalLaunch(launchInput()) && !isHostedOrdinaryRuntime()) {
    throw new Error("codex_goal_cli_trusted_run_process_boundary_unsupported");
  }
  // Actual routing still verifies private ordinary origin; this adds no authority.
}

export function hasTrustedRunDeps(deps: CodexGoalRunDeps | undefined): boolean {
  if (deps === undefined) return false;
  // Empty plain composition is legacy; a prototype may carry inherited authority.
  return Reflect.ownKeys(deps).length > 0 ||
    (Object.getPrototypeOf(deps) !== Object.prototype && Object.getPrototypeOf(deps) !== null);
}

export function assertStorageCommandSerializationSupported(command: RunCommand): void {
  if (command.config.storage !== undefined || command.config.sessionHomeProfile !== undefined) {
    throw new Error("codex_goal_cli_storage_preview_unsupported");
  }
}

export function assertStorageRegistrySupported(command: RunCommand): void {
  if (command.registryRootDir !== undefined &&
      (command.config.storage !== undefined || command.config.sessionHomeProfile !== undefined)) {
    throw new Error("codex_goal_cli_storage_registry_unsupported");
  }
}
