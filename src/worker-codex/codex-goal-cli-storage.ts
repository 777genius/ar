import { resolveCodexGoalPaths, resolveCodexGoalStorageRoot } from "./application/codex-goal-storage-paths";
import { option, outputFormatFromFlags, parseFlags, resolvePath,
  type CodexGoalCliIo, type OutputFormat, type ParsedFlags } from "./codex-goal-cli-support";

export type McpResourcesCommand = {
  readonly kind: "mcp-resources";
  readonly storageRootDir?: string;
  readonly registryRootDir?: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly format: OutputFormat;
};

export type McpResourceCommand = {
  readonly kind: "mcp-resource";
  readonly storageRootDir?: string;
  readonly registryRootDir?: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly uri: string;
  readonly format: OutputFormat;
};

export function cliGoalPaths(values: ParsedFlags, env: Readonly<Record<string, string | undefined>>, cwd: string, taskId: string) {
  if (values.flags.has("--storage-root")) throw new Error("--storage-root requires a value");
  const selected = (flagName: string, names: readonly string[] = []) => {
    const value = option(values, env, flagName, names);
    return value === undefined ? undefined : resolvePath(cwd, value);
  };
  return resolveCodexGoalPaths({ taskId,
    jobId: option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]),
    storageRootDir: resolveCodexGoalStorageRoot(option(values, env, "--storage-root", ["SUBSCRIPTION_RUNTIME_STORAGE_ROOT"]), cwd),
    jobRootDir: selected("--job-root", ["SUBSCRIPTION_RUNTIME_JOB_ROOT"]),
    workspacePath: selected("--workspace", ["SUBSCRIPTION_RUNTIME_WORKSPACE_PATH", "MEMO_STACK_GOAL_WORKSPACE_PATH"]),
    stateRootDir: selected("--state-root"), runtimeHomeRootDir: selected("--runtime-home-root"),
    encryptionKeyPath: selected("--encryption-key-path"),
    durableHandoffRootDir: selected("--durable-handoff-root", ["SUBSCRIPTION_RUNTIME_DURABLE_HANDOFF_ROOT"]),
    runtimeEventsPath: selected("--runtime-events"), agentTempRootDir: selected("--agent-temp-root"),
    outputPath: selected("--output"), progressPath: selected("--progress"), logPath: selected("--log"), sourceEnv: env,
  });
}

export function cliInspectionPaths(values: ParsedFlags, env: Readonly<Record<string, string | undefined>>, cwd: string, taskId: string | undefined) {
  if (values.flags.has("--storage-root")) throw new Error("--storage-root requires a value");
  const root = option(values, env, "--storage-root", ["SUBSCRIPTION_RUNTIME_STORAGE_ROOT"]);
  if (root === undefined) return undefined;
  resolveCodexGoalStorageRoot(root, cwd);
  if (taskId === undefined) return undefined;
  const workspace = option(values, env, "--workspace", ["SUBSCRIPTION_RUNTIME_WORKSPACE_PATH", "MEMO_STACK_GOAL_WORKSPACE_PATH"]);
  const jobRoot = option(values, env, "--job-root", ["SUBSCRIPTION_RUNTIME_JOB_ROOT"]);
  const inspectionValues = workspace !== undefined || jobRoot === undefined ? values : {
    ...values, values: new Map([...values.values, ["--workspace", jobRoot]]),
  };
  return cliGoalPaths(inspectionValues, env, cwd, taskId);
}

function resourceStorageOptions(values: ParsedFlags, io: CodexGoalCliIo) {
  const env = { ...io.env() };
  if (values.flags.has("--storage-root")) throw new Error("--storage-root requires a value");
  const root = option(values, env, "--storage-root", ["SUBSCRIPTION_RUNTIME_STORAGE_ROOT"]);
  const registry = option(values, env, "--registry-root", ["SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"]);
  const storageRootDir = resolveCodexGoalStorageRoot(root, io.cwd());
  return {
    ...(storageRootDir === undefined ? {} : { storageRootDir }),
    ...(registry === undefined ? {} : { registryRootDir: resolvePath(io.cwd(), registry) }),
    sourceEnv: env,
  };
}

export function parseMcpResources(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourcesCommand {
  const values = parseFlags(argv);
  return {
    kind: "mcp-resources",
    ...resourceStorageOptions(values, io),
    format: outputFormatFromFlags(values, io.env()),
  };
}

export function parseMcpResource(
  argv: readonly string[],
  io: CodexGoalCliIo,
): McpResourceCommand {
  const uri = argv[0];
  if (!uri || uri.startsWith("--")) throw new Error("resource uri is required");
  const values = parseFlags(argv.slice(1));
  return {
    kind: "mcp-resource",
    ...resourceStorageOptions(values, io),
    uri,
    format: outputFormatFromFlags(values, io.env()),
  };
}
