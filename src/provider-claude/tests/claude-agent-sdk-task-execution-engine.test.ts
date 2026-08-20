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

  it("enforces the HIB schema, instruction isolation, and denied tools in SDK options", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-hib-"));
    let captured: Options | undefined;
    const schema = {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string" } },
      additionalProperties: false,
    } as const;
    try {
      await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
      await writeFile(join(workspace, "AGENTS.md"), "untrusted instructions\n");
      await symlink(join(workspace, "AGENTS.md"), join(workspace, "alias.md"));
      await mkdir(join(workspace, ".claude", "rules"), { recursive: true });
      await writeFile(
        join(workspace, ".claude", "rules", "project.md"),
        "untrusted rule\n",
      );
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return structuredOutputPolicyQuery(options, { verdict: "approve" });
          },
        }),
      });

      const result = await engine.run(taskInput(workspace, {
        outputSchema: schema,
        workspaceInstructionPolicy: "deny_project_instructions_v1",
        allowedTools: ["Read", "Grep", "Glob"],
        disallowedTools: [
          "Bash",
          "WebFetch",
          "WebSearch",
          "Edit",
          "Write",
          "NotebookEdit",
        ],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }));

      expect(result.structuredOutput).toEqual({ verdict: "approve" });
      expect(captured).toMatchObject({
        outputFormat: { type: "json_schema", schema },
        settingSources: [],
        extraArgs: { "safe-mode": null },
        permissionMode: "dontAsk",
        tools: ["Read", "Grep", "Glob", "StructuredOutput"],
        allowedTools: ["Read", "Grep", "Glob", "StructuredOutput"],
        disallowedTools: [
          "Bash",
          "WebFetch",
          "WebSearch",
          "Edit",
          "Write",
          "NotebookEdit",
        ],
      });
      const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      const structuredHookDecision = await hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "StructuredOutput",
        tool_input: { verdict: "approve" },
        tool_use_id: "tool-structured-output",
        cwd: workspace,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "dontAsk",
      }, "tool-structured-output", { signal: new AbortController().signal });
      expect(structuredHookDecision).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      await expect(captured?.canUseTool?.(
        "StructuredOutput",
        { verdict: "approve" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-structured-output",
          requestId: "request-tool-structured-output",
        },
      )).resolves.toMatchObject({ behavior: "allow" });
      const deniedInstructionCalls = [
        ["Read", { file_path: "AGENTS.md" }],
        ["Read", { file_path: "src/../AGENTS.md" }],
        ["Read", { file_path: "alias.md" }],
        ["Read", { file_path: ".claude/rules/project.md" }],
        ["Grep", { pattern: "secret" }],
        ["Grep", { pattern: "secret", path: workspace }],
        ["Glob", { pattern: "**/AGENTS.md" }],
      ] as const;
      for (const [toolName, toolInput] of deniedInstructionCalls) {
        await expect(captured?.canUseTool?.(
          toolName,
          toolInput,
          {
            signal: new AbortController().signal,
            toolUseID: `tool-${toolName}`,
            requestId: `request-${toolName}`,
          },
        ), `${toolName} ${JSON.stringify(toolInput)}`).resolves.toMatchObject({
          behavior: "deny",
        });
        await expect(hook?.({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: `tool-${toolName}`,
          cwd: workspace,
          session_id: "session-1",
          transcript_path: "",
          permission_mode: "dontAsk",
        }, `tool-${toolName}`, {
          signal: new AbortController().signal,
        })).resolves.toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
      }
      await expect(captured?.canUseTool?.(
        "Read",
        { file_path: "source.ts" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-read-source",
          requestId: "request-read-source",
        },
      )).resolves.toMatchObject({ behavior: "allow" });
      await expect(captured?.canUseTool?.(
        "Grep",
        { pattern: "value", path: "source.ts" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-source",
          requestId: "request-grep-source",
        },
      )).resolves.toMatchObject({ behavior: "allow" });
      for (const toolName of ["Bash", "WebSearch", "Write"]) {
        const decision = await hook?.({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: {},
          tool_use_id: `tool-${toolName}`,
          cwd: workspace,
          session_id: "session-1",
          transcript_path: "",
          permission_mode: "dontAsk",
        }, `tool-${toolName}`, { signal: new AbortController().signal });
        expect(decision, toolName).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps StructuredOutput internal and unavailable without a schema", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-no-schema-"));
    let captured: Options | undefined;
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return successfulQuery();
          },
        }),
      });

      await engine.run(taskInput(workspace, {
        allowedTools: ["Read"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }));

      expect(captured?.tools).toEqual(["Read"]);
      expect(captured?.allowedTools).toEqual(["Read"]);
      expect(captured?.extraArgs).toBeUndefined();
      await expect(captured?.canUseTool?.(
        "StructuredOutput",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-structured-output",
          requestId: "request-tool-structured-output",
        },
      )).resolves.toMatchObject({ behavior: "deny" });
      const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      const hookDecision = await hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "StructuredOutput",
        tool_input: {},
        tool_use_id: "tool-structured-output",
        cwd: workspace,
        session_id: "session-1",
        transcript_path: "",
        permission_mode: "dontAsk",
      }, "tool-structured-output", { signal: new AbortController().signal });
      expect(hookDecision).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("forks a persisted SDK session for typed logical-thread continuation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-thread-"));
    let captured: Options | undefined;
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return successfulQuery();
          },
        }),
      });

      await engine.run(taskInput(workspace, {
        runtimeThread: {
          threadId: "logical-thread-1",
          resumeSessionId: "source-session-1",
        },
      }));

      expect(captured).toMatchObject({
        resume: "source-session-1",
        forkSession: true,
        persistSession: true,
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

  it("preserves bounded SDK structured-output diagnostics", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-output-error-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => errorQuery("error_max_structured_output_retries"),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: { type: "object" },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "provider_output_invalid",
          retryable: true,
          causeCategory: "error_max_structured_output_retries",
          details: {
            sdkSubtype: "error_max_structured_output_retries",
            sdkErrors: "StructuredOutput was denied by host policy",
            permissionDenials: "0",
          },
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

  it("rejects Git metadata paths and selectors without blocking benign dotfiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-git-metadata-"));
    const workspace = join(root, "workspace");
    const gitMetadata = join(workspace, ".git");
    let captured: Options | undefined;
    try {
      await mkdir(workspace);
      await mkdir(gitMetadata);
      await writeFile(join(gitMetadata, "config"), "[core]\n", "utf8");
      await symlink(gitMetadata, join(workspace, "git-metadata-alias"));
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) => {
            captured = options;
            return successfulQuery();
          },
        }),
      });

      await engine.run(taskInput(workspace, {
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "NotebookEdit",
          "Glob",
          "Grep",
          "LS",
        ],
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
      }));
      const hook = captured?.hooks?.PreToolUse?.[0]?.hooks[0];
      const thirtyThreeAlternatives = [
        ...Array.from({ length: 32 }, (_, index) => `safe-${index}`),
        ".git",
      ].join(",");
      const deniedCases = [
        ["Read", { file_path: ".git/config" }],
        ["Edit", { file_path: join(workspace, ".git", "config") }],
        ["Write", {
          file_path: join(workspace, "nested", "..", ".git", "config"),
        }],
        ["NotebookEdit", { notebook_path: ".git/notebook.ipynb" }],
        ["Glob", { path: join(workspace, "nested", ".git", "objects") }],
        ["Glob", { pattern: "**/.git/**" }],
        ["Glob", { pattern: "**/.git{,ignore}/**" }],
        ["Glob", { pattern: "**/[.]git/**" }],
        ["Glob", { pattern: "**/.[g]it/**" }],
        ["Glob", { pattern: "**/.g?t/**" }],
        ["Glob", { pattern: "**/????/**" }],
        ["Grep", { path: join(workspace, ".GIT", "config") }],
        ["Grep", { glob: "{.git,.github}/**" }],
        ["Grep", { glob: "**/?git/**" }],
        ["Glob", { pattern: `**/{${thirtyThreeAlternatives}}/**` }],
        ["Glob", { pattern: "**/{a,b,c,d,e,f,g,h}{0,1,2,3,4,5,6,7,8}/**" }],
        ["Glob", { pattern: "**/{src,{.git,docs}}/**" }],
        ["Glob", { pattern: "**/{src,.git/**" }],
        ["Glob", { pattern: "**/[.git/**" }],
        ["Grep", { glob: "**/src,.git}/**" }],
        ["Grep", { glob: "**/@(.git|src)/**" }],
        ["LS", { path: join(workspace, "git-metadata-alias", "config") }],
      ] as const;

      for (const [toolName, toolInput] of deniedCases) {
        const permission = await captured?.canUseTool?.(
          toolName,
          toolInput,
          {
            signal: new AbortController().signal,
            toolUseID: `tool-${toolName}`,
            requestId: `request-${toolName}`,
          },
        );
        expect(permission, `${toolName} canUseTool`).toMatchObject({
          behavior: "deny",
          interrupt: true,
        });
        const hookDecision = await hook?.({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: `tool-${toolName}`,
          cwd: workspace,
          session_id: "session-1",
          transcript_path: "",
          permission_mode: "acceptEdits",
        }, `tool-${toolName}`, { signal: new AbortController().signal });
        expect(hookDecision, `${toolName} hook`).toMatchObject({
          hookSpecificOutput: { permissionDecision: "deny" },
        });
      }

      const benignCases = [
        ["Glob", { pattern: "**/.github/**" }],
        ["Grep", { glob: ".gitignore" }],
        ["Glob", { pattern: "**/*.ts" }],
      ] as const;
      for (const [toolName, toolInput] of benignCases) {
        const permission = await captured?.canUseTool?.(
          toolName,
          toolInput,
          {
            signal: new AbortController().signal,
            toolUseID: `benign-${toolName}`,
            requestId: `request-benign-${toolName}`,
          },
        );
        expect(permission, `${toolName} benign canUseTool`).toMatchObject({
          behavior: "allow",
        });
        const hookDecision = await hook?.({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: `benign-${toolName}`,
          cwd: workspace,
          session_id: "session-1",
          transcript_path: "",
          permission_mode: "acceptEdits",
        }, `benign-${toolName}`, { signal: new AbortController().signal });
        expect(hookDecision, `${toolName} benign hook`).toMatchObject({
          hookSpecificOutput: { permissionDecision: "allow" },
        });
      }
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

