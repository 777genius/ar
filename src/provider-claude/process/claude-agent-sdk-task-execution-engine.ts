import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  Options,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentRuntimeBudgetEnforcement,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTurnLimitEnforcement,
  AgentRuntimeEditMode,
  AgentRuntimeFailureCode,
  AgentRuntimeProviderSandboxMode,
  isProjectInstructionPath,
} from "@vioxen/subscription-runtime/core";
import {
  assertClaudeReadOnlyToolPolicy,
  defaultClaudeReadOnlyTools,
  isReadOnlyClaudeTool,
  mapClaudePermissionMode,
} from "../protocol/claude-permission-policy";
import { ClaudeProviderFailureError } from "../protocol/failure-classifier";
import { claudeAgentSdkTaskAgentCapabilities } from "../capabilities";
import {
  claudeGoalCompletionToolName,
  createClaudeAgentSdkGoalProtocol,
  type ClaudeAgentSdkGoalProtocol,
} from "./claude-agent-sdk-goal-protocol";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "../task/engine-contract";
import { claudeCliChildEnv } from "./claude-cli-env";
import { resultFromSdkMessage } from "./claude-agent-sdk-result";
import { createClaudeAgentSdkSafeDiagnostics } from "./claude-agent-sdk-safe-diagnostics";

type AgentSdkModule = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  "query"
>;

const claudeStructuredOutputToolName = "StructuredOutput";

export type ClaudeAgentSdkTaskExecutionEngineOptions = {
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly binaryPath?: string;
  /** Test/integration seam kept structurally opaque so SDK types stay private. */
  readonly sdkLoader?: () => Promise<unknown>;
};

