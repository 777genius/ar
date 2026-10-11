#!/usr/bin/env node
import { assertHostedOrdinaryGoalExtent } from "./hosted-ordinary-writer-authority";
import { mapManagedGoalLayout } from "./managed-goal-admission";
import { enterScratchPrivateMountNamespace, isScratchHelpInvocation } from "./scratch-mount-namespace";
import { routeHostedRuntimeCommand } from "./hosted-readonly-foreground";
import { tryRunHostedLegacyReference } from "./hosted-dependency-legacy-reference";
import { CodexGoalLaunchState } from "./codex-goal-ops";
import type { HostedGoalLifecycleRequest } from "./application/codex-goal-foreground-command";
import { buildCodexGoalCliLaunchInput, parseHostedGoalLifecycleRequest, runHostedGoalLifecycleCommand } from "./hosted-readonly-lifecycle-cli";
import { routeHostedGoalLaunch } from "./hosted-readonly-goal-launch";
import { assertInProcessStorageOwner, assertInProcessRunComposition, hasTrustedRunDeps, assertStorageCommandSerializationSupported, assertStorageRegistrySupported } from "./codex-goal-cli-run-composition";
import { isHostedOrdinaryRuntime, readHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { HostedReadonlyRuntimeRole } from "./hosted-readonly-host-kernel";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import {
  type CodexGoalCliIo,
  type OutputFormat,
  type ParsedFlags,
  flag,
  option,
  outputFormat,
  outputFormatFromFlags,
  parseFlags,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  requiredOption,
  resolvePath,
  usage,
  writeJsonOrText,
} from "./codex-goal-cli-support";

export type { CodexGoalCliIo } from "./codex-goal-cli-support";

import {
  runCodexGoal,
  type CodexGoalRunConfig,
  type CodexGoalRunDeps,
} from "./codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  startCodexGoalTmux,
  tailCodexGoalLog,
} from "./codex-goal-ops";
import { redactLogTail } from "./application/codex-goal-log-view";
import {
  callCodexGoalMcpTool,
  doctorCodexGoalControlSurface,
  getCodexGoalMcpPrompt,
  listCodexGoalMcpPrompts,
  listCodexGoalMcpResources,
  listCodexGoalMcpTools,
  readCodexGoalMcpResource,
  superviseCodexGoalProjectController,
} from "./codex-goal-mcp-client";
import {
  upsertCodexGoalLaunchManifest,
  type CodexGoalLaunchManifestMetadata,
} from "./codex-goal-launch-manifest";
import {
  parseCodexGoalRelayEventsCommand,
  runCodexGoalRelayEventsCommand,
  type RelayEventsCommand,
} from "./run-event-relay";
import {
  oneShotCodexGoalMcpToolGuard,
  parseCodexGoalCliMcpShortcut,
} from "./codex-goal-cli-shortcuts";
import {
  runConfigFromFlags,
  splitCsv,
} from "./codex-goal-cli-run-config";
import {
  projectControlGenericScopeDenial,
  projectControlGenericToolDenial,
} from "./project-control-scope-guard";
import {
  runProjectControlOperationFile,
} from "./project-control-operation-lifecycle";

enum ControllerSupervisorCliEventType {
  Failure = "failure",
}

type CodexGoalCliCommand =
  | RunCommand
  | StatusCommand
  | DoctorCommand
  | TailCommand
  | RelayEventsCommand
  | McpToolsCommand
  | McpToolCommand
  | McpResourcesCommand
  | McpResourceCommand
  | McpPromptsCommand
  | McpPromptCommand
  | ControlDoctorCommand
  | ControllerSuperviseCommand
  | ProjectControlOperationRunCommand
  | HelpCommand;

export type RunCommand = {
  readonly kind: "run";
  readonly lifecycle?: HostedGoalLifecycleRequest;
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly dryRun: boolean;
  readonly printCommand: boolean;
  readonly format: OutputFormat;
  readonly cwd: string;
  readonly logPath: string;
  readonly registryRootDir?: string;
  readonly registryMetadata?: CodexGoalLaunchManifestMetadata;
};

