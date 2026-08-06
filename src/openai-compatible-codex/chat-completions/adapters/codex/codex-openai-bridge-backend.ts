import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentProvider,
  AuthSessionStatus,
  CodexAuthJsonReader,
} from "@vioxen/agent-account-observability";
import { DefaultRedactor } from "../../../../core/index.js";
import {
  CodexAppServerExecutionEngine,
  classifyCodexRuntimeFailure,
  codexProviderEgressEnv,
  type CodexMaterializedSession,
  type CodexReasoningEffort,
  type CodexServiceTier,
  type CodexAppServerProcessFactory,
  resolveCodexExecutionProfile,
} from "../../../../provider-codex/index.js";
import { NodeProcessRunner } from "../../../../worker-local/index.js";
import {
  OpenAiBridgeErrorCode,
  OpenAiBridgeRequestError,
  type OpenAiBridgeUsage,
} from "../../domain/openai-chat-contracts.js";
import {
  assertExactJsonSchemaOutput,
  responseFormatIdentity,
  snapshotJsonSchemaResponseFormat,
} from "../../domain/response-format-policy.js";
import type {
  OpenAiBridgeChatBackend,
  OpenAiBridgeChatBackendInput,
  OpenAiBridgeChatBackendResult,
} from "../../ports/chat-backend-port.js";
import { openAiBridgeRuntimeAttestationCanonicalBytes } from "../../domain/runtime-attestation.js";
import { NodeHmacRuntimeAttestationSigner } from "../crypto/node-hmac-runtime-attestation-signer.js";
import {
  discoverCodexBridgeAccounts,
  seedIsolatedBridgeAccount,
  type CodexOpenAiBridgeAccount,
  type IsolatedCodexOpenAiBridgeAccount,
} from "./codex-account-isolation.js";

export { discoverCodexBridgeAccounts, type CodexOpenAiBridgeAccount };

const codexOpenAiBridgeExecutionProfile = "stateless-completion" as const;
const codexOpenAiBridgeModelProvider = "openai" as const;
const resolvedCodexOpenAiBridgeExecutionProfile = resolveCodexExecutionProfile(
  codexOpenAiBridgeExecutionProfile,
);
const codexOpenAiBridgeBaseInstructionsSha256 = createHash("sha256")
  .update(
    resolvedCodexOpenAiBridgeExecutionProfile.baseInstructions ?? "",
    "utf8",
  )
  .digest("hex");

export type CodexOpenAiBridgeBackendOptions = {
  readonly codexBinaryPath: string;
  readonly authRootDir: string;
  readonly stateDir: string;
  readonly accountNames?: readonly string[];
  readonly timeoutMs: number;
  readonly quotaCooldownMs: number;
  readonly maxAccountCycles: number;
  readonly maxConcurrentRequests: number;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly attestationSecret: string;
  readonly processFactory?: CodexAppServerProcessFactory;
};

type AccountState = CodexOpenAiBridgeAccount &
  IsolatedCodexOpenAiBridgeAccount & {
    cooldownUntilMs: number;
  };

type RequestWaiter = {
  readonly grant: () => void;
  readonly reject: (error: Error) => void;
};

export class CodexOpenAiBridgeBackend implements OpenAiBridgeChatBackend {
  private readonly runner = new NodeProcessRunner();
  private readonly redactor = new DefaultRedactor();
  private readonly engine: CodexAppServerExecutionEngine;
  private readonly authReader = new CodexAuthJsonReader();
  private readonly attestationSigner: NodeHmacRuntimeAttestationSigner;
  private readonly ready: Promise<void>;
  private accounts: AccountState[] = [];
  private nextAccountIndex = 0;
  private activeRequests = 0;
  private readonly waiters: RequestWaiter[] = [];
  private disposeInFlight: Promise<void> | null = null;
  private terminal = false;

