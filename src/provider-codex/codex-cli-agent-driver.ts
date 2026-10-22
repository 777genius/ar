import {
  assertProviderTaskSystemPrompt,
  type AgentDriver,
  type ProviderFailure,
  type ProviderTask,
  type ProviderTaskResult,
  type SessionArtifact,
  type WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexAuthJsonFromArtifact } from "./codex-auth-json-codec";
import { pruneCodexChildEnv } from "./codex-cli-domain";
import { cleanupCodexRuntimeTempRoot } from "./codex-cli-temp-cleanup";
import { createCodexRuntimeTempRoot } from "./codex-runtime-temp";
import { composeCodexPrompt } from "./codex-prompt-composer";
import type { CodexReasoningEffort } from "./codex-json-execution-engine";
import { codexSandboxModeForControls } from "./codex-json-execution-engine";
import {
  codexMimoTokenPlanEgressPolicy,
  codexProviderApiEgressPolicy,
  codexProviderEgressConfigToml,
  codexProviderEgressEnv,
} from "./codex-provider-egress-policy";
import {
  codexAgentCapabilities,
  codexAgentId,
  codexProviderId,
  defaultCodexModel,
} from "./capabilities";
import { classifyCodexFailure } from "./failure-classifier";
import {
  CodexApiKeyCredentialMissingError,
  loadCodexApiKeyCredential,
} from "./codex-api-key-credential";
import {
  CodexModelBackend,
  codexMimoApiKeyEnvVarDefault,
  codexModelBackendDefaultModel,
  codexModelBackendModelProvidersConfigToml,
  codexModelBackendModelProviderName,
} from "./codex-model-backend";

export type CodexCliAgentDriverOptions = {
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  /** Defaults to {@link CodexModelBackend.OpenAiChatGpt} — existing behavior is unchanged. */
  readonly modelBackend?: CodexModelBackend;
  /** Env var holding the MiMo Token Plan key. Only read when `modelBackend` is `XiaomiMimoTokenPlan`. */
  readonly mimoApiKeyEnvVarName?: string;
};

export class CodexCliAgentDriver implements AgentDriver {
  readonly agentId = codexAgentId;
  readonly providerId = codexProviderId;
  readonly capabilities = codexAgentCapabilities;