type StatusCommand = {
  readonly kind: "status";
  readonly jobRootDir?: string;
  readonly taskId?: string;
  readonly workspacePath?: string;
  readonly tmuxSession?: string;
  readonly progressPath?: string;
  readonly format: OutputFormat;
};

type DoctorCommand = {
  readonly kind: "doctor";
  readonly config: CodexGoalRunConfig;
  readonly tmuxSession?: string;
  readonly format: OutputFormat;
};

type TailCommand = {
  readonly kind: "tail";
  readonly logPath: string;
  readonly lines: number;
};

type McpToolsCommand = {
  readonly kind: "mcp-tools";
  readonly format: OutputFormat;
};

type McpToolCommand = {
  readonly kind: "mcp-tool";
  readonly name: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly format: OutputFormat;
};

type McpResourcesCommand = {
  readonly kind: "mcp-resources";
  readonly format: OutputFormat;
};

type McpResourceCommand = {
  readonly kind: "mcp-resource";
  readonly uri: string;
  readonly format: OutputFormat;
};

type McpPromptsCommand = {
  readonly kind: "mcp-prompts";
  readonly format: OutputFormat;
};

type McpPromptCommand = {
  readonly kind: "mcp-prompt";
  readonly name: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly format: OutputFormat;
};

type ControlDoctorCommand = {
  readonly kind: "control-doctor";
  readonly format: OutputFormat;
};

type ControllerSuperviseCommand = {
  readonly kind: "controller-supervise";
  readonly args: Record<string, unknown>;
  readonly statusIntervalMs: number;
  readonly format: OutputFormat;
};

type ProjectControlOperationRunCommand = {
  readonly kind: "project-control-operation-run";
  readonly operationFilePath: string;
  readonly format: OutputFormat;
};

type HelpCommand = {
  readonly kind: "help";
};

/** Installed trusted composition only; never serialize or transport to a new process. */
export type CodexGoalCliTrustedComposition = {
  readonly runDeps?: CodexGoalRunDeps;
};