  constructor(private readonly options: CodexOpenAiBridgeBackendOptions) {
    if (Buffer.byteLength(options.attestationSecret, "utf8") < 32) {
      throw new Error("openai_bridge_attestation_secret_required");
    }
    this.engine = new CodexAppServerExecutionEngine({
      codexBinaryPath: options.codexBinaryPath,
      timeoutMs: options.timeoutMs,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      cleanThreadPrewarm: false,
      nativeToolSurface: "disabled",
      executionProfile: codexOpenAiBridgeExecutionProfile,
      attestationMode: "provider-receipt",
      ...(options.processFactory === undefined
        ? {}
        : { processFactory: options.processFactory }),
    });
    this.attestationSigner = new NodeHmacRuntimeAttestationSigner(
      options.attestationSecret,
    );
    this.ready = this.loadAccounts();
  }

  async complete(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult> {
    this.assertActive();
    await this.ready;
    this.assertActive();
    await this.acquireRequestSlot(input.abortSignal);
    try {
      this.assertActive();
      return await this.runWithAccounts(input);
    } finally {
      this.releaseRequestSlot();
    }
  }

  health(): {
    readonly accountCount: number;
    readonly activeRequests: number;
    readonly queuedRequests: number;
  } {
    return {
      accountCount: this.accounts.length,
      activeRequests: this.activeRequests,
      queuedRequests: this.waiters.length,
    };
  }

  dispose(): Promise<void> {
    if (!this.disposeInFlight) {
      this.terminal = true;
      this.rejectWaiters();
      const engineDisposal = this.engine.dispose();
      this.disposeInFlight = Promise.all([
        this.ready.catch(() => undefined),
        engineDisposal,
      ]).then(() => undefined);
    }
    return this.disposeInFlight;
  }

  forceDispose(): void {
    void this.dispose();
    this.engine.forceDispose();
  }

  private async loadAccounts(): Promise<void> {
    const discovered = await discoverCodexBridgeAccounts({
      authRootDir: this.options.authRootDir,
      ...(this.options.accountNames === undefined
        ? {}
        : { accountNames: this.options.accountNames }),
    });
    if (discovered.length === 0) {
      throw new OpenAiBridgeRequestError(
        "No Codex accounts are available for the OpenAI-compatible bridge.",
        OpenAiBridgeErrorCode.ProviderUnavailable,
        503,
      );
    }
    await mkdir(join(this.options.stateDir, "workspace"), {
      recursive: true,
      mode: 0o700,
    });
    this.accounts = await Promise.all(
      discovered.map(async (account) => ({
        ...account,
        ...(await seedIsolatedBridgeAccount({
          stateDir: this.options.stateDir,
          account,
        })),
        cooldownUntilMs: 0,
      })),
    );
  }

  private async runWithAccounts(
    input: OpenAiBridgeChatBackendInput,
  ): Promise<OpenAiBridgeChatBackendResult> {
    if (
      input.requestIdentity.configured_codex_model !== input.model ||
      input.requestIdentity.requested_codex_model !== input.model
    ) {
      throw new Error("codex_bridge_configured_model_identity_mismatch");
    }
    const responseFormat = input.responseFormat === undefined
      ? undefined
      : snapshotJsonSchemaResponseFormat(input.responseFormat);
    const responseIdentity = responseFormatIdentity(responseFormat);
    if (
      input.requestIdentity.response_format_type !==
        responseIdentity.response_format_type ||
      input.requestIdentity.response_format_sha256 !==
        responseIdentity.response_format_sha256 ||
      input.requestIdentity.response_schema_sha256 !==
        responseIdentity.response_schema_sha256
    ) {
      throw new Error("codex_bridge_response_format_identity_mismatch");
    }
    this.assertActive();
    const maxAttempts = Math.max(
      1,
      this.accounts.length * Math.max(1, this.options.maxAccountCycles),
    );
    let lastFailure: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.assertActive();
      const account = this.nextAvailableAccount();
      if (!account) break;
      try {
        const accountBinding = await this.readAccountBinding(account);
        this.assertActive();
        const result = await this.engine.run({
          runId: input.requestId,
          prompt: input.prompt,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          session: this.materializedSessionFor(account, accountBinding),
          workspacePath: join(this.options.stateDir, "workspace"),
          runner: this.runner,
          redactor: this.redactor,
          model: input.model,
          reasoningEffort: this.options.reasoningEffort,
          ...(this.options.serviceTier === undefined
            ? {}
            : { serviceTier: this.options.serviceTier }),
          ...(responseFormat === undefined
            ? {}
            : { outputSchema: responseFormat.json_schema.schema }),
          sandboxMode: "read-only",
          abortSignal: input.abortSignal,
        });
        this.assertActive();
        const postRunAccountBinding = await this.readAccountBinding(account);
        this.assertActive();
        if (!safeHexEqual(accountBinding, postRunAccountBinding)) {
          throw new Error("codex_bridge_auth_subject_changed");
        }
        if (result.status === "waiting_for_input") {
          throw new Error("codex_app_server_unexpected_waiting_for_input");
        }
        const receipt = result.executionReceipt;
        if (receipt?.kind !== "app-server") {
          throw new Error("codex_app_server_execution_receipt_missing");
        }
        if (receipt.model !== input.model) {
          throw new Error("codex_bridge_effective_model_mismatch");
        }
        if (receipt.modelProvider !== codexOpenAiBridgeModelProvider) {
          throw new Error("codex_bridge_effective_model_provider_mismatch");
        }
        if (responseFormat !== undefined) {
          assertExactJsonSchemaOutput(result.outputText, responseFormat);
        }
        const usage = observedUsage(result.usage);
        const runtimeSelection = {
          account_binding_hmac_sha256: accountBinding,
          thread_id: receipt.threadId,
          turn_id: receipt.turnId,
          model: receipt.model,
          model_provider: receipt.modelProvider,
          reasoning_effort: receipt.reasoningEffort,
          service_tier: receipt.serviceTier ?? "default",
          execution_profile: codexOpenAiBridgeExecutionProfile,
          base_instructions_sha256:
            codexOpenAiBridgeBaseInstructionsSha256,
        } as const;
        const outputIdentity = {
          output_text_sha256: createHash("sha256")
            .update(result.outputText, "utf8")
            .digest("hex"),
          terminal_status: "completed",
        } as const;
        return {
          text: result.outputText,
          model: receipt.model,
          usage,
          runtimeSelection,
          outputIdentity,
          attestationHmacSha256: this.attestationSigner.sign(
            openAiBridgeRuntimeAttestationCanonicalBytes({
            outputIdentity,
            requestIdentity: input.requestIdentity,
            selection: runtimeSelection,
            usage,
            ...(input.requestedOutputTokenLimit === undefined
              ? {}
              : { requestedOutputTokenLimit: input.requestedOutputTokenLimit }),
            }),
          ),
        };
      } catch (error) {
        lastFailure = error;
        if (!this.shouldRetryWithNextAccount(error)) {
          throw toBridgeProviderError(error);
        }
        account.cooldownUntilMs = Date.now() + this.options.quotaCooldownMs;
      }
    }
    throw toBridgeProviderError(lastFailure);
  }

