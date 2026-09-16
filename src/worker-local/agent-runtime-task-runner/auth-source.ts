import {
  AgentRuntimeTaskProvider,
  AuthSourceKind,
  type AgentRuntimeAuthSource,
} from "../../agent-runtime-task-runner/domain";

export type LocalAgentRuntimeTaskRunnerAuthSource = AgentRuntimeAuthSource;

export function authSourceForProvider(input: {
  readonly provider: AgentRuntimeTaskProvider;
  readonly authSource: LocalAgentRuntimeTaskRunnerAuthSource | undefined;
}): LocalAgentRuntimeTaskRunnerAuthSource | undefined {
  if (input.authSource === undefined) return undefined;
  assertAuthSourceMatchesProvider(input.provider, input.authSource);
  return input.authSource;
}

function assertAuthSourceMatchesProvider(
  provider: AgentRuntimeTaskProvider,
  authSource: LocalAgentRuntimeTaskRunnerAuthSource,
): void {
  if (authSource.kind === AuthSourceKind.PreseededSession) return;
  if (
    provider === AgentRuntimeTaskProvider.Claude &&
    authSource.kind === AuthSourceKind.ClaudeOAuthToken
  ) return;
  if (
    provider === AgentRuntimeTaskProvider.Codex &&
    authSource.kind === AuthSourceKind.CodexAuthJsonFile
  ) return;
  throw new Error(`${authSource.kind} auth source cannot be used with ${provider}`);
}
