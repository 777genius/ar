import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  type ProcessResult,
  type RunnerPort,
  type RunnerCapabilities,
} from "../../core/index.js";
import {
  OpenAiBridgeChatCompletionUseCase,
  OpenAiBridgeErrorCode,
  OpenAiBridgeObjectKind,
  OpenAiBridgeRequestError,
  OpenAiBridgeResponseFormatType,
  OpenAiBridgeRole,
  CodexOpenAiBridgeBackend,
  openAiBridgeRequestBodySha256,
  parseChatCompletionRequest,
  renderOpenAiBridgeChat,
  startOpenAiBridgeHttpServer,
  type OpenAiBridgeChatBackend,
} from "../index.js";
import {
  PackagedCodexJsonExecutionEngine,
  codexProviderApiEgressProfileId,
  codexProviderEgressProfileEnvVar,
  resolveCodexExecutionProfile,
} from "../../provider-codex/index.js";
import {
  FakeAppServerFactory,
  type FakeAppServerFactoryOptions,
} from "../../provider-codex/app-server/testing/fake-app-server.js";
import { AppServerProviderReceiptTracker } from "../../provider-codex/app-server/application/app-server-provider-receipt-tracker.js";
import { readAppServerThreadExecutionReceipt } from "../../provider-codex/app-server/protocol/app-server-thread-receipt.js";
import { openAiBridgeRuntimeAttestationCanonicalBytes } from "../chat-completions/domain/runtime-attestation.js";
import { responseFormatIdentity } from "../chat-completions/domain/response-format-policy.js";

const attestationSecret = "test-attestation-secret-that-is-at-least-32-bytes";
const locomoJudgeResponseFormat = {
  type: OpenAiBridgeResponseFormatType.JsonSchema,
  json_schema: {
    name: "locomo_judge",
    strict: true,
    schema: {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        label: { type: "string", enum: ["CORRECT", "WRONG"] },
      },
      required: ["reasoning", "label"],
      additionalProperties: false,
    },
  },
} as const;

