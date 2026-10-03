import { AuthSourceKind } from "../../agent-runtime-task-runner/domain";
import { AgentRuntimeTaskProvider, type ProviderName, type AgentRuntimeTaskWorker } from "./ports";
import type { LocalAgentRuntimeTaskRunnerAuthSource } from "./auth-source";

export async function seedWorker(input: {
  readonly provider: ProviderName;
  readonly authSource: LocalAgentRuntimeTaskRunnerAuthSource | undefined;
  readonly worker: AgentRuntimeTaskWorker;
}): Promise<void> {
  if (
    input.authSource === undefined ||
    input.authSource.kind === AuthSourceKind.PreseededSession
  ) {
    return;
  }
  if (input.provider === AgentRuntimeTaskProvider.Claude) {
    if (input.authSource.kind === AuthSourceKind.ClaudeOAuthToken) {
      if (!input.worker.seedClaudeOAuth) {
        throw new Error("selected worker does not support Claude OAuth seeding");
      }
      await input.worker.seedClaudeOAuth({ oauthToken: input.authSource.oauthToken });
      return;
    }
    if (input.authSource.kind === AuthSourceKind.ClaudeAmbientHome) {
      if (!input.worker.seedClaudeAmbientHome) {
        throw new Error("selected worker does not support Claude ambient-home seeding");
      }
      await input.worker.seedClaudeAmbientHome({
        homeDir: input.authSource.homeDir,
        ...(input.authSource.configDir === undefined
          ? {}
          : { configDir: input.authSource.configDir }),
      });
      return;
    }
    throw new Error(
      "Claude agent runtime requires a claude-oauth-token or claude-ambient-home auth source",
    );
  }

  if (
    input.authSource.kind !==
    AuthSourceKind.CodexAuthJsonFile
  ) {
    throw new Error("Codex agent runtime requires a codex-auth-json-file auth source");
  }
  if (!input.worker.seedCodexAuthJsonFile) {
    throw new Error("selected worker does not support Codex auth seeding");
  }
  await input.worker.seedCodexAuthJsonFile(input.authSource.path);
}