export async function runCodexGoalCli(
  argv = process.argv.slice(2),
  io: CodexGoalCliIo = defaultIo,
  trusted: CodexGoalCliTrustedComposition = {},
): Promise<number> {
  try {
    const runDeps = trusted.runDeps;
    let command = parseCodexGoalCliArgs(argv, io);
    if (hasTrustedRunDeps(runDeps) && command.kind !== "run") {
      throw new Error("codex_goal_cli_trusted_run_command_required");
    }
    if (command.kind === "help") {
      io.writeStdout(usage());
      return 0;
    }
    if (command.kind === "status") {
      writeJsonOrText(command.format, await collectCodexGoalStatus(command), io);
      return 0;
    }
    if (command.kind === "doctor") {
      const result = await doctorCodexGoal(command);
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (command.kind === "tail") {
      io.writeStdout(
        redactLogTail(await tailCodexGoalLog(command.logPath, command.lines)),
      );
      return 0;
    }
    if (command.kind === "relay-events") {
      return runCodexGoalRelayEventsCommand(command, io);
    }
    if (command.kind === "mcp-tools") {
      writeJsonOrText(command.format, await listCodexGoalMcpTools(), io);
      return 0;
    }
    if (command.kind === "mcp-tool") {
      const oneShotGuard = oneShotCodexGoalMcpToolGuard(command.name);
      if (oneShotGuard !== undefined) {
        writeJsonOrText(command.format, oneShotGuard, io);
        return 1;
      }
      if (command.name === "codex_goal_project_start") {
        const outerStatus = await routeHostedRuntimeCommand([currentCliPath(), ...argv]);
        if (outerStatus !== undefined) return outerStatus;
      }
      writeJsonOrText(
        command.format,
        await callCodexGoalMcpTool({
          name: command.name,
          args: await readJsonArgs(command, io),
        }),
        io,
      );
      return 0;
    }
    if (command.kind === "mcp-resources") {
      writeJsonOrText(command.format, await listCodexGoalMcpResources(), io);
      return 0;
    }
    if (command.kind === "mcp-resource") {
      writeJsonOrText(
        command.format,
        await readCodexGoalMcpResource({ uri: command.uri }),
        io,
      );
      return 0;
    }
    if (command.kind === "mcp-prompts") {
      writeJsonOrText(command.format, await listCodexGoalMcpPrompts(), io);
      return 0;
    }
    if (command.kind === "mcp-prompt") {
      writeJsonOrText(
        command.format,
        await getCodexGoalMcpPrompt({
          name: command.name,
          args: await readJsonArgs(command, io),
        }),
        io,
      );
      return 0;
    }
    if (command.kind === "control-doctor") {
      const result = await doctorCodexGoalControlSurface();
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (command.kind === "controller-supervise") {
      const outerStatus = await routeHostedRuntimeCommand([currentCliPath(), ...argv]);
      if (outerStatus !== undefined) return outerStatus;
      const format = command.format;
      const abortController = new AbortController();
      const onSignal = () => abortController.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const result = await superviseCodexGoalProjectController({
          args: command.args,
          statusIntervalMs: command.statusIntervalMs,
          signal: abortController.signal,
          onEvent: (event) => {
            if (format === "json") {
              io.writeStdout(`${JSON.stringify(event)}\n`);
              return;
            }
            io.writeStdout(`${event.type} ${JSON.stringify(event.result)}\n`);
          },
        });
        if (!result.ok && result.reason !== undefined) {
          const failure = { ok: false, reason: result.reason, safeMessage: result.safeMessage };
          io.writeStdout(format === "json"
            ? `${JSON.stringify({ type: ControllerSupervisorCliEventType.Failure, result: failure })}\n`
            : `failure ${result.reason}: ${result.safeMessage ?? "Controller supervision needs attention."}\n`);
        }
        return result.ok ? 0 : 1;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    if (command.kind === "project-control-operation-run") {
      const result = await runProjectControlOperationFile({
        operationFilePath: command.operationFilePath,
        invokeTool: (name, args) =>
          callCodexGoalMcpTool({
            name,
            args: args as Record<string, unknown>,
          }),
      });
      writeJsonOrText(command.format, result, io);
      return result.ok ? 0 : 1;
    }
    if (!command.dryRun && !command.printCommand) {
      command = { ...command, ...mapManagedGoalLayout(command) };
    }
    assertInProcessRunComposition(command, runDeps, () => cliLaunchInput(command));
    if (command.lifecycle) {
      return await runHostedGoalLifecycleCommand(command, cliLaunchInput(command), io);
    }
    if (command.tmuxSession) {
      const tmuxCommand = buildTmuxCommand(command);
      if (command.dryRun || command.printCommand) {
        io.writeStdout(`${tmuxCommand.preview}\n`);
        return 0;
      }
      await assertRunCommandProjectControlAllowed(command);
      const outerStatus = await routeHostedGoalLaunch(cliLaunchInput(command));
      if (outerStatus !== undefined) return outerStatus;
      await upsertRunCommandManifest(command);
      const launched = await startCodexGoalTmux(cliLaunchInput(command));
      io.writeStdout(
        `${launched.launchState ?? CodexGoalLaunchState.Scheduled} ${command.tmuxSession} for ${command.config.taskId}\n`,
      );
      return launched.launchState === CodexGoalLaunchState.Failed ? 1 : 0;
    }
    if (command.dryRun || command.printCommand) {
      io.writeStdout(`${buildNoTmuxShellCommand(command)}\n`);
      return 0;
    }
    await assertRunCommandProjectControlAllowed(command);
    if (command.config.storage) {
      assertInProcessStorageOwner(cliLaunchInput(command));
    } else {
      const outerStatus = await routeHostedGoalLaunch(cliLaunchInput(command));
      if (outerStatus !== undefined) return outerStatus;
      await upsertRunCommandManifest(command);
      const reference = await tryRunHostedLegacyReference(command.config);
      if (reference) { writeJsonOrText(command.format, reference, io); return 0; }
    }
    const result = await runCodexGoal(command.config, runDeps);
    writeJsonOrText(command.format, result, io);
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    if (io === defaultIo && unverifiedHostedForegroundSink()) return 70;
    if (isBrokenPipeError(error)) return 0;
    try {
      io.writeStderr(`${error instanceof Error ? error.message : "codex goal failed"}\n`);
    } catch (stderrError) {
      if (isBrokenPipeError(stderrError)) return 0;
      throw stderrError;
    }
    return 2;
  }
}

/** Only suppresses diagnostics; it grants no process or file authority. Actual
 * admitted inner runtimes retain their already-proved pipe output contract. */
function unverifiedHostedForegroundSink(): boolean {
  try {
    if (!readHostedFdProfile()) return false;
    if (isHostedOrdinaryRuntime()) {
      withHostedActivationFence(fence => readHostedOrdinaryRuntime(fence));
      return false;
    }
    return new HostedReadonlySupervisorHost().runtimeRole() !== HostedReadonlyRuntimeRole.Runtime;
  } catch { return true; }
}

function isBrokenPipeError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "EPIPE" || error.errno === -32;
}

function installBrokenPipeHandlers(): void {
  const onStreamError = (error: Error): void => {
    if (isBrokenPipeError(error)) {
      process.exit(0);
    }
    throw error;
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
}

export function parseCodexGoalCliArgs(
  argv: readonly string[],
  io: CodexGoalCliIo = defaultIo,
): CodexGoalCliCommand {
  const commandName = argv[0] ?? "help";
  const rest = commandName === "help" || commandName.startsWith("--")
    ? argv
    : argv.slice(1);
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    return { kind: "help" };
  }
  if (commandName === "run" || commandName.startsWith("--")) {
    return parseRun(rest, io);
  }
  if (commandName === "continue") {
    const run = parseRun(rest, io);
    if (run.config.childLifetime) throw new Error("child_continuation_denied");
    return run;
  }
  if (commandName === "status") {
    return parseStatus(rest, io);
  }
  if (commandName === "doctor") {
    return parseDoctor(rest, io);
  }
  if (commandName === "tail") {
    return parseTail(rest, io);
  }
  if (commandName === "relay-events") {
    return parseCodexGoalRelayEventsCommand(rest, io);
  }
  if (commandName === "tools") {
    return parseMcpTools(rest, io);
  }
  if (commandName === "tool" || commandName === "call") {
    return parseMcpTool(rest, io);
  }
  if (commandName === "resources") {
    return parseMcpResources(rest, io);
  }
  if (commandName === "resource") {
    return parseMcpResource(rest, io);
  }
  if (commandName === "prompts") {
    return parseMcpPrompts(rest, io);
  }
  if (commandName === "prompt") {
    return parseMcpPrompt(rest, io);
  }
  if (commandName === "doctor-control" || commandName === "control-doctor") {
    return parseControlDoctor(rest, io);
  }
  if (
    commandName === "controller-supervise" ||
    commandName === "project-controller-supervise"
  ) {
    return parseControllerSupervise(rest, io);
  }
  if (commandName === "project-control-operation-run") {
    return parseProjectControlOperationRun(rest, io);
  }
  const shortcut = parseMcpShortcut(commandName, rest, io);
  if (shortcut) return shortcut;
  throw new Error(`unknown command: ${commandName}`);
}

export function buildTmuxCommand(command: RunCommand): {
  readonly args: readonly string[];
  readonly preview: string;
} {
  assertStorageCommandSerializationSupported(command);
  return buildCodexGoalTmuxCommand(cliLaunchInput(command));
}

export function buildNoTmuxShellCommand(command: RunCommand): string {
  assertStorageCommandSerializationSupported(command);
  return buildCodexGoalNoTmuxCommand(cliLaunchInput(command));
}

export async function upsertRunCommandManifest(command: RunCommand) {
  if (!command.registryRootDir) return undefined;
  assertStorageRegistrySupported(command);
  assertHostedOrdinaryGoalExtent(command.config, [], command.registryRootDir);
  return upsertCodexGoalLaunchManifest({
    registryRootDir: command.registryRootDir,
    launch: cliLaunchInput(command),
    ...(command.registryMetadata ? { metadata: command.registryMetadata } : {}),
  });
}

async function assertRunCommandProjectControlAllowed(command: RunCommand): Promise<void> {
  const jobId = command.config.jobId ?? command.config.taskId;
  const denial = command.registryRootDir === undefined
    ? projectControlGenericToolDenial({
        accessBoundary: command.config.accessBoundary,
        projectAccessScope: command.config.projectAccessScope,
        jobId,
        requiredTool: "codex_goal_project_start",
      })
    : await projectControlGenericScopeDenial({
        registryRootDir: command.registryRootDir,
        jobId,
        workspacePath: command.config.workspacePath,
        accessBoundary: command.config.accessBoundary,
        projectAccessScope: command.config.projectAccessScope,
        requiredTool: "codex_goal_project_start",
      });
  if (!denial) return;
  throw new Error(
    [
      denial.reason,
      `requiredTool=${denial.requiredTool}`,
      denial.controllerJobId ? `controllerJobId=${denial.controllerJobId}` : undefined,
      denial.safeMessage,
    ].filter((part): part is string => part !== undefined).join("; "),
  );
}

function cliLaunchInput(command: RunCommand) {
  return buildCodexGoalCliLaunchInput(command, [execPath, currentCliPath()]);
}

function parseRun(
  argv: readonly string[],
  io: CodexGoalCliIo,
): RunCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const jobRootDir = requiredOption(values, env, "--job-root", [
    "SUBSCRIPTION_RUNTIME_JOB_ROOT",
  ]);
  const taskId = requiredOption(values, env, "--task-id", [
    "SUBSCRIPTION_RUNTIME_TASK_ID",
    "MEMO_STACK_GOAL_TASK_ID",
  ]);
  const logPath = option(values, env, "--log", []) ??
    join(jobRootDir, `${taskId}.log`);
  const config = runConfigFromFlags(values, env, io.cwd(), jobRootDir, taskId);
  const registryRootDir = option(values, env, "--registry-root", [
    "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT",
    "CODEX_GOAL_REGISTRY_ROOT",
  ]);
  const registryMetadata = registryMetadataFromFlags(values);
  const lifecycle = parseHostedGoalLifecycleRequest(values);
  return {
    kind: "run",
    ...(lifecycle ? { lifecycle } : {}),
    config,
    ...(option(values, env, "--tmux-session", []) || flag(values, "--tmux")
      ? { tmuxSession: option(values, env, "--tmux-session", []) ?? taskId }
      : {}),
    dryRun: flag(values, "--dry-run"),
    printCommand: flag(values, "--print-command"),
    format: outputFormat(option(values, env, "--format", []) ?? "text"),
    cwd: resolvePath(io.cwd(), option(values, env, "--cwd", []) ?? io.cwd()),
    logPath,
    ...(registryRootDir
      ? { registryRootDir: resolvePath(io.cwd(), registryRootDir) }
      : {}),
    ...(registryMetadata ? { registryMetadata } : {}),
  };
}

function parseDoctor(
  argv: readonly string[],
  io: CodexGoalCliIo,
): DoctorCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const jobRootDir = requiredOption(values, env, "--job-root", [
    "SUBSCRIPTION_RUNTIME_JOB_ROOT",
  ]);
  const taskId = requiredOption(values, env, "--task-id", [
    "SUBSCRIPTION_RUNTIME_TASK_ID",
    "MEMO_STACK_GOAL_TASK_ID",
  ]);
  const tmuxSession = option(values, env, "--tmux-session", []);
  return {
    kind: "doctor",
    config: runConfigFromFlags(values, env, io.cwd(), jobRootDir, taskId),
    ...(tmuxSession ? { tmuxSession } : {}),
    format: outputFormat(option(values, env, "--format", []) ?? "text"),
  };
}