export class ClaudeAgentSdkTaskExecutionEngine
  implements ClaudeTaskExecutionEngine
{
  readonly kind = "claude-agent-sdk" as const;
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
    turnLimitEnforcement: AgentRuntimeTurnLimitEnforcement.ProviderNative,
    budgetCapabilities: [
      {
        metric: AgentRuntimeBudgetMetric.Usd,
        enforcement: AgentRuntimeBudgetEnforcement.ProviderNative,
      },
    ],
    taskExecutionCapabilities:
      claudeAgentSdkTaskAgentCapabilities.taskExecutionCapabilities!,
    accessBoundaryMode: "provider-enforced",
  } as const;

  constructor(
    private readonly options: ClaudeAgentSdkTaskExecutionEngineOptions = {},
  ) {}

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    if (!input.session.configDir) throw new Error("claude_config_dir_required");
    assertBoundedClaudeGoal(input);
    const { query } = asAgentSdkModule(
      await (this.options.sdkLoader ?? loadAgentSdk)(),
    );
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (input.abortSignal.aborted) abort();
    else input.abortSignal.addEventListener("abort", abort, { once: true });

    let stream: Query | undefined;
    try {
      const goalProtocol = input.execution?.mode === AgentRuntimeExecutionMode.Goal
        ? createClaudeAgentSdkGoalProtocol({
            completionCondition: input.execution.completionCondition,
          })
        : undefined;
      const tools = toolsForInput(input);
      const providerTools = appendInternalTool(
        tools,
        input.outputSchema === undefined ? undefined : claudeStructuredOutputToolName,
      );
      const allowedTools = goalProtocol
        ? [...(providerTools ?? []), claudeGoalCompletionToolName]
        : providerTools;
      const disallowedTools = input.outputSchema === undefined
        ? input.disallowedTools
        : input.disallowedTools?.filter(
            (tool) => tool !== claudeStructuredOutputToolName,
          );
      const policyAudit = new Set<string>();
      const evaluateToolPolicy = createToolPolicyEvaluator(
        input,
        policyAudit,
        goalProtocol,
      );
      const options: Options = {
        cwd: input.workspacePath,
        model: input.model,
        ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
        ...(input.maxBudgetUsd === undefined
          ? {}
          : { maxBudgetUsd: input.maxBudgetUsd }),
        ...(providerTools === undefined
          ? {}
          : { tools: [...providerTools] }),
        ...(allowedTools === undefined
          ? {}
          : { allowedTools: [...allowedTools] }),
        ...(disallowedTools === undefined
          ? {}
          : { disallowedTools: [...disallowedTools] }),
        ...(input.outputSchema === undefined
          ? {}
          : {
              outputFormat: {
                type: "json_schema" as const,
                schema: input.outputSchema,
              },
            }),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(input.appendSystemPrompt === undefined
            ? {}
            : { append: input.appendSystemPrompt }),
        },
        ...(input.workspaceInstructionPolicy === "deny_project_instructions_v1"
          ? {
              // This contract is stronger than an empty settings source list:
              // safe mode also disables CLAUDE.md, skills, plugins, hooks,
              // MCP, and other settings-sourced customizations. Programmatic
              // SDK hooks and MCP servers remain explicit options below.
              extraArgs: { "safe-mode": null },
            }
          : {}),
        ...(this.options.binaryPath === undefined
          ? {}
          : { pathToClaudeCodeExecutable: this.options.binaryPath }),
        abortController,
        canUseTool: createToolGuard(evaluateToolPolicy),
        hooks: {
          PreToolUse: [{ hooks: [createPreToolUseHook(evaluateToolPolicy)] }],
          ...(goalProtocol
            ? { Stop: [{ hooks: [goalProtocol.stopHook] }] }
            : {}),
        },
        ...(goalProtocol ? { mcpServers: goalProtocol.mcpServers } : {}),
        env: claudeCliChildEnv({
          baseEnv: this.options.baseEnv ?? process.env,
          configDir: input.session.configDir,
          oauthToken: input.session.oauthToken,
        }),
        ...permissionOptions(input),
        ...(input.runtimeThread?.resumeSessionId === undefined
          ? {}
          : {
              resume: input.runtimeThread.resumeSessionId,
              forkSession: true,
            }),
        persistSession: input.runtimeThread !== undefined,
        sandbox: sandboxOptions(input),
        settingSources: [],
      };
      stream = query({ prompt: input.prompt, options });
      const safeDiagnostics = createClaudeAgentSdkSafeDiagnostics();
      for await (const message of stream) {
        safeDiagnostics.observe(message);
        if (message.type !== "result") continue;
        const result = resultFromSdkMessage(
          message,
          input,
          policyAudit,
          safeDiagnostics,
        );
        if (goalProtocol && !goalProtocol.isComplete()) {
          throw new ClaudeProviderFailureError({
            code: AgentRuntimeFailureCode.GoalSliceExhausted,
            retryable: false,
            reconnectRequired: false,
            safeMessage:
              "Claude stopped before reporting verified Goal completion.",
          }, result.telemetry);
        }
        return result;
      }
      throw new Error("claude_agent_sdk_result_missing");
    } finally {
      stream?.close();
      input.abortSignal.removeEventListener("abort", abort);
    }
  }
}

type ToolPolicyEvaluator = (
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
) => Promise<{ readonly allowed: boolean; readonly reason: string }>;

function createToolGuard(evaluate: ToolPolicyEvaluator): CanUseTool {
  return async (toolName, toolInput): Promise<PermissionResult> => {
    const decision = await evaluate(toolName, toolInput);
    return decision.allowed ? { behavior: "allow" } : deny(decision.reason);
  };
}

function createPreToolUseHook(evaluate: ToolPolicyEvaluator): HookCallback {
  return async (hookInput): Promise<HookJSONOutput> => {
    if (hookInput.hook_event_name !== "PreToolUse") return { continue: true };
    const toolInput = isObject(hookInput.tool_input) ? hookInput.tool_input : {};
    const decision = await evaluate(hookInput.tool_name, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.allowed ? "allow" : "deny",
        ...(decision.allowed
          ? {}
          : { permissionDecisionReason: decision.reason }),
      },
    };
  };
}

