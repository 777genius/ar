import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  Query,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentRuntimeEditMode,
  AgentRuntimeExecutionMode,
  AgentRuntimeProviderSandboxMode,
  DefaultRedactor,
  type ProcessResult,
  type RunnerCapabilities,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { describe, expect, it } from "vitest";
import {
  ClaudeAgentSdkTaskExecutionEngine,
  type ClaudeTaskEngineInput,
} from "../index";

describe("ClaudeAgentSdkTaskExecutionEngine", () => {
  it("advertises provider-native SingleRun and Goal execution", () => {
    const engine = new ClaudeAgentSdkTaskExecutionEngine();

    expect(engine.capabilities.taskExecutionCapabilities).toEqual([
      { mode: AgentRuntimeExecutionMode.SingleRun },
      {
        mode: AgentRuntimeExecutionMode.Goal,
        maxCompletionConditionChars: 4_000,
      },
    ]);
  });

  it("forwards hard limits and enforces isolated workspace access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-"));
    let captured: Options | undefined;
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        baseEnv: { PATH: "/usr/bin", SECRET_TOKEN: "must-not-leak" },
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return successfulQuery();
          },
        }),
      });

      const result = await engine.run(taskInput(workspace, {
        appendSystemPrompt: "Only change the requested fixture.",
        maxBudgetUsd: 0.25,
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
      }));

      expect(result).toMatchObject({
        outputText: "completed",
        telemetry: {
          turns: 2,
          cost: { amount: 0.1, currency: "USD" },
        },
      });
      expect(captured).toMatchObject({
        maxBudgetUsd: 0.25,
        tools: ["Read", "Write"],
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "Only change the requested fixture.",
        },
        permissionMode: "acceptEdits",
        persistSession: false,
        settingSources: [],
        sandbox: {
          enabled: true,
          failIfUnavailable: false,
          allowUnsandboxedCommands: false,
          filesystem: {
            allowRead: [workspace],
            allowWrite: [workspace],
          },
        },
      });
      expect(captured?.env).not.toHaveProperty("SECRET_TOKEN");

      const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      const outside = await hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(workspace, "..", "outside.txt") },
        tool_use_id: "tool-1",
        cwd: workspace,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "acceptEdits",
      }, "tool-1", { signal: new AbortController().signal });
      expect(outside).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("restricts read-only tasks to read tools and disables sandbox only for acknowledged full access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-"));
    const captures: Options[] = [];
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            if (!options) throw new Error("expected SDK options");
            captures.push(options);
            return successfulQuery();
          },
        }),
      });

      await engine.run(taskInput(workspace, {
        editMode: AgentRuntimeEditMode.ReadOnly,
      }));
      await engine.run(taskInput(workspace, {
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.DangerFullAccess,
      }));
      await engine.run(taskInput(workspace, {
        allowedTools: ["Bash"],
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
      }));
      await engine.run(taskInput(workspace, {
        allowedTools: ["WebFetch", "WebSearch"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }));

      expect(captures[0]).toMatchObject({
        permissionMode: "dontAsk",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        sandbox: {
          enabled: true,
          filesystem: { allowWrite: [] },
        },
      });
      expect(captures[0]?.tools).toEqual(expect.arrayContaining([
        "Read",
        "Grep",
        "Glob",
      ]));
      expect(captures[0]?.tools).not.toContain("Write");
      expect(captures[0]?.tools).not.toContain("WebFetch");
      expect(captures[0]?.tools).not.toContain("WebSearch");
      expect(captures[0]?.allowedTools).toEqual(captures[0]?.tools);
      expect(captures[1]).toMatchObject({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
      });
      expect(captures[2]).toMatchObject({
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
        },
      });
      expect(captures[3]?.tools).toEqual(["WebFetch", "WebSearch"]);
      const webHook = captures[3]?.hooks?.PreToolUse?.[0]?.hooks[0];
      const webDecision = await webHook?.({
        hook_event_name: "PreToolUse",
        tool_name: "WebSearch",
        tool_input: { query: "current documentation" },
        tool_use_id: "tool-web",
        cwd: workspace,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "dontAsk",
      }, "tool-web", { signal: new AbortController().signal });
      expect(webDecision).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes SDK turn exhaustion into a typed provider failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => errorQuery("error_max_turns"),
        }),
      });

      await expect(engine.run(taskInput(workspace, {}))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "goal_slice_exhausted",
          retryable: false,
          causeCategory: "error_max_turns",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("normalizes SDK budget exhaustion into a non-retryable budget failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-budget-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => errorQuery("error_max_budget_usd"),
        }),
      });

      await expect(engine.run(taskInput(workspace, { maxBudgetUsd: 0.01 })))
        .rejects.toMatchObject({
          name: "ClaudeProviderFailureError",
          failure: {
            code: "budget_exceeded",
            retryable: false,
            causeCategory: "error_max_budget_usd",
          },
        });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("accepts canonical aliases inside the workspace without weakening symlink escape checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-alias-"));
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    const outside = join(root, "outside");
    let captured: Options | undefined;
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(workspace, "value.txt"), "41\n", "utf8");
      await writeFile(join(outside, "value.txt"), "outside\n", "utf8");
      await symlink(workspace, alias);
      await symlink(outside, join(workspace, "outside-link"));
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return successfulQuery();
          },
        }),
      });

      await engine.run(taskInput(alias, {
        allowedTools: ["Read"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }));
      const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      const decision = await hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(alias, "value.txt") },
        tool_use_id: "tool-1",
        cwd: alias,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "dontAsk",
      }, "tool-1", { signal: new AbortController().signal });

      expect(decision).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      const escape = await hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(alias, "outside-link", "value.txt") },
        tool_use_id: "tool-2",
        cwd: alias,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "dontAsk",
      }, "tool-2", { signal: new AbortController().signal });
      expect(escape).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function taskInput(
  workspacePath: string,
  overrides: Partial<ClaudeTaskEngineInput>,
): ClaudeTaskEngineInput {
  return {
    abortSignal: new AbortController().signal,
    model: "claude-test",
    execution: { mode: AgentRuntimeExecutionMode.SingleRun },
    prompt: "Fix the test fixture.",
    redactor: new DefaultRedactor(),
    runner: new StaticRunner(),
    session: {
      authMode: "oauth",
      configDir: join(workspacePath, ".claude"),
      oauthToken: "oauth-secret",
    },
    workspacePath,
    ...overrides,
  };
}

function successfulQuery(): Query {
  const stream = (async function* () {
    yield {
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 2,
      result: "completed",
      stop_reason: "end_turn",
      session_id: "session-1",
      total_cost_usd: 0.1,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: "result-1",
    } as unknown as SDKResultMessage;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function errorQuery(
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries",
): Query {
  const stream = (async function* () {
    yield {
      type: "result",
      subtype,
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 3,
      stop_reason: null,
      total_cost_usd: 0.1,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: "result-1",
      session_id: "session-1",
    } as unknown as SDKResultMessage;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

const runnerCapabilities: RunnerCapabilities = {
  runnerId: "unused-test-runner",
  supportsEnvAllowlist: true,
  supportsWorkingDirectory: true,
  supportsTimeout: true,
  supportsAbortSignal: true,
  supportsOutputRedaction: true,
  supportsReadOnlySandbox: true,
  readOnlyFilesystem: false,
  platform: "node-process",
};

class StaticRunner implements RunnerPort {
  readonly runnerId = runnerCapabilities.runnerId;
  readonly capabilities = runnerCapabilities;

  async run(): Promise<ProcessResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }
}
