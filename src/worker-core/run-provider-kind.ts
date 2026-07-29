export enum RunEventProviderKind {
  Codex = "codex",
  Claude = "claude",
  Local = "local",
  AgentRuntimeTask = "agent-runtime-task",
  Unknown = "unknown",
}

export function runEventProviderKindFromString(value: string): RunEventProviderKind {
  switch (value) {
    case RunEventProviderKind.Codex:
      return RunEventProviderKind.Codex;
    case RunEventProviderKind.Claude:
      return RunEventProviderKind.Claude;
    case RunEventProviderKind.Local:
      return RunEventProviderKind.Local;
    case RunEventProviderKind.AgentRuntimeTask:
      return RunEventProviderKind.AgentRuntimeTask;
    default:
      return RunEventProviderKind.Unknown;
  }
}

export function isRunEventProviderKind(value: string): value is RunEventProviderKind {
  return Object.values(RunEventProviderKind).includes(value as RunEventProviderKind);
}
