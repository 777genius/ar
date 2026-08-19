import type {
  AgentRuntimeTaskRequest,
  AgentRuntimeTaskRequestV1,
  AgentRuntimeTaskRequestV2,
  AgentRuntimeTaskRequestV3,
  AgentRuntimeTaskResult,
  AgentRuntimeTaskResultV1,
  AgentRuntimeTaskResultV2,
  AgentRuntimeTaskResultV3,
} from "@vioxen/subscription-runtime/agent-runtime-task";

export enum AgentRuntimeTaskProvider {
  Claude = "claude",
  Codex = "codex",
}

export enum AuthSourceKind {
  ClaudeOAuthToken = "claude-oauth-token",
  CodexAuthJsonFile = "codex-auth-json-file",
  PreseededSession = "preseeded-session",
}

export enum ClaudeAgentRuntimeBackend {
  AgentSdk = "agent-sdk",
  Background = "claude-background",
}

export enum AgentRuntimeTaskReasoningEffort {
  High = "high",
}

export enum AgentRuntimeTaskServiceTier {
  Default = "default",
}

export function assertAgentRuntimeTaskExecutionProfile(
  provider: AgentRuntimeTaskProvider,
  profile: {
    readonly reasoningEffort?: unknown;
    readonly serviceTier?: unknown;
  },
): void {
  if (provider !== AgentRuntimeTaskProvider.Codex) {
    if (profile.reasoningEffort !== undefined || profile.serviceTier !== undefined) {
      throw new Error("Codex execution options cannot be used with another provider");
    }
    return;
  }
  if (
    profile.reasoningEffort !== undefined &&
    profile.reasoningEffort !== AgentRuntimeTaskReasoningEffort.High
  ) throw new Error("reasoningEffort must be high");
  if (
    profile.serviceTier !== undefined &&
    profile.serviceTier !== AgentRuntimeTaskServiceTier.Default
  ) throw new Error("serviceTier must be default");
}

export type AgentRuntimeTaskRunnerRunOptions = {
  readonly signal?: AbortSignal;
};

export type AgentRuntimeTaskRunner = {
  run(
    request: AgentRuntimeTaskRequestV1,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResultV1>;
  run(
    request: AgentRuntimeTaskRequestV2,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResultV2>;
  run(
    request: AgentRuntimeTaskRequestV3,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResultV3>;
  run(
    request: AgentRuntimeTaskRequest,
    options?: AgentRuntimeTaskRunnerRunOptions,
  ): Promise<AgentRuntimeTaskResult>;
  dispose(): Promise<void>;
};

export type ClaudeAgentRuntimeAuthSource =
  | {
      readonly kind: AuthSourceKind.ClaudeOAuthToken;
      readonly oauthToken: string;
    }
  | {
      readonly kind: AuthSourceKind.PreseededSession;
    };

export type CodexAgentRuntimeAuthSource =
  | {
      readonly kind: AuthSourceKind.CodexAuthJsonFile;
      readonly path: string;
    }
  | {
      readonly kind: AuthSourceKind.PreseededSession;
    };

export type AgentRuntimeAuthSource =
  | ClaudeAgentRuntimeAuthSource
  | CodexAgentRuntimeAuthSource;

export type ClaudeAgentRuntimeConfig =
  | {
      readonly backend?: ClaudeAgentRuntimeBackend.AgentSdk;
      readonly binaryPath?: string;
    }
  | {
      readonly backend: ClaudeAgentRuntimeBackend.Background;
      readonly binaryPath?: string;
      readonly runtimeDistDir?: string;
    };

export type CodexAgentRuntimeConfig = {
  readonly binaryPath?: string;
  readonly reasoningEffort?: AgentRuntimeTaskReasoningEffort;
  readonly serviceTier?: AgentRuntimeTaskServiceTier;
};

type LocalAgentRuntimeTaskRunnerCommonInput = {
  readonly stateRootDir: string;
  readonly encryptionKey: Uint8Array | string;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly onDisposeError?: (message: string) => void;
};

export type CreateLocalAgentRuntimeTaskRunnerInput =
  LocalAgentRuntimeTaskRunnerCommonInput &
    (
      | {
          readonly provider: AgentRuntimeTaskProvider.Claude;
          readonly authSource?: ClaudeAgentRuntimeAuthSource;
          readonly providerRuntime?: ClaudeAgentRuntimeConfig;
        }
      | {
          readonly provider: AgentRuntimeTaskProvider.Codex;
          readonly authSource?: CodexAgentRuntimeAuthSource;
          readonly providerRuntime?: CodexAgentRuntimeConfig;
        }
    );