function createToolPolicyEvaluator(
  input: ClaudeTaskEngineInput,
  audit: Set<string>,
  goalProtocol?: ClaudeAgentSdkGoalProtocol,
): ToolPolicyEvaluator {
  const allowed = input.allowedTools === undefined
    ? undefined
    : new Set(input.allowedTools);
  const denied = new Set(input.disallowedTools ?? []);
  return async (toolName, toolInput) => {
    if (toolName === claudeStructuredOutputToolName) {
      return input.outputSchema === undefined
        ? rejectWithAudit(
            audit,
            toolName,
            ToolPolicyDenialReason.OutsidePolicy,
            "Structured output is unavailable without an output schema.",
          )
        : accept();
    }
    goalProtocol?.noteToolUse(toolName);
    if (toolName === claudeGoalCompletionToolName) return accept();
    if (denied.has(toolName) || (allowed !== undefined && !allowed.has(toolName))) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.OutsidePolicy,
        "Tool is outside the task tool policy.",
      );
    }
    if (input.editMode === AgentRuntimeEditMode.ReadOnly) {
      if (!isReadOnlyClaudeTool(toolName)) {
        return rejectWithAudit(
          audit,
          toolName,
          ToolPolicyDenialReason.ReadOnlyBoundary,
          "Tool is not available inside a read-only boundary.",
        );
      }
    }
    const selector = gitMetadataSelector(toolName, toolInput);
    if (selector === GitMetadataSelectorDecision.Invalid) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.InvalidPath,
        "Tool path selector is invalid.",
      );
    }
    if (selector === GitMetadataSelectorDecision.GitMetadata) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.GitMetadataPath,
        "Direct access to Git metadata is not allowed.",
      );
    }
    const pathField = toolPathField(toolName);
    if (pathField === null) return accept();
    const candidate = toolInput[pathField];
    if (candidate === undefined && (toolName === "Grep" || toolName === "Glob")) {
      if (
        input.workspaceInstructionPolicy === "deny_project_instructions_v1" &&
        (toolName === "Grep" ||
          (typeof toolInput.pattern === "string" &&
            isProjectInstructionPath(toolInput.pattern)))
      ) {
        return rejectWithAudit(
          audit,
          toolName,
          ToolPolicyDenialReason.ProjectInstructionPath,
          "Search could expose project instruction paths under this task policy.",
        );
      }
      return accept();
    }
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.InvalidPath,
        "Tool path is missing or invalid.",
      );
    }
    if (
      input.workspaceInstructionPolicy === "deny_project_instructions_v1" &&
      await targetsProjectInstructions(
        input.workspacePath,
        toolName,
        candidate,
        toolInput,
      )
    ) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.ProjectInstructionPath,
        "Project instruction paths are unavailable under this task policy.",
      );
    }
    const pathDecision = await workspacePathDecision(
      input.workspacePath,
      candidate,
    );
    if (pathDecision === WorkspacePathDecision.GitMetadata) {
      return rejectWithAudit(
        audit,
        toolName,
        ToolPolicyDenialReason.GitMetadataPath,
        "Direct access to Git metadata is not allowed.",
      );
    }
    if (
      input.providerSandboxMode ===
      AgentRuntimeProviderSandboxMode.DangerFullAccess
    ) {
      return accept();
    }
    return pathDecision === WorkspacePathDecision.Allowed
      ? accept()
      : rejectWithAudit(
          audit,
          toolName,
          ToolPolicyDenialReason.PathOutsideWorkspace,
          "Tool path must stay within the task workspace.",
        );
  };
}

async function targetsProjectInstructions(
  workspacePath: string,
  toolName: string,
  candidate: string,
  toolInput: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (isProjectInstructionPath(candidate)) return true;
  const selector = toolName === "Glob"
    ? toolInput.pattern
    : toolName === "Grep"
      ? toolInput.glob
      : undefined;
  if (typeof selector === "string" && isProjectInstructionPath(selector)) {
    return true;
  }
  const root = await realpath(resolve(workspacePath));
  try {
    const canonical = await realpath(resolve(root, candidate));
    if (isProjectInstructionPath(relative(root, canonical))) return true;
    // Native Grep recursively reads directory contents and cannot exclude the
    // denied instruction files. It is safe here only for one explicit file.
    return toolName === "Grep" && !(await lstat(canonical)).isFile();
  } catch {
    return toolName === "Grep";
  }
}