function parseStatus(
  argv: readonly string[],
  io: CodexGoalCliIo,
): StatusCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const jobRootDir = option(values, env, "--job-root", [
    "SUBSCRIPTION_RUNTIME_JOB_ROOT",
  ]);
  const taskId = option(values, env, "--task-id", [
    "SUBSCRIPTION_RUNTIME_TASK_ID",
    "MEMO_STACK_GOAL_TASK_ID",
  ]);
  const workspacePath = option(values, env, "--workspace", [
    "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH",
    "MEMO_STACK_GOAL_WORKSPACE_PATH",
  ]);
  const tmuxSession = option(values, env, "--tmux-session", []);
  const progressPath = option(values, env, "--progress", []);
  return {
    kind: "status",
    ...(jobRootDir ? { jobRootDir } : {}),
    ...(taskId ? { taskId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(tmuxSession ? { tmuxSession } : {}),
    ...(progressPath ? { progressPath: resolvePath(io.cwd(), progressPath) } : {}),
    format: outputFormat(option(values, env, "--format", []) ?? "text"),
  };
}

function parseTail(
  argv: readonly string[],
  io: CodexGoalCliIo,
): TailCommand {
  const env = io.env();
  const values = parseFlags(argv);
  const taskId = option(values, env, "--task-id", [
    "SUBSCRIPTION_RUNTIME_TASK_ID",
    "MEMO_STACK_GOAL_TASK_ID",
  ]);
  const jobRoot = option(values, env, "--job-root", [
    "SUBSCRIPTION_RUNTIME_JOB_ROOT",
  ]);
  const logPath = option(values, env, "--log", []) ??
    (taskId && jobRoot ? join(jobRoot, `${taskId}.log`) : undefined);
  if (!logPath) throw new Error("--log or --job-root with --task-id is required");
  return {
    kind: "tail",
    logPath,
    lines: parsePositiveInteger(option(values, env, "--lines", []) ?? "100", "--lines"),
  };
}

function parseMcpTools(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolsCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-tools",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpTool(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolCommand {
  const name = argv[0];
  if (!name || name.startsWith("--")) throw new Error("tool name is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-tool",
    name,
    ...jsonArgsSource(values),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpResources(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourcesCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-resources",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpResource(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourceCommand {
  const uri = argv[0];
  if (!uri || uri.startsWith("--")) throw new Error("resource uri is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-resource",
    uri,
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpPrompts(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpPromptsCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-prompts",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpPrompt(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpPromptCommand {
  const name = argv[0];
  if (!name || name.startsWith("--")) throw new Error("prompt name is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-prompt",
    name,
    ...jsonArgsSource(values),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseControlDoctor(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ControlDoctorCommand {
  const values = parseFlags(argv);
  return {
    kind: "control-doctor",
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseControllerSupervise(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ControllerSuperviseCommand {
  const values = parseFlags(argv);
  const env = io.env();
  const registryRootDir = option(values, env, "--registry-root", [
    "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT",
    "CODEX_GOAL_REGISTRY_ROOT",
  ]);
  const stateDir = option(values, env, "--state-dir", []);
  const mcpCwd = option(values, env, "--mcp-cwd", []);
  const args: Record<string, unknown> = {
    controllerJobId: requiredOption(values, env, "--controller-job-id", [
      "SUBSCRIPTION_RUNTIME_CONTROLLER_JOB_ID",
    ]),
    ...(registryRootDir
      ? { registryRootDir: resolvePath(io.cwd(), registryRootDir) }
      : {}),
    ...(option(values, env, "--provider", []) ? {
      providerKind: option(values, env, "--provider", []),
    } : {}),
    ...(stateDir ? { stateDir: resolvePath(io.cwd(), stateDir) } : {}),
    ...(option(values, env, "--session-artifact-path", []) ? {
      sessionArtifactPath: option(values, env, "--session-artifact-path", []),
    } : {}),
    ...(option(values, env, "--claude-path", []) ? {
      claudePath: option(values, env, "--claude-path", []),
    } : {}),
    ...(option(values, env, "--mcp-server-name", []) ? {
      mcpServerName: option(values, env, "--mcp-server-name", []),
    } : {}),
    ...(option(values, env, "--mcp-command", []) ? {
      mcpCommand: option(values, env, "--mcp-command", []),
    } : {}),
    ...(option(values, env, "--mcp-args", []) ? {
      mcpArgs: splitCsv(option(values, env, "--mcp-args", []) as string),
    } : {}),
    ...(mcpCwd ? { mcpCwd: resolvePath(io.cwd(), mcpCwd) } : {}),
    ...(option(values, env, "--raw-shell-mode", []) ? {
      rawShellMode: option(values, env, "--raw-shell-mode", []),
    } : {}),
    ...optionalNumberArg(values, "--max-goal-turns", "maxGoalTurns"),
  };
  return {
    kind: "controller-supervise",
    args,
    statusIntervalMs: parseOptionalPositiveInteger(
      option(values, env, "--status-interval-ms", []),
      "--status-interval-ms",
    ) ?? 60_000,
    format: outputFormatFromFlags(values, env),
  };
}

function parseProjectControlOperationRun(
  argv: readonly string[],
  io: CodexGoalCliIo,
): ProjectControlOperationRunCommand {
  const values = parseFlags(argv);
  return {
    kind: "project-control-operation-run",
    operationFilePath: resolvePath(
      io.cwd(),
      requiredOption(values, io.env(), "--operation-file", [
        "SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_FILE",
      ]),
    ),
    format: outputFormatFromFlags(values, io.env()),
  };
}

function parseMcpShortcut(
  commandName: string,
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpToolCommand | undefined {
  return parseCodexGoalCliMcpShortcut(commandName, argv, io);
}

function registryMetadataFromFlags(
  values: ParsedFlags,
): CodexGoalLaunchManifestMetadata | undefined {
  const description =
    values.values.get("--description") ?? values.values.get("--registry-description");
  const tags = splitCsv(
    values.values.get("--tags") ?? values.values.get("--registry-tags") ?? "",
  );
  if (!description && tags.length === 0) return undefined;
  return {
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function optionalNumberArg(
  values: ParsedFlags,
  flagName: string,
  key: string,
): Record<string, unknown> {
  const value = values.values.get(flagName);
  return value === undefined
    ? {}
    : { [key]: parsePositiveInteger(value, flagName) };
}

function jsonArgsSource(values: ParsedFlags): {
  readonly argsJson?: string;
  readonly argsFile?: string;
} {
  const argsJson = values.values.get("--args-json");
  const argsFile = values.values.get("--args-file");
  if (argsJson && argsFile) {
    throw new Error("use only one of --args-json or --args-file");
  }
  return {
    ...(argsJson ? { argsJson } : {}),
    ...(argsFile ? { argsFile } : {}),
  };
}

async function readJsonArgs(
  command: Pick<McpToolCommand | McpPromptCommand, "argsJson" | "argsFile">,
  io: CodexGoalCliIo,
): Promise<Record<string, unknown>> {
  if (command.argsJson) return parseJsonObject(command.argsJson, "--args-json");
  if (command.argsFile) {
    const path = resolvePath(io.cwd(), command.argsFile);
    return parseJsonObject(await readFile(path, "utf8"), "--args-file");
  }
  return {};
}

function parseJsonObject(value: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${source} must be valid JSON: ${
      error instanceof Error ? error.message : "parse failed"
    }`);
  }
  if (!isRecord(parsed)) throw new Error(`${source} must be a JSON object`);
  return parsed;
}

function currentCliPath(): string {
  return fileURLToPath(import.meta.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultIo: CodexGoalCliIo = {
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
  if (!isScratchHelpInvocation(process.argv.slice(2))) enterScratchPrivateMountNamespace();
  installBrokenPipeHandlers();
  process.exitCode = await runCodexGoalCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(currentCliPath())) === (await realpath(process.argv[1]));
  } catch {
    return currentCliPath() === process.argv[1];
  }
}