describe("OpenAI-compatible Codex bridge", () => {
  it("rejects conflicting or invalid output token limits", () => {
    expect(() => parseChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 10,
      max_completion_tokens: 11,
    })).toThrow("max_tokens and max_completion_tokens must match");
    expect(() => parseChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 0,
    })).toThrow("max_completion_tokens must be a positive safe integer");
  });

  it("rejects streaming and tools instead of silently burning provider calls", async () => {
    const useCase = new OpenAiBridgeChatCompletionUseCase({
      backend: {
        async complete() {
          throw new Error("should_not_run_backend");
        },
      },
      publicModel: "subscription-codex",
      codexModel: "gpt-5.5",
    });

    await expect(useCase.complete({
      request: {
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      requestBodySha256: requestBodySha256({ messages: [{ role: "user", content: "hello" }], stream: true }),
      abortSignal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: OpenAiBridgeErrorCode.UnsupportedFeature,
    } satisfies Partial<OpenAiBridgeRequestError>);

    await expect(useCase.complete({
      request: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{}],
      },
      requestBodySha256: requestBodySha256({ messages: [{ role: "user", content: "hello" }], tools: [{}] }),
      abortSignal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: OpenAiBridgeErrorCode.UnsupportedFeature,
    } satisfies Partial<OpenAiBridgeRequestError>);
  });

  it("accepts current Codex item.completed JSON events", async () => {
    const engine = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: "/bin/codex-test",
    });
    const result = await engine.run({
      prompt: "Reply OK",
      session: {
        home: "/tmp/home",
        codexHome: "/tmp/codex-home",
        env: {},
        release: async () => {},
      },
      workspacePath: "/tmp",
      runner: new ItemCompletedRunner(),
      redactor: new DefaultRedactor(),
      model: "gpt-5.5",
      reasoningEffort: "low",
      abortSignal: new AbortController().signal,
    });

    expect(result.outputText).toBe("OK");
    expect(result.usage).toEqual({
      inputTokens: 21,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 3,
      totalTokens: 26,
    });
  });

  it("rejects malformed observed Codex usage", async () => {
    const engine = new PackagedCodexJsonExecutionEngine({
      codexBinaryPath: "/bin/codex-test",
    });
    await expect(engine.run({
      prompt: "Reply OK",
      session: {
        home: "/tmp/home",
        codexHome: "/tmp/codex-home",
        env: {},
        release: async () => {},
      },
      workspacePath: "/tmp",
      runner: new MalformedUsageRunner(),
      redactor: new DefaultRedactor(),
      model: "gpt-5.5",
      reasoningEffort: "low",
      abortSignal: new AbortController().signal,
    })).rejects.toThrow("codex_json_turn_usage_invalid:output_tokens");
  });

  it("retries the next isolated account after an unknown auth state", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-openai-bridge-"));
    const authRoot = join(root, "auth");
    const stateDir = join(root, "state");
    const codexBinaryPath = join(root, "fake-codex");
    const authJson = JSON.stringify({
      tokens: { access_token: "test-token", account_id: "physical-account" },
    });

    try {
      for (const accountName of ["account-a", "account-b"]) {
        const sourceCodexHome = join(authRoot, accountName);
        await mkdir(sourceCodexHome, { recursive: true });
        await writeFile(join(sourceCodexHome, "auth.json"), authJson);
      }
      await writeFile(
        codexBinaryPath,
        [
          "#!/bin/sh",
          "case \"$CODEX_HOME\" in *account-a*) printf '%s\\n' unknown_auth_state >&2; exit 1;; esac",
          "while IFS= read -r _; do :; done",
          "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
          `printf '%s\\n' '${turnCompletedUsageJson()}'`,
        ].join("\n"),
      );
      await chmod(codexBinaryPath, 0o700);

      const backend = new CodexOpenAiBridgeBackend({
        codexBinaryPath,
        authRootDir: authRoot,
        stateDir,
        accountNames: ["account-a", "account-b"],
        timeoutMs: 10_000,
        quotaCooldownMs: 1_000,
        maxAccountCycles: 1,
        maxConcurrentRequests: 1,
        reasoningEffort: "low",
        attestationSecret,
        processFactory: (input) => new FakeAppServerFactory({
          ...(input.env.CODEX_HOME?.endsWith("account-a")
            ? { initializeError: "unknown_auth_state" }
            : {}),
          turnUsage: observedTurnUsage(),
        }).create(input),
      });

      const result = await backend.complete({
        prompt: "Reply OK",
        model: "gpt-5.5",
        requestId: "bridge-retry-test",
        requestIdentity: testRequestIdentity(),
        abortSignal: new AbortController().signal,
      });

      expect(result.text).toBe("app-server output:Reply OK");
      expect(result.usage).toEqual({
        prompt_tokens: 21,
        prompt_tokens_details: {
          cached_tokens: 8,
        },
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 26,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs Codex bridge requests with isolated state CODEX_HOME copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-openai-bridge-"));
    const authRoot = join(root, "auth");
    const sourceCodexHome = join(authRoot, "account-a");
    const stateDir = join(root, "state");
    const capturePath = join(root, "captured-codex-home.txt");
    const envCapturePath = join(root, "captured-provider-egress-profile.txt");
    const codexBinaryPath = join(root, "fake-codex");
    const authJson = JSON.stringify({
      tokens: { access_token: "test-token", account_id: "physical-account-a" },
    });
    let capturedCodexHome = "";
    let capturedEgressProfile = "";

    try {
      await mkdir(join(authRoot, ".not-an-account"), { recursive: true });
      await mkdir(sourceCodexHome, { recursive: true });
      await writeFile(join(sourceCodexHome, "auth.json"), authJson);
      await writeFile(
        codexBinaryPath,
        [
          "#!/bin/sh",
          "( sleep 5; printf '%s\\n' fake_codex_stdin_not_closed >&2; kill $$ ) &",
          "watchdog=$!",
          "while IFS= read -r _; do :; done",
          "kill \"$watchdog\" 2>/dev/null || true",
          `printf '%s\\n' "$CODEX_HOME" > ${JSON.stringify(capturePath)}`,
          `printf '%s\\n' "${codexProviderEgressProfileEnvVar}=$${codexProviderEgressProfileEnvVar}" > ${JSON.stringify(envCapturePath)}`,
          "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}'",
          `printf '%s\\n' '${turnCompletedUsageJson()}'`,
        ].join("\n"),
      );
      await chmod(codexBinaryPath, 0o700);

      const backend = new CodexOpenAiBridgeBackend({
        codexBinaryPath,
        authRootDir: authRoot,
        stateDir,
        accountNames: ["account-a"],
        timeoutMs: 10_000,
        quotaCooldownMs: 1_000,
        maxAccountCycles: 1,
        maxConcurrentRequests: 1,
        reasoningEffort: "low",
        attestationSecret,
        processFactory: (input) => {
          capturedCodexHome = input.env.CODEX_HOME ?? "";
          capturedEgressProfile =
            input.env[codexProviderEgressProfileEnvVar] ?? "";
          return new FakeAppServerFactory({
            turnUsage: observedTurnUsage(),
          }).create(input);
        },
      });

      const result = await backend.complete({
        prompt: "Reply OK",
        model: "gpt-5.5",
        requestId: "bridge-test",
        requestIdentity: testRequestIdentity(),
        abortSignal: new AbortController().signal,
      });

      expect(result.text).toBe("app-server output:Reply OK");
      expect(result.runtimeSelection).toMatchObject({
        account_binding_hmac_sha256: createHmac("sha256", attestationSecret)
          .update("subscription-runtime-codex-subject-v1\0", "utf8")
          .update("physical-account-a", "utf8")
          .digest("hex"),
        model: "gpt-5.5",
        model_provider: "openai",
        thread_id: "thread-1",
        turn_id: "turn-1",
        reasoning_effort: "low",
        service_tier: "default",
      });
      expect(capturedCodexHome).toBe(join(stateDir, "codex-home", "account-a"));
      expect(capturedCodexHome).not.toBe(sourceCodexHome);
      expect(capturedEgressProfile).toBe(codexProviderApiEgressProfileId);
      await expect(readFile(join(capturedCodexHome, "auth.json"), "utf8"))
        .resolves.toBe(authJson);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing usage", {}],
    ["effective model drift", {
      effectiveModel: "gpt-drifted",
      turnUsage: observedTurnUsage(),
    }],
    ["effective model-provider drift", {
      effectiveModelProvider: "not-openai",
      turnUsage: observedTurnUsage(),
    }],
    ["empty effective model provider", {
      effectiveModelProvider: "",
      turnUsage: observedTurnUsage(),
    }],
    ["model reroute", {
      emitModelRerouted: true,
      turnUsage: observedTurnUsage(),
    }],
    ["duplicate terminal usage", {
      duplicateTurnCompletion: true,
      turnUsage: observedTurnUsage(),
    }],
    ["wrong-turn usage", {
      wrongTurnCompletionId: "turn-wrong",
      turnUsage: observedTurnUsage(),
    }],
    ["wrong-thread token usage", {
      wrongTokenUsageThreadId: "thread-wrong",
      turnUsage: observedTurnUsage(),
    }],
    ["wrong-turn token usage", {
      wrongTokenUsageTurnId: "turn-wrong",
      turnUsage: observedTurnUsage(),
    }],
    ["regressing token usage", {
      tokenUsageUpdates: [observedTurnUsage(), earlierTurnUsage()],
    }],
    ["late duplicate terminal", {
      lateDuplicateTurnCompletion: true,
      turnUsage: observedTurnUsage(),
    }],
    ["post-terminal usage", {
      postTerminalTokenUsage: true,
      turnUsage: observedTurnUsage(),
    }],
    ["post-terminal agent message delta", {
      postTerminalAgentMessageDelta: true,
      turnUsage: observedTurnUsage(),
    }],
    ["completion before started", {
      emitTurnCompletionBeforeStarted: true,
      turnUsage: observedTurnUsage(),
    }],
    ["start-response identity mismatch", {
      mismatchTurnStartResponseId: true,
      turnUsage: observedTurnUsage(),
    }],
    ["missing terminal", {
      suppressTurnCompletion: true,
      turnUsage: observedTurnUsage(),
    }],
  ] as const)("fails closed on %s", async (_name, fakeOptions) => {
    await withStrongBridgeBackend(fakeOptions, async (backend) => {
      await expect(backend.complete(strongBridgeRequest()))
        .rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
    });
  });

  it("fails with the exact invalid thread receipt when provider evidence is valid", async () => {
    await withStrongBridgeBackend(
      {
        omitThreadReceiptMetadata: true,
        turnUsage: observedTurnUsage(),
      },
      async (backend, factory) => {
        await expect(backend.complete(strongBridgeRequest()))
          .rejects.toMatchObject({
            code: OpenAiBridgeErrorCode.ProviderUnavailable,
          });

        expect(factory.requests.map((request) => request.method)).not.toContain(
          "turn/start",
        );
        const rawThreadStartProcess = new FakeAppServerFactory({
          omitThreadReceiptMetadata: true,
        }).create({ env: {}, cwd: "/tmp" });
        let incompleteReceipt: unknown;
        rawThreadStartProcess.stdout.on("data", (chunk) => {
          const response = JSON.parse(String(chunk)) as {
            readonly id?: number;
            readonly result?: unknown;
          };
          if (response.id === 1) incompleteReceipt = response.result;
        });
        rawThreadStartProcess.stdin.write(`${JSON.stringify({
          id: 1,
          method: "thread/start",
          params: {
            model: "gpt-5.5",
            serviceTier: "default",
            config: { model_reasoning_effort: "low" },
          },
        })}\n`);
        expect(incompleteReceipt).toEqual({ thread: { id: "thread-1" } });
        expect(() => readAppServerThreadExecutionReceipt(incompleteReceipt)).toThrow(
          "codex_app_server_thread_receipt_invalid",
        );
      },
    );
  });

  it("accepts monotonic token usage updates and retains the latest total", async () => {
    await withStrongBridgeBackend(
      { tokenUsageUpdates: [earlierTurnUsage(), observedTurnUsage()] },
      async (backend) => {
        await expect(backend.complete(strongBridgeRequest())).resolves.toMatchObject({
          usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
        });
      },
    );
  });

  it("binds coalesced response and receipt events without a registration race", async () => {
    await withStrongBridgeBackend(
      { emitTurnEventsWithStartResponse: true, turnUsage: observedTurnUsage() },
      async (backend) => {
        await expect(backend.complete(strongBridgeRequest())).resolves.toMatchObject({
          text: "app-server output:Reply OK",
        });
      },
    );
  });

  it("rejects a duplicate turn id across concurrent receipt states", () => {
    const tracker = new AppServerProviderReceiptTracker();
    tracker.begin("thread-a");
    tracker.begin("thread-b");
    tracker.bind("thread-a", "shared-turn");

    expect(() => tracker.bind("thread-b", "shared-turn"))
      .toThrow("codex_app_server_receipt_response_identity_invalid");

    const eventTracker = new AppServerProviderReceiptTracker();
    eventTracker.begin("thread-a");
    eventTracker.begin("thread-b");
    expect(eventTracker.handle("turn/started", {
      threadId: "thread-a",
      turn: { id: "shared-turn" },
    }).error).toBeUndefined();
    expect(eventTracker.handle("turn/started", {
      threadId: "thread-b",
      turn: { id: "shared-turn" },
    }).error?.message).toBe("codex_app_server_receipt_started_identity_invalid");
  });

  it("fails closed when the seeded auth subject changes during execution", async () => {
    await withStrongBridgeBackend(
      (authPath) => ({
        turnUsage: observedTurnUsage(),
        onRequest: (request) => {
          if (request.method !== "turn/start") return;
          writeFileSync(authPath, JSON.stringify({
            tokens: {
              access_token: "rotated-token",
              account_id: "different-physical-account",
            },
          }), { mode: 0o600 });
        },
      }),
      async (backend) => {
        await expect(backend.complete(strongBridgeRequest()))
          .rejects.toMatchObject({
            code: OpenAiBridgeErrorCode.ProviderUnavailable,
          });
      },
    );
  });

  it("replaces the app-server slot after a sequential auth subject change", async () => {
    let rotated = false;
    await withStrongBridgeBackend(
      (authPath) => ({
        turnUsage: observedTurnUsage(),
        onRequest: (request) => {
          if (request.method !== "turn/start" || rotated) return;
          rotated = true;
          writeFileSync(authPath, JSON.stringify({
            tokens: {
              access_token: "rotated-token",
              account_id: "different-physical-account",
            },
          }), { mode: 0o600 });
        },
      }),
      async (backend, factory) => {
        await expect(backend.complete(strongBridgeRequest()))
          .rejects.toMatchObject({ code: OpenAiBridgeErrorCode.ProviderUnavailable });
        await expect(backend.complete({
          ...strongBridgeRequest(),
          requestId: "strong-bridge-test-2",
        })).resolves.toMatchObject({ text: "app-server output:Reply OK" });
        expect(factory.spawnCount).toBe(2);
      },
    );
  });

  it("disposes every app-server child process", async () => {
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage() },
      async (backend, factory) => {
        await backend.complete(strongBridgeRequest());
        expect(factory.processes.some((process) => !process.isExited())).toBe(true);
        await backend.dispose();
        expect(factory.processes.every((process) => process.isExited())).toBe(true);
      },
    );
  });

  it("reuses first-signal disposal and force-kills children on the second signal", async () => {
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage(), ignoreSigterm: true },
      async (backend, factory) => {
        await backend.complete(strongBridgeRequest());
        const firstSignalDisposal = backend.dispose();
        backend.forceDispose();
        const secondSignalDisposal = backend.dispose();
        expect(secondSignalDisposal).toBe(firstSignalDisposal);
        await secondSignalDisposal;
        expect(factory.processes.every((process) => process.isExited())).toBe(true);
      },
    );
  });

  it("rejects requests after disposal without spawning a child", async () => {
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage() },
      async (backend, factory) => {
        await backend.dispose();
        await expect(backend.complete(strongBridgeRequest())).rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
        expect(factory.spawnCount).toBe(0);
      },
    );
  });

  it("rejects queued work when disposal begins and publishes no replacement child", async () => {
    await withStrongBridgeBackend(
      { turnUsage: observedTurnUsage(), suppressTurnCompletion: true },
      async (backend, factory) => {
        const first = backend.complete(strongBridgeRequest());
        await waitFor(() => factory.spawnCount === 1);
        const queued = backend.complete({
          ...strongBridgeRequest(),
          requestId: "queued-after-first",
        });
        await waitFor(() => backend.health().queuedRequests === 1);
        const disposal = backend.dispose();
        await expect(queued).rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
        backend.forceDispose();
        await disposal;
        await expect(first).rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
        expect(factory.spawnCount).toBe(1);
      },
    );
  });

  it("force-kills a per-session stop already removed from the active slot map", async () => {
    await withStrongBridgeBackend(
      {
        turnUsage: observedTurnUsage(),
        ignoreSigterm: true,
        emitTopLevelErrorOnTurn: "quota exceeded during per-session disposal",
      },
      async (backend, factory) => {
        const running = backend.complete(strongBridgeRequest());
        await waitFor(() => factory.processes.length === 1);
        await waitFor(() => factory.requests.some((request) => request.method === "turn/start"));
        await waitFor(() => factory.processes[0]?.signals.includes("SIGTERM") === true);
        expect(factory.processes[0]?.isExited()).toBe(false);
        const disposal = backend.dispose();
        backend.forceDispose();
        await disposal;
        await expect(running).rejects.toMatchObject({
          code: OpenAiBridgeErrorCode.ProviderUnavailable,
        });
        expect(factory.processes.every((process) => process.isExited())).toBe(true);
        expect(factory.spawnCount).toBe(1);
      },
    );
  });
});