function appendInternalTool(
  tools: readonly string[] | undefined,
  internalTool: string | undefined,
): readonly string[] | undefined {
  if (internalTool === undefined || tools === undefined) return tools;
  return tools.includes(internalTool) ? tools : [...tools, internalTool];
}

function assertBoundedClaudeGoal(input: ClaudeTaskEngineInput): void {
  if (input.execution?.mode !== AgentRuntimeExecutionMode.Goal) return;
  const failure = (safeMessage: string): never => {
    throw new ClaudeProviderFailureError({
      code: AgentRuntimeFailureCode.TaskRequestInvalid,
      retryable: false,
      reconnectRequired: false,
      safeMessage,
    });
  };
  if (input.maxTurns === undefined) {
    failure("Claude Goal execution requires an explicit provider turn limit.");
  }
  if (input.maxBudgetUsd === undefined) {
    failure("Claude Goal execution requires an explicit USD budget.");
  }
  if (!input.allowedTools || input.allowedTools.length === 0) {
    failure("Claude Goal execution requires an explicit non-empty tool allowlist.");
  }
  if (input.editMode === undefined) {
    failure("Claude Goal execution requires an explicit access boundary.");
  }
  if (
    input.providerSandboxMode ===
    AgentRuntimeProviderSandboxMode.DangerFullAccess
  ) {
    failure("Claude Goal execution does not support danger-full-access.");
  }
}

enum ToolPolicyDenialReason {
  OutsidePolicy = "outside_policy",
  ReadOnlyBoundary = "read_only_boundary",
  InvalidPath = "invalid_path",
  PathOutsideWorkspace = "path_outside_workspace",
  GitMetadataPath = "git_metadata_path",
  ProjectInstructionPath = "project_instruction_path",
}

function toolsForInput(
  input: ClaudeTaskEngineInput,
): readonly string[] | undefined {
  assertClaudeReadOnlyToolPolicy(input.editMode, input.allowedTools);
  if (input.editMode !== AgentRuntimeEditMode.ReadOnly) {
    return input.allowedTools;
  }
  return input.allowedTools ?? defaultClaudeReadOnlyTools;
}

function permissionOptions(
  input: ClaudeTaskEngineInput,
): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  const permissionMode = mapClaudePermissionMode(
    input.editMode,
    input.providerSandboxMode,
  );
  return {
    permissionMode,
    ...(permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
  };
}

function sandboxOptions(input: ClaudeTaskEngineInput): NonNullable<Options["sandbox"]> {
  if (
    input.providerSandboxMode ===
    AgentRuntimeProviderSandboxMode.DangerFullAccess
  ) {
    return { enabled: false };
  }
  return {
    enabled: true,
    // Path-scoped file tools are enforced by both canUseTool and PreToolUse.
    // Any broader surface requires the provider sandbox as a hard gate.
    failIfUnavailable: requiresProviderSandbox(input),
    allowUnsandboxedCommands: false,
    filesystem: {
      allowRead: [input.workspacePath],
      allowWrite:
        input.editMode === AgentRuntimeEditMode.ReadOnly
          ? []
          : [input.workspacePath],
    },
  };
}

const workspacePathGuardedClaudeTools = new Set([
  "Edit",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "Read",
  "Write",
]);

function requiresProviderSandbox(input: ClaudeTaskEngineInput): boolean {
  if (input.allowedTools === undefined) return true;
  return input.allowedTools.some(
    (tool) => !workspacePathGuardedClaudeTools.has(tool),
  );
}

function toolPathField(toolName: string): string | null {
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      return "file_path";
    case "NotebookEdit":
      return "notebook_path";
    case "Grep":
    case "Glob":
    case "LS":
      return "path";
    default:
      return null;
  }
}

