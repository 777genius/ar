#!/usr/bin/env node
import { loadOpenAiCompatibleCodexBridgeConfigFromEnv } from "./config.js";
import {
  CodexOpenAiBridgeBackend,
  OpenAiBridgeChatCompletionUseCase,
  startOpenAiBridgeHttpServer,
} from "./chat-completions/index.js";
import type { Server } from "node:http";

let activeBackend: CodexOpenAiBridgeBackend | null = null;
let activeServer: Server | null = null;
let shutdownInFlight: Promise<void> | null = null;
let disposingBackend: CodexOpenAiBridgeBackend | null = null;
let shutdownSignalCount = 0;
const shutdownTimeoutMs = 5_000;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command !== "serve") {
    throw new Error(`unknown_command:${command}`);
  }

  const config = loadOpenAiCompatibleCodexBridgeConfigFromEnv();
  const backend = new CodexOpenAiBridgeBackend({
    codexBinaryPath: config.codexBinaryPath,
    authRootDir: config.authRootDir,
    stateDir: config.stateDir,
    ...(config.accountNames === undefined
      ? {}
      : { accountNames: config.accountNames }),
    timeoutMs: config.timeoutMs,
    quotaCooldownMs: config.quotaCooldownMs,
    maxAccountCycles: config.maxAccountCycles,
    maxConcurrentRequests: config.maxConcurrentRequests,
    reasoningEffort: config.reasoningEffort,
    attestationSecret: config.attestationSecret,
    ...(config.serviceTier === undefined
      ? {}
      : { serviceTier: config.serviceTier }),
    sourceEnv: process.env,
  });
  activeBackend = backend;
  const chatCompletion = new OpenAiBridgeChatCompletionUseCase({
    backend,
    publicModel: config.publicModel,
    codexModel: config.codexModel,
  });
  activeServer = await startOpenAiBridgeHttpServer({
    host: config.host,
    port: config.port,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    publicModel: config.publicModel,
    requestBodyMaxBytes: config.requestBodyMaxBytes,
    chatCompletion,
    health: () => backend.health(),
  });
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  process.stdout.write(JSON.stringify({
    ok: true,
    service: "subscription-runtime-openai-compatible-codex",
    host: config.host,
    port: config.port,
    model: config.publicModel,
  }) + "\n");
}

function requestShutdown(): void {
  shutdownSignalCount += 1;
  if (shutdownSignalCount > 1) {
    void forceShutdown();
    return;
  }
  void shutdown().catch((error: unknown) => {
    process.stderr.write(`subscription_runtime_openai_bridge_shutdown_failed:${message(error)}\n`);
    process.exitCode = 1;
  });
}

async function shutdown(): Promise<void> {
  if (shutdownInFlight) return await shutdownInFlight;
  shutdownInFlight = (async () => {
    const server = activeServer;
    const backend = activeBackend;
    disposingBackend = backend;
    activeServer = null;
    activeBackend = null;
    let closeFailure: unknown = null;
    try {
      if (server) await bounded(closeServer(server), shutdownTimeoutMs);
    } catch (error) {
      closeFailure = error;
    } finally {
      try {
        await bounded(backend?.dispose() ?? Promise.resolve(), shutdownTimeoutMs);
      } finally {
        disposingBackend = null;
        process.removeListener("SIGINT", requestShutdown);
        process.removeListener("SIGTERM", requestShutdown);
      }
    }
    if (closeFailure) throw closeFailure;
  })();
  return await shutdownInFlight;
}

async function forceShutdown(): Promise<void> {
  const backend = disposingBackend ?? activeBackend;
  backend?.forceDispose();
  await bounded(backend?.dispose() ?? Promise.resolve(), 1_000).catch(() => undefined);
  process.exit(130);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("bridge_shutdown_timeout")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  process.stdout.write([
    "subscription-runtime-openai-codex-bridge serve",
    "",
    "Environment:",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_AUTH_ROOT or SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_PORT",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_ACCOUNTS",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY",
    "  SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_ATTESTATION_SECRET (required, 32+ bytes)",
  ].join("\n") + "\n");
}

main().catch((error: unknown) => {
  void shutdown().finally(() => {
    process.stderr.write(`subscription_runtime_openai_bridge_failed:${message(error)}\n`);
    process.exitCode = 1;
  });
});
