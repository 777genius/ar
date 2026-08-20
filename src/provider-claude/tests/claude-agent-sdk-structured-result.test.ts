import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("ClaudeAgentSdkTaskExecutionEngine structured results", () => {
  it("recovers a schema-valid structured result from the SDK result text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('{"verdict":"APPROVE"}'),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: {
          type: "object",
          properties: { verdict: { const: "APPROVE" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      }))).resolves.toMatchObject({
        outputText: '{"verdict":"APPROVE"}',
        structuredOutput: { verdict: "APPROVE" },
        warnings: [{ code: "claude_structured_output_text_fallback" }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty", "", "fallback_empty"],
    ["non-JSON", "completed", "fallback_non_json"],
    ["schema mismatch", '{"verdict":"NEEDS_WORK"}', "fallback_schema_mismatch"],
    ["additional property", '{"verdict":"APPROVE","__proto__":{}}', "fallback_schema_mismatch"],
  ])("fails closed for %s SDK result text without structured output", async (
    _case,
    resultText,
    expectedReason,
  ) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({ query: () => successResultTextQuery(resultText) }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: {
          type: "object",
          properties: { verdict: { const: "APPROVE" } },
          required: ["verdict"],
          additionalProperties: false,
        },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "provider_output_invalid",
          causeCategory: "success_without_structured_output",
          details: {
            sdkSubtype: "success",
            sdkErrors: expectedReason,
            permissionDenials: "0",
            hostPolicyDenials: "none",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when fallback schema formats have no validator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-schema-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => successResultTextQuery('"not-an-email"'),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: { type: "string", format: "email" },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "provider_output_invalid",
          details: { sdkErrors: "fallback_schema_compile" },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["quota text", "You've hit your usage limit", "quota_limited", false],
    ["OAuth text", "OAuth token expired", "needs_reconnect", true],
  ])("classifies success plus is_error %s before structured output", async (
    _case,
    resultText,
    expectedCode,
    reconnectRequired,
  ) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkMessageQuery({
            ...sdkSuccessMessage({ verdict: "APPROVE" }),
            is_error: true,
            result: resultText,
          }),
        }),
      });

      await expect(engine.run(taskInput(workspace, {
        outputSchema: { type: "object" },
      }))).rejects.toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: expectedCode,
          reconnectRequired,
          details: {
            sdkSubtype: "success",
            sdkErrors: "success_is_error",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts unknown success plus is_error output from the serialized failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    const redactor = new DefaultRedactor();
    const sentinel = "hib-sensitive-sentinel-value";
    redactor.registerSecret(sentinel, "synthetic");
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: () => sdkMessageQuery({
            ...sdkSuccessMessage(),
            is_error: true,
            result: `unclassified provider failure ${sentinel}`,
          }),
        }),
      });

      const failure = await engine.run(taskInput(workspace, { redactor }))
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        name: "ClaudeProviderFailureError",
        failure: {
          code: "unknown_runtime_failure",
          causeCategory: "sdk_success_is_error",
          details: { sdkErrors: "success_is_error" },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain("unclassified provider failure");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bounds success diagnostics to fixed fields and redacted denied tool names", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-api-error-"));
    const redactor = new DefaultRedactor();
    const sentinel = "hib-denied-tool-sensitive-sentinel";
    redactor.registerSecret(sentinel, "synthetic");
    try {
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        sdkLoader: async () => ({
          query: ({ options }: { options: Options }) =>
            successErrorAfterPolicyDenialQuery(options, {
              ...sdkSuccessMessage(),
              is_error: true,
              result: "temporary service failure",
              permission_denials: [
                { tool_name: `Read-${sentinel}`, tool_use_id: "tool-1", tool_input: {} },
                { tool_name: `Read-${sentinel}`, tool_use_id: "tool-2", tool_input: {} },
              ],
            }),
        }),
      });

      const failure = await engine.run(taskInput(workspace, {
        redactor,
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      })).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        failure: {
          details: {
            sdkSubtype: "success",
            sdkErrors: "success_is_error",
            permissionDenials: "2",
            hostPolicyDenials: "outside_policy",
            deniedTools: "Read-[redacted:synthetic]",
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(sentinel);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("transports the exact structured-output policy through the real SDK wrapper", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-sdk-transport-"));
    const receiptPath = join(workspace, "argv.json");
    const fakeClaudePath = join(workspace, "fake-claude.cjs");
    const schema = {
      type: "object",
      properties: {
        verdict: { enum: ["APPROVE", "NEEDS_WORK"] },
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { severity: { const: "HIGH" } },
            required: ["severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict"],
      additionalProperties: false,
    } as const;
    try {
      await writeFile(
        fakeClaudePath,
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(23);\n`,
        { mode: 0o700 },
      );
      await chmod(fakeClaudePath, 0o700);
      const engine = new ClaudeAgentSdkTaskExecutionEngine({
        binaryPath: fakeClaudePath,
      });

      await expect(engine.run(taskInput(workspace, {
        model: "claude-opus-4-8",
        outputSchema: schema,
        workspaceInstructionPolicy: "deny_project_instructions_v1",
        allowedTools: ["Read", "Grep", "Glob"],
        editMode: AgentRuntimeEditMode.ReadOnly,
      }))).rejects.toBeDefined();

      const argv = JSON.parse(await readFile(receiptPath, "utf8")) as string[];
      expect(optionValue(argv, "--model")).toBe("claude-opus-4-8");
      expect(JSON.parse(optionValue(argv, "--json-schema"))).toEqual(schema);
      expect(optionValue(argv, "--tools")).toBe("Read,Grep,Glob,StructuredOutput");
      expect(optionValue(argv, "--allowedTools"))
        .toBe("Read,Grep,Glob,StructuredOutput");
      expect(argv).toContain("--safe-mode");
    } finally {
      await rm(workspace, { recursive: true, force: true });
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

function successResultTextQuery(result: string): Query {
  return sdkMessageQuery({ ...sdkSuccessMessage(), result });
}

function sdkMessageQuery(message: SDKResultMessage): Query {
  const stream = (async function* () {
    yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function successErrorAfterPolicyDenialQuery(
  options: Options,
  message: Extract<SDKResultMessage, { readonly subtype: "success" }>,
): Query {
  const stream = (async function* () {
    await options.hooks?.PreToolUse?.[0]?.hooks[0]?.({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "tool-denied",
      cwd: options.cwd ?? "/workspace",
      session_id: "session-1",
      transcript_path: "",
      permission_mode: options.permissionMode ?? "default",
    }, "tool-denied", { signal: new AbortController().signal });
    yield message;
  })();
  return Object.assign(stream, { close() {} }) as Query;
}

function optionValue(argv: readonly string[], option: string): string {
  const index = argv.indexOf(option);
  if (index < 0 || index + 1 >= argv.length) {
    throw new Error(`missing ${option} in SDK transport argv`);
  }
  return argv[index + 1]!;
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