enum GitMetadataSelectorDecision {
  Allowed = "allowed",
  Invalid = "invalid",
  GitMetadata = "git_metadata",
}

function gitMetadataSelector(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): GitMetadataSelectorDecision {
  const field = toolName === "Glob"
    ? "pattern"
    : toolName === "Grep"
      ? "glob"
      : null;
  if (field === null || toolInput[field] === undefined) {
    return GitMetadataSelectorDecision.Allowed;
  }
  const selector = toolInput[field];
  if (
    typeof selector !== "string" ||
    selector.trim().length === 0 ||
    selector.length > 4_096
  ) {
    return GitMetadataSelectorDecision.Invalid;
  }
  return globSelectorGitMetadataDecision(selector);
}

function globSelectorGitMetadataDecision(
  selector: string,
): GitMetadataSelectorDecision {
  let decision = GitMetadataSelectorDecision.Allowed;
  for (const segment of selector.split(/[\\/]+/)) {
    const expansion = expandBraceAlternatives(segment.toLowerCase());
    if (expansion.status === GlobExpansionStatus.Unsupported) {
      return GitMetadataSelectorDecision.Invalid;
    }
    if (
      expansion.patterns.some((pattern) =>
        globSegmentMatches(pattern, ".git") &&
        globPatternHasExplicitGitSignal(pattern)
      )
    ) {
      decision = GitMetadataSelectorDecision.GitMetadata;
    }
  }
  return decision;
}

function globPatternHasExplicitGitSignal(pattern: string): boolean {
  if (pattern === "?".repeat(".git".length)) return true;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) continue;
      const characterClass = pattern.slice(index + 1, end);
      const negated = characterClass[0] === "!" || characterClass[0] === "^";
      if (
        !negated &&
        [...".git"].some((value) =>
          globCharacterClassMatches(characterClass, value)
        )
      ) {
        return true;
      }
      index = end;
      continue;
    }
    if (character === "." || character === "g" || character === "i" || character === "t") {
      return true;
    }
  }
  return false;
}

enum GlobExpansionStatus {
  Supported = "supported",
  Unsupported = "unsupported",
}

type GlobExpansionResult =
  | {
      readonly status: GlobExpansionStatus.Supported;
      readonly patterns: readonly string[];
    }
  | {
      readonly status: GlobExpansionStatus.Unsupported;
    };

function expandBraceAlternatives(pattern: string): GlobExpansionResult {
  if (hasUnsupportedGlobSyntax(pattern)) {
    return { status: GlobExpansionStatus.Unsupported };
  }

  let expanded = [pattern];
  while (true) {
    const next: string[] = [];
    let changed = false;
    for (const candidate of expanded) {
      const start = candidate.indexOf("{");
      const end = start === -1 ? -1 : candidate.indexOf("}", start + 1);
      if (start === -1 || end === -1) {
        next.push(candidate);
        continue;
      }
      const alternatives = candidate.slice(start + 1, end).split(",");
      if (alternatives.length < 2 || alternatives.length > 32) {
        return { status: GlobExpansionStatus.Unsupported };
      }
      if (next.length + alternatives.length > 64) {
        return { status: GlobExpansionStatus.Unsupported };
      }
      changed = true;
      for (const alternative of alternatives) {
        next.push(
          `${candidate.slice(0, start)}${alternative}${candidate.slice(end + 1)}`,
        );
      }
    }
    expanded = next;
    if (!changed) break;
  }
  return {
    status: GlobExpansionStatus.Supported,
    patterns: expanded,
  };
}

function hasUnsupportedGlobSyntax(pattern: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) return true;
      const characterClass = pattern.slice(index + 1, end);
      const negated = characterClass[0] === "!" || characterClass[0] === "^";
      if (
        characterClass.length === 0 ||
        (negated && characterClass.length === 1) ||
        characterClass.includes("[")
      ) {
        return true;
      }
      index = end;
      continue;
    }
    if (character === "]") return true;
    if (
      (character === "?" || character === "*" || character === "+" ||
        character === "@" || character === "!") &&
      pattern[index + 1] === "("
    ) {
      return true;
    }
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > 1) return true;
    } else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return true;
    }
  }
  return braceDepth !== 0;
}