class ItemCompletedRunner implements RunnerPort {
  readonly runnerId = "item-completed-runner";
  readonly capabilities: RunnerCapabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process",
  };

  async run(): Promise<ProcessResult> {
    return {
      exitCode: 0,
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "OK" },
        }),
        turnCompletedUsageJson(),
      ].join("\n"),
      stderr: "",
      durationMs: 1,
    };
  }
}

class MalformedUsageRunner extends ItemCompletedRunner {
  override async run(): Promise<ProcessResult> {
    const result = await super.run();
    return {
      ...result,
      stdout: result.stdout.replace('"output_tokens":5', '"output_tokens":-1'),
    };
  }
}

function turnCompletedUsageJson(): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 21,
      cached_input_tokens: 8,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 3,
    },
  });
}

function observedTurnUsage(): Record<string, number> {
  return {
    input_tokens: 21,
    cached_input_tokens: 8,
    cache_write_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 3,
    total_tokens: 26,
  };
}

function earlierTurnUsage(): Record<string, number> {
  return {
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 2,
    reasoning_output_tokens: 1,
    total_tokens: 12,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("test_condition_timeout");
}

function strongBridgeRequest() {
  return {
    prompt: "Reply OK",
    model: "gpt-5.5",
    requestId: "strong-bridge-test",
    requestIdentity: testRequestIdentity(),
    abortSignal: new AbortController().signal,
  } as const;
}

async function withStrongBridgeBackend(
  options:
    | FakeAppServerFactoryOptions
    | ((authPath: string) => FakeAppServerFactoryOptions),
  run: (
    backend: CodexOpenAiBridgeBackend,
    factory: FakeAppServerFactory,
    isolatedAuthPath: string,
  ) => Promise<void>,
  backendOptions: {
    readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    readonly serviceTier?: string;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-strong-bridge-"));
  const authRoot = join(root, "auth");
  const accountHome = join(authRoot, "account-a");
  const authPath = join(accountHome, "auth.json");
  await mkdir(accountHome, { recursive: true });
  await writeFile(authPath, JSON.stringify({
    tokens: {
      access_token: "test-token",
      account_id: "physical-account-a",
    },
  }));
  const stateDir = join(root, "state");
  const isolatedAuthPath = join(
    stateDir,
    "codex-home",
    "account-a",
    "auth.json",
  );
  const fakeOptions = typeof options === "function"
    ? options(isolatedAuthPath)
    : options;
  const factory = new FakeAppServerFactory(fakeOptions);
  const backend = new CodexOpenAiBridgeBackend({
    codexBinaryPath: "/bin/codex-test",
    authRootDir: authRoot,
    stateDir,
    accountNames: ["account-a"],
    timeoutMs: 250,
    quotaCooldownMs: 1_000,
    maxAccountCycles: 1,
    maxConcurrentRequests: 1,
    reasoningEffort: backendOptions.reasoningEffort ?? "low",
    ...(backendOptions.serviceTier === undefined
      ? {}
      : { serviceTier: backendOptions.serviceTier }),
    attestationSecret,
    processFactory: factory.create,
  });
  try {
    await run(backend, factory, isolatedAuthPath);
  } finally {
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function requestBodySha256(request: unknown): string {
  return openAiBridgeRequestBodySha256(
    new TextEncoder().encode(JSON.stringify(request)),
  );
}

function testRequestIdentity(
  overrides: Partial<{
    readonly public_model: string;
    readonly client_requested_model: string;
    readonly configured_codex_model: string;
    readonly requested_codex_model: string;
    readonly request_body_sha256: string;
    readonly response_format_type: OpenAiBridgeResponseFormatType.Text
      | OpenAiBridgeResponseFormatType.JsonSchema;
    readonly response_format_sha256: string;
    readonly response_schema_sha256: string | null;
  }> = {},
) {
  return {
    public_model: "subscription-codex",
    client_requested_model: "subscription-codex",
    configured_codex_model: "gpt-5.5",
    requested_codex_model: "gpt-5.5",
    request_body_sha256: requestBodySha256({
      messages: [{ role: "user", content: "Reply OK" }],
    }),
    ...responseFormatIdentity(undefined),
    ...overrides,
  } as const;
}

function testOutputIdentity(outputText = "test completion") {
  return {
    output_text_sha256: createHash("sha256")
      .update(outputText, "utf8")
      .digest("hex"),
    terminal_status: "completed",
  } as const;
}

function testAttestationBytes(
  requestIdentity: ReturnType<typeof testRequestIdentity>,
  outputIdentity = testOutputIdentity(),
): Uint8Array {
  return openAiBridgeRuntimeAttestationCanonicalBytes({
    requestIdentity,
    outputIdentity,
    selection: {
      account_binding_hmac_sha256: "a".repeat(64),
      thread_id: "thread-1",
      turn_id: "turn-1",
      model: "gpt-5.5",
      model_provider: "openai",
      reasoning_effort: "high",
      service_tier: "priority",
      execution_profile: "stateless-completion",
      base_instructions_sha256: "d".repeat(64),
    },
    usage: {
      prompt_tokens: 21,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 26,
    },
    requestedOutputTokenLimit: 512,
  });
}

function testAttestationHmac(
  requestIdentity: ReturnType<typeof testRequestIdentity>,
  outputIdentity = testOutputIdentity(),
): string {
  return createHmac("sha256", attestationSecret)
    .update(testAttestationBytes(requestIdentity, outputIdentity))
    .digest("hex");
}