  private async readAccountBinding(account: AccountState): Promise<string> {
    const auth = await this.authReader.readAuthSession({
      account: {
        provider: AgentProvider.Codex,
        slotId: account.name,
        authHome: account.codexHome,
        authJsonPath: join(account.codexHome, "auth.json"),
      },
      now: new Date(),
    });
    const subject = auth.identity?.providerAccountId;
    if (auth.status !== AuthSessionStatus.Authenticated || !subject) {
      throw new Error("codex_bridge_auth_subject_unavailable");
    }
    return createHmac("sha256", this.options.attestationSecret)
      .update("subscription-runtime-codex-subject-v1\0", "utf8")
      .update(subject, "utf8")
      .digest("hex");
  }

  private materializedSessionFor(
    account: AccountState,
    accountBinding: string,
  ): CodexMaterializedSession {
    return {
      home: account.home,
      codexHome: account.codexHome,
      sessionHash: accountBinding,
      env: {
        HOME: account.home,
        CODEX_HOME: account.codexHome,
        ...codexProviderEgressEnv(),
      },
      release: async () => {},
    };
  }

  private nextAvailableAccount(): AccountState | null {
    const now = Date.now();
    for (let offset = 0; offset < this.accounts.length; offset += 1) {
      const index = (this.nextAccountIndex + offset) % this.accounts.length;
      const account = this.accounts[index];
      if (!account || account.cooldownUntilMs > now) continue;
      this.nextAccountIndex = (index + 1) % this.accounts.length;
      return account;
    }
    return null;
  }