function globSegmentMatches(pattern: string, value: string): boolean {
  const memo = new Map<string, boolean>();
  const matches = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === pattern.length) {
      result = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*") {
      result = matches(patternIndex + 1, valueIndex) ||
        (valueIndex < value.length && matches(patternIndex, valueIndex + 1));
    } else if (pattern[patternIndex] === "?") {
      result = valueIndex < value.length &&
        matches(patternIndex + 1, valueIndex + 1);
    } else if (pattern[patternIndex] === "[") {
      const end = pattern.indexOf("]", patternIndex + 1);
      result = end !== -1 && valueIndex < value.length &&
        globCharacterClassMatches(
          pattern.slice(patternIndex + 1, end),
          value[valueIndex]!,
        ) && matches(end + 1, valueIndex + 1);
    } else {
      result = valueIndex < value.length &&
        pattern[patternIndex] === value[valueIndex] &&
        matches(patternIndex + 1, valueIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matches(0, 0);
}

function globCharacterClassMatches(characterClass: string, value: string): boolean {
  if (characterClass.length === 0) return false;
  const negated = characterClass[0] === "!" || characterClass[0] === "^";
  const body = negated ? characterClass.slice(1) : characterClass;
  let matched = false;
  for (let index = 0; index < body.length; index += 1) {
    if (
      index + 2 < body.length &&
      body[index + 1] === "-" &&
      body[index]! <= value &&
      value <= body[index + 2]!
    ) {
      matched = true;
      index += 2;
    } else if (body[index] === value) {
      matched = true;
    }
  }
  return negated ? !matched : matched;
}

enum WorkspacePathDecision {
  Allowed = "allowed",
  OutsideWorkspace = "outside_workspace",
  GitMetadata = "git_metadata",
}

async function workspacePathDecision(
  workspacePath: string,
  requestedPath: string,
): Promise<WorkspacePathDecision> {
  const root = await realpath(resolve(workspacePath));
  const requested = resolve(root, requestedPath);
  if (hasGitMetadataSegment(root, requested)) {
    return WorkspacePathDecision.GitMetadata;
  }

  let existing = requested;
  while (true) {
    try {
      const canonicalParent = await realpath(existing);
      const canonicalTarget = resolve(
        canonicalParent,
        relative(existing, requested),
      );
      if (hasGitMetadataSegment(root, canonicalTarget)) {
        return WorkspacePathDecision.GitMetadata;
      }
      return isWithin(root, canonicalTarget)
        ? WorkspacePathDecision.Allowed
        : WorkspacePathDecision.OutsideWorkspace;
    } catch (error) {
      if (!isMissingPath(error)) return WorkspacePathDecision.OutsideWorkspace;
      const parent = dirname(existing);
      if (parent === existing) return WorkspacePathDecision.OutsideWorkspace;
      existing = parent;
    }
  }
}

function hasGitMetadataSegment(root: string, candidate: string): boolean {
  return relative(root, candidate)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === ".git");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message, interrupt: true };
}

function accept(): { readonly allowed: true; readonly reason: "" } {
  return { allowed: true, reason: "" };
}

function reject(reason: string): { readonly allowed: false; readonly reason: string } {
  return { allowed: false, reason };
}

function rejectWithAudit(
  audit: Set<string>,
  toolName: string,
  denialReason: ToolPolicyDenialReason,
  message: string,
): { readonly allowed: false; readonly reason: string } {
  audit.add(`${toolName}:${denialReason}`);
  return reject(message);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function loadAgentSdk(): Promise<AgentSdkModule> {
  return import("@anthropic-ai/claude-agent-sdk");
}

function asAgentSdkModule(value: unknown): AgentSdkModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("query" in value) ||
    typeof value.query !== "function"
  ) {
    throw new Error("claude_agent_sdk_module_invalid");
  }
  return value as AgentSdkModule;
}
