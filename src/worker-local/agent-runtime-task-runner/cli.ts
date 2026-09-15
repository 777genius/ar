#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntimeTaskEventType,
  AgentRuntimeTaskResultStatus,
  agentRuntimeTaskProtocolVersion,
  makeFailedAgentRuntimeTaskResult,
  parseAgentRuntimeTaskRequest,
  type AgentRuntimeTaskEvent,
  type AgentRuntimeTaskRequest,
  type AgentRuntimeTaskResult,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  AgentRuntimeTaskReasoningEffort,
  AgentRuntimeTaskServiceTier,
  AuthSourceKind,
  ClaudeAgentRuntimeBackend,
} from "../../agent-runtime-task-runner/domain";
import {
  AgentRuntimeTaskProvider,
} from "./ports";
import {
  createDefaultAgentRuntimeTaskWorker,
  createLocalAgentRuntimeTaskRunner,
} from "./local-agent-runtime-task-runner";
import type {
  ProviderName,
  AgentRuntimeTaskWorkerFactory,
} from "./ports";
import {
  errorDetails,
  optionalFailureDetails,
} from "./error-details";

export {
  pruneClaudeChildEnv,
  resolveRequestCwd,
} from "./domain";
export {
  AgentRuntimeTaskProvider,
} from "./ports";
export type {
  ProviderName,
  AgentRuntimeTaskWorker,
  AgentRuntimeTaskWorkerFactory,
  AgentRuntimeTaskWorkerFactoryInput,
  AgentRuntimeTaskWorkerJob,
  AgentRuntimeTaskWorkerResult,
} from "./ports";

export type SubscriptionAgentRuntimeTaskCliIo = {
  readStdin(): Promise<string>;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  cwd(): string;
  env(): Readonly<Record<string, string | undefined>>;
};

export type SubscriptionAgentRuntimeTaskCliRunOptions = {
  readonly signal?: AbortSignal;
};

export const agentRuntimeTaskRunnerCapabilities = {
  schemaVersion: 1,
  // The packaged HIB artifact intentionally exposes only its stable v2 contract.
  protocolVersions: [2],
  inlineOutputSchema: true,
  reasoningEffort: true,
  serviceTier: true,
  boundedReadOnlyWorkspace: true,
  instructionPathDeny: true,
} as const;

type ParsedArgs = {
  readonly provider: ProviderName;
  readonly inputPath?: string;
  readonly format: "event-ndjson" | "result-json";
  readonly stateRootDir?: string;
  readonly providerInstanceId?: string;
  readonly encryptionKeyEnv: string;
  readonly ephemeral: boolean;
  readonly claudeTokenEnv: string;
  readonly claudeBackend: ClaudeAgentRuntimeBackend;
  readonly codexAuthJsonPath?: string;
  readonly codexAuthJsonEnv: string;
  readonly claudePath?: string;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: AgentRuntimeTaskReasoningEffort;
  readonly serviceTier?: AgentRuntimeTaskServiceTier;
  readonly timeoutMs?: number;
};