function successfulQuery(structuredOutput?: unknown): Query {
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
      ...(structuredOutput === undefined
        ? {}
        : { structured_output: structuredOutput }),
      uuid: "result-1",
    } as unknown as SDKResultMessage;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function structuredOutputPolicyQuery(
  options: Options,
  structuredOutput: unknown,
): Query {
  const stream = (async function* () {
    const context = {
      signal: new AbortController().signal,
      toolUseID: "tool-structured-output",
      requestId: "request-tool-structured-output",
    };
    const permission = await options.canUseTool?.(
      "StructuredOutput",
      structuredOutput as Record<string, unknown>,
      context,
    );
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const hookDecision = await hook?.({
      hook_event_name: "PreToolUse",
      tool_name: "StructuredOutput",
      tool_input: structuredOutput,
      tool_use_id: "tool-structured-output",
      cwd: options.cwd ?? "/workspace",
      session_id: "session-1",
      transcript_path: "",
      permission_mode: options.permissionMode ?? "default",
    }, "tool-structured-output", context);
    const hookAllowed = hookDecision !== undefined &&
      "hookSpecificOutput" in hookDecision &&
      hookDecision.hookSpecificOutput !== undefined &&
      "permissionDecision" in hookDecision.hookSpecificOutput &&
      hookDecision.hookSpecificOutput.permissionDecision === "allow";
    if (permission?.behavior !== "allow" || !hookAllowed) {
      yield sdkErrorMessage("error_max_structured_output_retries");
      return;
    }
    yield sdkSuccessMessage(structuredOutput);
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function sdkSuccessMessage(
  structuredOutput?: unknown,
): Extract<SDKResultMessage, { readonly subtype: "success" }> {
  return {
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
    ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
    uuid: "result-1",
  } as unknown as Extract<SDKResultMessage, { readonly subtype: "success" }>;
}

function sdkErrorMessage(
  subtype: "error_max_structured_output_retries",
): SDKResultMessage {
  return {
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
    errors: ["StructuredOutput was denied by host policy"],
    uuid: "result-1",
    session_id: "session-1",
  } as unknown as SDKResultMessage;
}

function errorQuery(
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries",
): Query {
  const stream = (async function* () {
    yield subtype === "error_max_structured_output_retries"
      ? sdkErrorMessage(subtype)
      : {
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
