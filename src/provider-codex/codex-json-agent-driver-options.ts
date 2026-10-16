import type { AppServerExecutionLifetime } from "./codex-app-server-execution-engine";
import type { HostedMimoCapacityRecoveryBinder } from "./hosted-mimo-coding-proxy-material";
import type {
  CodexExecutionEngine,
  CodexReasoningEffort,
  CodexServiceTier,
} from "./codex-json-execution-engine";
import type { CodexSessionMaterializer } from "./codex-session-materializer";
import type { CodexModelBackend } from "./codex-model-backend";

/** Trusted driver configuration. Runtime admission and credential authority stay with their original producers. */
type CodexJsonAgentDriverBaseOptions = {
  /** Trusted owned-worker storage port. It grants no credential authority. */
  readonly mimoHomeLifecycle?: {
    prepareHome(codexHome: string): Promise<void>;
    retainHome(codexHome: string): Promise<void>;
  };
  readonly assertProviderAdmission?: () => void;
  /** Source-only binding before the hosted Coding proxy can listen or dispatch. */
  readonly bindMimoCapacityRecoveryCredential?: HostedMimoCapacityRecoveryBinder;
  readonly executionLifetime?: AppServerExecutionLifetime;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly warmupPrompt?: string;
  readonly sessionMaterializer?: CodexSessionMaterializer;
  readonly outputSchemas?: Readonly<Record<string, unknown>>;
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior is unchanged. */
  readonly modelBackend?: CodexModelBackend;
  /** Env var holding the MiMo Token Plan key. Only read when `modelBackend` is `XiaomiMimoTokenPlan`. */
  readonly mimoApiKeyEnvVarName?: string;
  /**
   * Optional generated CODEX_HOME config for MiMo's no-session path. This is
   * how bounded MCP-only workspace tool profiles reach the MiMo adapter
   * without routing API-key material through the ChatGPT session store.
   */
  readonly mimoConfigToml?: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export type CodexJsonAgentDriverOptions = CodexJsonAgentDriverBaseOptions &
  (
    | {
        readonly engine: CodexExecutionEngine;
      }
    | {
        readonly codexBinaryPath: string;
        readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
        readonly timeoutMs?: number;
      }
  );