export async function runSubscriptionAgentRuntimeTaskCli(
  argv = process.argv.slice(2),
  io: SubscriptionAgentRuntimeTaskCliIo = defaultIo,
  workerFactory: AgentRuntimeTaskWorkerFactory = createDefaultAgentRuntimeTaskWorker,
  options: SubscriptionAgentRuntimeTaskCliRunOptions = {},
): Promise<number> {
  let tempStateRoot: string | null = null;
  let runner: ReturnType<typeof createLocalAgentRuntimeTaskRunner> | undefined;
  try {
    const capabilitiesVersion = requestedCapabilitiesVersion(argv);
    if (capabilitiesVersion !== undefined) {
      if (capabilitiesVersion !== 1) {
        throw new Error("--capabilities-json version must be 1");
      }
      io.writeStdout(`${JSON.stringify(agentRuntimeTaskRunnerCapabilities)}\n`);
      return 0;
    }
    const args = parseArgs(argv);
    const request = parseAgentRuntimeTaskRequest(
      JSON.parse(
        args.inputPath ? await readFile(args.inputPath, "utf8") : await io.readStdin(),
      ),
    );
    const env = io.env();
    const stateRootDir =
      args.stateRootDir ??
      (args.ephemeral
        ? (tempStateRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-agent-runtime-task-")))
        : env.SUBSCRIPTION_RUNTIME_STATE_ROOT);
    if (!stateRootDir) {
      throw new Error(
        "--state-root is required unless --ephemeral or SUBSCRIPTION_RUNTIME_STATE_ROOT is set",
      );
    }

    const encryptionKey = args.ephemeral
      ? randomBytes(32)
      : requiredEnv(env, args.encryptionKeyEnv);
    const timeoutMs = args.timeoutMs ?? request.timeoutMs;
    const runnerRequest = args.timeoutMs === undefined
      ? request
      : {
          ...request,
          timeoutMs: args.timeoutMs,
        };
    const claudeOAuthToken = env[args.claudeTokenEnv];
    const codexAuthJsonPath =
      args.codexAuthJsonPath ?? env[args.codexAuthJsonEnv];
    const commonRunnerInput = {
      provider: args.provider,
      stateRootDir,
      encryptionKey,
      workspaceRoot: io.cwd(),
      env,
      ...(args.providerInstanceId
        ? { providerInstanceId: args.providerInstanceId }
        : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      workerFactory,
      onDisposeError(message: string) {
        io.writeStderr(`${message}\n`);
      },
    } as const;
    runner = args.provider === AgentRuntimeTaskProvider.Claude
      ? createLocalAgentRuntimeTaskRunner({
          ...commonRunnerInput,
          provider: AgentRuntimeTaskProvider.Claude,
          ...(claudeOAuthToken
            ? {
                authSource: {
                  kind: AuthSourceKind.ClaudeOAuthToken,
                  oauthToken: claudeOAuthToken,
                },
              }
            : {}),
          claudeBackend: args.claudeBackend,
          ...(args.claudePath ? { claudePath: args.claudePath } : {}),
          ...(args.claudeBackend === ClaudeAgentRuntimeBackend.Background &&
              env.CLAUDE_RUNTIME_DIST_DIR
            ? { claudeRuntimeDistDir: env.CLAUDE_RUNTIME_DIST_DIR }
            : {}),
        })
      : createLocalAgentRuntimeTaskRunner({
          ...commonRunnerInput,
          provider: AgentRuntimeTaskProvider.Codex,
          ...(codexAuthJsonPath
            ? {
                authSource: {
                  kind: AuthSourceKind.CodexAuthJsonFile,
                  path: codexAuthJsonPath,
                },
              }
            : {}),
          ...(args.codexBinaryPath
            ? { codexBinaryPath: args.codexBinaryPath }
            : {}),
          ...(args.reasoningEffort
            ? { reasoningEffort: args.reasoningEffort }
            : {}),
          ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
        });

    const result = await runner.run(runnerRequest, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await emitResult({ request, result, format: args.format, io });
    return result.status === AgentRuntimeTaskResultStatus.Completed ? 0 : 1;
  } catch (error) {
    const safeMessage =
      error instanceof Error ? error.message : "subscription runtime agent runtime task failed";
    if (requestedOutputFormat(argv) === "result-json") {
      io.writeStdout(
        `${JSON.stringify(makeCliFailedAgentRuntimeTaskResult({
          code: "unknown_runtime_failure",
          safeMessage,
          retryable: false,
          ...optionalFailureDetails(errorDetails(error)),
        }))}\n`,
      );
    }
    io.writeStderr(
      `${safeMessage}\n`,
    );
    return 2;
  } finally {
    await runner?.dispose();
    if (tempStateRoot) {
      await rm(tempStateRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function requestedCapabilitiesVersion(
  argv: readonly string[],
): number | undefined {
  const index = argv.indexOf("--capabilities-json");
  if (index < 0) return undefined;
  if (index !== 0 || argv.length > 2) {
    throw new Error("--capabilities-json must be used alone with optional version 1");
  }
  if (argv.length === 1) return 1;
  const version = Number(argv[1]);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error("--capabilities-json version must be a positive integer");
  }
  return version;
}

function requestedOutputFormat(
  argv: readonly string[],
): ParsedArgs["format"] {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--format") continue;
    const value = argv[index + 1];
    return value === "result-json" ? "result-json" : "event-ndjson";
  }
  return "event-ndjson";
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let provider: ProviderName | null = null;
  let inputPath: string | undefined;
  let format: ParsedArgs["format"] = "event-ndjson";
  let stateRootDir: string | undefined;
  let providerInstanceId: string | undefined;
  let encryptionKeyEnv = "SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY";
  let ephemeral = false;
  let claudeTokenEnv = "CLAUDE_CODE_OAUTH_TOKEN";
  let claudeBackend = ClaudeAgentRuntimeBackend.AgentSdk;
  let codexAuthJsonPath: string | undefined;
  let codexAuthJsonEnv = "CODEX_AUTH_JSON_PATH";
  let claudePath: string | undefined;
  let codexBinaryPath: string | undefined;
  let model: string | undefined;
  let reasoningEffort: AgentRuntimeTaskReasoningEffort | undefined;
  let serviceTier: AgentRuntimeTaskServiceTier | undefined;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      const value = requiredValue(argv, index, arg);
      if (
        value !== AgentRuntimeTaskProvider.Claude &&
        value !== AgentRuntimeTaskProvider.Codex
      ) {
        throw new Error("--provider must be claude or codex");
      }
      provider = value === AgentRuntimeTaskProvider.Claude
        ? AgentRuntimeTaskProvider.Claude
        : AgentRuntimeTaskProvider.Codex;
      index += 1;
      continue;
    }
    if (arg === "--input") {
      inputPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--format") {
      const value = requiredValue(argv, index, arg);
      if (value !== "event-ndjson" && value !== "result-json") {
        throw new Error("--format must be event-ndjson or result-json");
      }
      format = value;
      index += 1;
      continue;
    }
    if (arg === "--state-root") {
      stateRootDir = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--provider-instance") {
      providerInstanceId = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--encryption-key-env") {
      encryptionKeyEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ephemeral") {
      ephemeral = true;
      continue;
    }
    if (arg === "--claude-token-env") {
      claudeTokenEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-backend") {
      const value = requiredValue(argv, index, arg);
      if (
        value !== ClaudeAgentRuntimeBackend.AgentSdk &&
        value !== ClaudeAgentRuntimeBackend.Background
      ) {
        throw new Error("--claude-backend must be agent-sdk or claude-background");
      }
      claudeBackend = value;
      index += 1;
      continue;
    }
    if (arg === "--codex-auth-json") {
      codexAuthJsonPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-auth-json-env") {
      codexAuthJsonEnv = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--claude-path") {
      claudePath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--codex-binary") {
      codexBinaryPath = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reasoning-effort") {
      const value = requiredValue(argv, index, arg);
      if (value !== AgentRuntimeTaskReasoningEffort.High) {
        throw new Error("--reasoning-effort must be high");
      }
      reasoningEffort = AgentRuntimeTaskReasoningEffort.High;
      index += 1;
      continue;
    }
    if (arg === "--service-tier") {
      const value = requiredValue(argv, index, arg);
      if (value !== AgentRuntimeTaskServiceTier.Default) {
        throw new Error("--service-tier must be default");
      }
      serviceTier = AgentRuntimeTaskServiceTier.Default;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(requiredValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!provider) throw new Error("--provider is required");
  if (
    provider !== AgentRuntimeTaskProvider.Codex &&
    (reasoningEffort !== undefined || serviceTier !== undefined)
  ) {
    throw new Error(
      "--reasoning-effort and --service-tier are supported only for --provider codex",
    );
  }
  return {
    provider,
    ...(inputPath ? { inputPath } : {}),
    format,
    ...(stateRootDir ? { stateRootDir } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    encryptionKeyEnv,
    ephemeral,
    claudeTokenEnv,
    claudeBackend,
    ...(codexAuthJsonPath ? { codexAuthJsonPath } : {}),
    codexAuthJsonEnv,
    ...(claudePath ? { claudePath } : {}),
    ...(codexBinaryPath ? { codexBinaryPath } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

async function emitResult(input: {
  readonly request: AgentRuntimeTaskRequest;
  readonly result: AgentRuntimeTaskResult;
  readonly format: ParsedArgs["format"];
  readonly io: SubscriptionAgentRuntimeTaskCliIo;
}): Promise<void> {
  if (input.format === "result-json") {
    input.io.writeStdout(`${JSON.stringify(input.result)}\n`);
    return;
  }
  const started = {
    protocolVersion: input.request.protocolVersion,
    type: AgentRuntimeTaskEventType.Started,
    occurredAt: new Date().toISOString(),
  } as AgentRuntimeTaskEvent;
  const completed = {
    protocolVersion: input.request.protocolVersion,
    type: AgentRuntimeTaskEventType.Completed,
    occurredAt: new Date().toISOString(),
    result: input.result,
  } as AgentRuntimeTaskEvent;
  input.io.writeStdout(`${JSON.stringify(started)}\n`);
  input.io.writeStdout(`${JSON.stringify(completed)}\n`);
}

function makeCliFailedAgentRuntimeTaskResult(input: {
  readonly code: Parameters<typeof makeFailedAgentRuntimeTaskResult>[0]["code"];
  readonly safeMessage: string;
  readonly retryable?: boolean;
  readonly reconnectRequired?: boolean;
  readonly causeCategory?: string;
  readonly details?: Readonly<Record<string, string>>;
}): AgentRuntimeTaskResult {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersion,
    status: AgentRuntimeTaskResultStatus.Failed,
    failure: {
      code: input.code,
      retryable: input.retryable ?? false,
      reconnectRequired: input.reconnectRequired ?? false,
      safeMessage: input.safeMessage,
      ...(input.causeCategory ? { causeCategory: input.causeCategory } : {}),
      ...(input.details ? { details: input.details } : {}),
    },
    warnings: [],
  };
}

function requiredValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    "usage: subscription-runtime-run-agent-runtime-task --provider claude|codex [--input request.json]",
    "       subscription-runtime-run-agent-runtime-task --capabilities-json [1]",
    "       [--format event-ndjson|result-json] [--state-root dir | --ephemeral]",
    "       [--provider-instance id] [--model model] [--timeout-ms ms]",
    "       [--reasoning-effort high] [--service-tier default] (Codex only)",
    "       [--claude-backend agent-sdk|claude-background]",
  ].join("\n");
}

const defaultIo: SubscriptionAgentRuntimeTaskCliIo = {
  async readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  writeStdout(chunk: string): void {
    process.stdout.write(chunk);
  },
  writeStderr(chunk: string): void {
    process.stderr.write(chunk);
  },
  cwd(): string {
    return process.cwd();
  },
  env(): Readonly<Record<string, string | undefined>> {
    return process.env;
  },
};

if (await isMainModule()) {
  process.exitCode = await runSubscriptionAgentRuntimeTaskCliFromProcess();
}

export async function runSubscriptionAgentRuntimeTaskCliFromProcess(): Promise<number> {
  const abortController = new AbortController();
  const abort = (): void => abortController.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await runSubscriptionAgentRuntimeTaskCli(
      process.argv.slice(2),
      defaultIo,
      createDefaultAgentRuntimeTaskWorker,
      { signal: abortController.signal },
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return (await realpath(modulePath)) === (await realpath(process.argv[1]));
  } catch {
    return modulePath === process.argv[1];
  }
}