  private shouldRetryWithNextAccount(error: unknown): boolean {
    if (errorMessage(error) === "codex_bridge_auth_subject_changed") return false;
    const code = classifyCodexRuntimeFailure(errorMessage(error));
    return (
      code === "quota_limited" ||
      code === "needs_reconnect" ||
      code === "provider_session_invalid" ||
      code === "unknown_auth_state" ||
      code === "permission_required"
    );
  }

  private async acquireRequestSlot(abortSignal: AbortSignal): Promise<void> {
    this.assertActive();
    if (this.activeRequests < this.options.maxConcurrentRequests) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: RequestWaiter = {
        grant: () => {
          cleanup();
          this.assertActive();
          this.activeRequests += 1;
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => waiter.reject(new Error("openai_bridge_request_aborted"));
      const cleanup = () => {
        abortSignal.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      this.waiters.push(waiter);
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseRequestSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.waiters.shift();
    if (next) next.grant();
  }

  private rejectWaiters(): void {
    const waiters = this.waiters.splice(0);
    const error = bridgeDisposedError();
    for (const waiter of waiters) waiter.reject(error);
  }

  private assertActive(): void {
    if (this.terminal) throw bridgeDisposedError();
  }
}

function bridgeDisposedError(): OpenAiBridgeRequestError {
  return new OpenAiBridgeRequestError(
    "OpenAI-compatible Codex bridge is shutting down.",
    OpenAiBridgeErrorCode.ProviderUnavailable,
    503,
  );
}

function observedUsage(usage: {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
} | undefined): OpenAiBridgeUsage {
  if (
    usage === undefined ||
    !isObservedTokenCount(usage.inputTokens) ||
    !isObservedTokenCount(usage.cachedInputTokens) ||
    (usage.cacheWriteInputTokens !== undefined &&
      !isObservedTokenCount(usage.cacheWriteInputTokens)) ||
    !isObservedTokenCount(usage.outputTokens) ||
    !isObservedTokenCount(usage.reasoningOutputTokens) ||
    !isObservedTokenCount(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    usage.cachedInputTokens > usage.inputTokens ||
    usage.reasoningOutputTokens > usage.outputTokens
  ) {
    throw new Error("codex_json_turn_usage_missing_or_invalid");
  }
  return {
    prompt_tokens: usage.inputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedInputTokens,
      ...(usage.cacheWriteInputTokens === undefined
        ? {}
        : { cache_write_tokens: usage.cacheWriteInputTokens }),
    },
    completion_tokens: usage.outputTokens,
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens,
    },
    total_tokens: usage.totalTokens,
  };
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function isObservedTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toBridgeProviderError(error: unknown): OpenAiBridgeRequestError {
  const code = classifyCodexRuntimeFailure(errorMessage(error));
  const httpStatus = code === "quota_limited" ? 429 : 503;
  return new OpenAiBridgeRequestError(
    `Codex bridge provider failed: ${code}`,
    OpenAiBridgeErrorCode.ProviderUnavailable,
    httpStatus,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