  constructor(private readonly options: CodexCliAgentDriverOptions = {}) {}

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
    readonly redactor: Parameters<AgentDriver["runTask"]>[0]["redactor"];
    readonly abortSignal: AbortSignal;
    readonly onTaskStarted?: () => Promise<void> | void;
  }): Promise<ProviderTaskResult> {
    assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");

    const modelBackend = this.options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
    const { session } = input;

    if (modelBackend === CodexModelBackend.OpenAiChatGpt && !session) {
      return {
        status: "failed",
        failure: {
          code: "provider_session_invalid",
          retryable: false,
          reconnectRequired: true,
          safeMessage: "Codex requires a session artifact.",
        },
        warnings: [],
      };
    }

    let mimoCredential: ReturnType<typeof loadCodexApiKeyCredential> | undefined;
    if (modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
      const envVarName = this.options.mimoApiKeyEnvVarName ?? codexMimoApiKeyEnvVarDefault;
      try {
        mimoCredential = loadCodexApiKeyCredential({
          backend: modelBackend,
          envVarName,
          ...(this.options.sourceEnv === undefined ? {} : { sourceEnv: this.options.sourceEnv }),
          redactor: input.redactor,
        });
      } catch (error) {
        if (error instanceof CodexApiKeyCredentialMissingError) {
          return {
            status: "failed",
            failure: {
              // A missing env key is a local configuration gap, not a dead
              // provider session: provider_session_invalid would disable the
              // shared account capacity record for every later run.
              code: "provider_runtime_unavailable",
              retryable: false,
              reconnectRequired: false,
              safeMessage: `Codex MiMo backend requires ${error.envVarName} to be set.`,
            },
            warnings: [],
          };
        }
        throw error;
      }
    }

    const tempRoot = await createCodexRuntimeTempRoot({
      prefix: "subscription-runtime-codex-",
      sourceEnv: this.options.sourceEnv,
    });
    const tempHome = join(tempRoot, "home");
    const tempCodexHome = join(tempRoot, "codex-home");
    await mkdir(tempHome, { recursive: true, mode: 0o700 });
    await mkdir(tempCodexHome, { recursive: true, mode: 0o700 });

    try {
      const sandboxMode = codexSandboxModeForControls(input.task.controls);
      if (mimoCredential) {
        await writeCodexMimoHomeSnapshot({
          codexHome: tempCodexHome,
          sandboxMode,
          envVarName: mimoCredential.envVarName,
        });
      } else {
        if (!session) {
          throw new Error("codex_cli_agent_driver_missing_session_invariant");
        }
        const authJson = codexAuthJsonFromArtifact(session);
        input.redactor.registerSecret(authJson, "codex-auth-json");
        await writeCodexHomeSnapshot({
          codexHome: tempCodexHome,
          authJson,
          sandboxMode,
        });
      }
      await input.onTaskStarted?.();
      const egressPolicy = mimoCredential
        ? codexMimoTokenPlanEgressPolicy()
        : codexProviderApiEgressPolicy();
      const modelProviderName = codexModelBackendModelProviderName(modelBackend);
      const model = this.options.model ?? codexModelBackendDefaultModel(modelBackend, defaultCodexModel);
      const result = await input.runner.run({
        command: this.options.codexBinaryPath ?? "codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          sandboxMode,
          "--model",
          model,
          ...(modelProviderName === undefined ? [] : [
            "--config", `model_provider=${JSON.stringify(modelProviderName)}`,
          ]),
          ...(this.options.reasoningEffort === undefined ? [] : [
            "--config", `model_reasoning_effort=${JSON.stringify(this.options.reasoningEffort)}`,
          ]),
          // Verified with codex-cli 0.139.0: `codex exec -- -` reads the prompt from stdin.
          "--",
          "-",
        ],
        cwd: input.workspace.path,
        env: {
          ...pruneCodexChildEnv(this.options.sourceEnv ?? process.env),
          HOME: tempHome,
          CODEX_HOME: tempCodexHome,
          ...codexProviderEgressEnv(egressPolicy),
          CI: "true",
          // Injected after pruning: the shared child-env allowlist stays untouched by
          // this provider-specific credential, and config.toml's shell_environment_policy
          // (see writeCodexMimoHomeSnapshot) keeps it out of model-executed shell calls.
          ...(mimoCredential ? { [mimoCredential.envVarName]: mimoCredential.apiKey } : {}),
        },
        stdin: new TextEncoder().encode(
          composeCodexPrompt({
            prompt: input.task.prompt,
            systemPrompt: input.task.systemPrompt,
          }),
        ),
        timeoutMs: this.options.timeoutMs ?? this.capabilities.maxRuntimeMs,
        abortSignal: input.abortSignal,
      });

      const stdout = input.redactor.redact(result.stdout);
      const stderr = input.redactor.redact(result.stderr);
      input.redactor.assertNoKnownSecret(stdout, "codex-agent-stdout");
      input.redactor.assertNoKnownSecret(stderr, "codex-agent-stderr");

      if (result.exitCode !== 0) {
        return {
          status: "failed",
          failure: this.classifyRunFailure({
            exitCode: result.exitCode,
            stdout,
            stderr,
          }),
          warnings: [],
        };
      }

      return {
        status: "completed",
        outputText: stdout,
        warnings: [],
      };
    } finally {
      await cleanupCodexRuntimeTempRoot({ tempRoot, tempCodexHome });
    }
  }

  classifyRunFailure(error: unknown): ProviderFailure {
    return classifyCodexFailure(error);
  }
}

async function writeCodexHomeSnapshot(input: {
  readonly codexHome: string;
  readonly authJson: string;
  readonly sandboxMode: ReturnType<typeof codexSandboxModeForControls>;
}): Promise<void> {
  const config = [
    'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(input.sandboxMode)}`,
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
    codexProviderEgressConfigToml(),
  ].join("\n");
  await writeFile(join(input.codexHome, "config.toml"), config, {
    mode: 0o600,
  });
  await writeFile(join(input.codexHome, "auth.json"), input.authJson, {
    mode: 0o600,
  });
}

/**
 * MiMo is a static API-key credential, not a ChatGPT OAuth session: no
 * `auth.json` is ever written for this backend, and `env_key` reads the key
 * from the child process env this driver injects at spawn time (never from
 * `shell_environment_policy.include_only`, which model-executed shell tool
 * calls can reach).
 *
 * `web_search = "disabled"` is required here — confirmed empirically in the
 * 2026-09-25 Stage 0 smoke test, MiMo's gateway rejects Codex's default
 * web_search tool with `responses_feature_not_supported`.
 */
async function writeCodexMimoHomeSnapshot(input: {
  readonly codexHome: string;
  readonly sandboxMode: ReturnType<typeof codexSandboxModeForControls>;
  readonly envVarName: string;
  readonly baseUrl?: string;
}): Promise<void> {
  const config = [
    'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(input.sandboxMode)}`,
    'web_search = "disabled"',
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
    codexModelBackendModelProvidersConfigToml({
      backend: CodexModelBackend.XiaomiMimoTokenPlan,
      envKeyName: input.envVarName,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    }),
    codexProviderEgressConfigToml(codexMimoTokenPlanEgressPolicy()),
  ].join("\n");
  await writeFile(join(input.codexHome, "config.toml"), config, {
    mode: 0o600,
  });
}
