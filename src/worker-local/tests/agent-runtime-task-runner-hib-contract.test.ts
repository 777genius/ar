import { describe, expect, it } from "vitest";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeExecutionMode,
  AgentRuntimeTool,
} from "@vioxen/subscription-runtime/core";
import {
  createLocalAgentRuntimeTaskRunner,
  runSubscriptionAgentRuntimeTaskCli,
  AgentRuntimeTaskProvider,
  ClaudeAgentRuntimeBackend,
  type AgentRuntimeTaskWorkerFactoryInput,
  type AgentRuntimeTaskWorkerJob,
} from "../agent-runtime-task-runner";
import { resolveInlineOutputSchemas } from "../inline-output-schema";
import { prepareAgentRuntimeTask } from "../agent-runtime-task-runner/task-preparation";
import {
  fakeAgentRuntimeTaskCliIo,
} from "./agent-runtime-task-runner-cli-test-support";

describe("agent-runtime-task HIB contract", () => {
  it("reports exact capabilities without reading input or constructing a worker", async () => {
    const stdout: string[] = [];
    let readStdin = false;
    let factoryCalled = false;
    const io = fakeAgentRuntimeTaskCliIo({ stdin: "", stdout, env: {} });

    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      ["--capabilities-json"],
      {
        ...io,
        async readStdin() {
          readStdin = true;
          throw new Error("must not read stdin");
        },
      },
      () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    );

    expect(exitCode).toBe(0);
    expect(readStdin).toBe(false);
    expect(factoryCalled).toBe(false);
    expect(stdout.join("")).toBe(
      '{"schemaVersion":1,"protocolVersions":[2],"inlineOutputSchema":true,"reasoningEffort":true,"serviceTier":true,"boundedReadOnlyWorkspace":true,"instructionPathDeny":true}\n',
    );
  });

  it("rejects an unknown capability schema version without side effects", async () => {
    const stderr: string[] = [];
    let factoryCalled = false;
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      ["--capabilities-json", "2"],
      fakeAgentRuntimeTaskCliIo({ stdin: "", stderr, env: {} }),
      () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    );

    expect(exitCode).toBe(2);
    expect(factoryCalled).toBe(false);
    expect(stderr.join("")).toContain("version must be 1");
  });

  it.each([
    [["--provider", "codex", "--reasoning-effort", "medium"], "must be high"],
    [["--provider", "codex", "--service-tier", "fast"], "must be default"],
    [["--provider", "claude", "--reasoning-effort", "high"], "only for --provider codex"],
  ] as const)("rejects unsupported execution profiles", async (args, message) => {
    const stderr: string[] = [];
    let factoryCalled = false;
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [...args, "--ephemeral"],
      fakeAgentRuntimeTaskCliIo({ stdin: "{}", stderr, env: {} }),
      () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    );
    expect(exitCode).toBe(2);
    expect(factoryCalled).toBe(false);
    expect(stderr.join("")).toContain(message);
  });

  it("forwards the v2 Codex profile and inline schema into the worker", async () => {
    let factoryInput: AgentRuntimeTaskWorkerFactoryInput | undefined;
    let workerJob: AgentRuntimeTaskWorkerJob | undefined;
    const stdout: string[] = [];
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      [
        "--provider",
        "codex",
        "--ephemeral",
        "--format",
        "result-json",
        "--reasoning-effort",
        "high",
        "--service-tier",
        "default",
      ],
      fakeAgentRuntimeTaskCliIo({
        stdout,
        env: {},
        stdin: JSON.stringify({
          protocolVersion: 2,
          task: {
            kind: "review",
            prompt: "review this",
            execution: { mode: AgentRuntimeExecutionMode.SingleRun },
            controls: {
              accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
              workspaceInstructionPolicy: "deny_project_instructions_v1",
              toolPolicy: {
                allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
                onUnsupported: "fail",
              },
              responseFormat: "json",
              outputSchema: { type: "object", required: ["verdict"] },
            },
          },
        }),
      }),
      (input) => {
        factoryInput = input;
        return {
          async start() {},
          async run(job) {
            workerJob = job;
            return {
              outputText: "structured",
              structuredOutput: { verdict: "approve" },
              warnings: [],
            };
          },
        };
      },
    );

    expect(exitCode).toBe(0);
    expect(factoryInput).toMatchObject({
      provider: AgentRuntimeTaskProvider.Codex,
      reasoningEffort: "high",
      serviceTier: "default",
      codexExecutionPlan: {
        workspaceToolPolicy: {
          denyProjectInstructions: true,
        },
      },
    });
    expect(Object.keys(factoryInput?.outputSchemas ?? {})).toHaveLength(1);
    expect(workerJob?.outputSchemaName).toMatch(/^inline-[a-f0-9]{16}$/);
    expect(factoryInput?.outputSchemas?.[workerJob!.outputSchemaName!]).toEqual({
      type: "object",
      required: ["verdict"],
    });
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: 2,
      structuredOutput: { verdict: "approve" },
    });
  });

  it("rejects malformed inline schema before worker construction", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    });

    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "review",
        prompt: "review this",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        controls: { outputSchema: [] },
      },
    } as never);

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: "task_request_invalid" },
    });
    expect(factoryCalled).toBe(false);
    await runner.dispose();
  });

  it("uses one canonical digest for generated inline schema names", () => {
    const resolve = (outputSchema: Readonly<Record<string, unknown>>) =>
      resolveInlineOutputSchemas({ controls: { outputSchema } })!;
    const first = resolve({
      type: "object",
      properties: { verdict: { type: "string" }, score: { type: "number" } },
    });
    const reordered = resolve({
      properties: { score: { type: "number" }, verdict: { type: "string" } },
      type: "object",
    });
    const changed = resolve({
      type: "object",
      properties: { verdict: { type: "boolean" } },
    });

    expect(reordered).toMatchObject({ name: first.name, digest: first.digest });
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.name).not.toBe(first.name);
  });

  it.each([
    { task: { outputSchemaName: "" } },
    { task: { controls: { outputSchemaName: "" } } },
  ])("rejects an explicit empty output schema name before worker construction", async (invalid) => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Codex,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    });
    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "review",
        prompt: "review this",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        controls: { outputSchema: { type: "object" } },
        ...invalid.task,
      },
    } as never);

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: "task_request_invalid" },
    });
    expect(factoryCalled).toBe(false);
    await runner.dispose();
  });

  it("forwards the bounded HIB contract to the Claude Agent SDK adapter", async () => {
    let factoryInput: AgentRuntimeTaskWorkerFactoryInput | undefined;
    let workerJob: AgentRuntimeTaskWorkerJob | undefined;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      claudeBackend: ClaudeAgentRuntimeBackend.AgentSdk,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: (input) => {
        factoryInput = input;
        return {
          async start() {},
          async run(job) {
            workerJob = job;
            return {
              outputText: "structured",
              structuredOutput: { verdict: "approve" },
              warnings: [],
            };
          },
        };
      },
    });
    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "review",
        prompt: "review this",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        controls: {
          accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
          workspaceInstructionPolicy: "deny_project_instructions_v1",
          toolPolicy: {
            allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
            deny: [
              AgentRuntimeTool.Shell,
              AgentRuntimeTool.WebAccess,
              AgentRuntimeTool.EditFile,
              AgentRuntimeTool.WriteFile,
              AgentRuntimeTool.DelegateAgent,
              AgentRuntimeTool.WorktreeControl,
              AgentRuntimeTool.NotebookEdit,
            ],
            onUnsupported: "fail",
          },
          responseFormat: "json",
          outputSchema: {
            type: "object",
            required: ["verdict"],
            properties: { verdict: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
    });

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "completed",
      structuredOutput: { verdict: "approve" },
    });
    expect(factoryInput).toMatchObject({
      provider: AgentRuntimeTaskProvider.Claude,
      claudeBackend: ClaudeAgentRuntimeBackend.AgentSdk,
    });
    expect(Object.keys(factoryInput?.outputSchemas ?? {})).toHaveLength(1);
    expect(workerJob?.outputSchemaName).toMatch(/^inline-[a-f0-9]{16}$/);
    expect(factoryInput?.outputSchemas?.[workerJob!.outputSchemaName!]).toEqual({
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string" } },
      additionalProperties: false,
    });
    expect(workerJob?.controls).toMatchObject({
      editMode: "read-only",
      workspaceInstructionPolicy: "deny_project_instructions_v1",
      allowedTools: ["Read", "Grep", "Glob"],
      disallowedTools: expect.arrayContaining([
        "Bash",
        "WebFetch",
        "WebSearch",
        "Edit",
        "Write",
        "NotebookEdit",
      ]),
    });
    await runner.dispose();
  });

  it("fails closed when HIB instruction isolation is requested on Claude background", async () => {
    let factoryCalled = false;
    const runner = createLocalAgentRuntimeTaskRunner({
      provider: AgentRuntimeTaskProvider.Claude,
      claudeBackend: ClaudeAgentRuntimeBackend.Background,
      stateRootDir: "/tmp/runtime-state",
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      workspaceRoot: process.cwd(),
      env: {},
      workerFactory: () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    });
    const result = await runner.run({
      protocolVersion: 2,
      task: {
        kind: "review",
        prompt: "review this",
        execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        controls: {
          workspaceInstructionPolicy: "deny_project_instructions_v1",
          outputSchema: { type: "object" },
        },
      },
    });

    expect(result).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: "task_mode_unsupported" },
    });
    expect(factoryCalled).toBe(false);
    await runner.dispose();
  });

  it("rejects non-bounded Claude instruction-isolation tools during preparation", () => {
    expect(prepareAgentRuntimeTask(
      AgentRuntimeTaskProvider.Claude,
      {
        protocolVersion: 2,
        task: {
          kind: "review",
          prompt: "review this",
          execution: { mode: AgentRuntimeExecutionMode.SingleRun },
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
            workspaceInstructionPolicy: "deny_project_instructions_v1",
            toolPolicy: {
              allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.Shell],
              onUnsupported: "fail",
            },
          },
        },
      },
      ClaudeAgentRuntimeBackend.AgentSdk,
    )).toMatchObject({
      result: {
        status: "failed",
        failure: {
          code: "task_mode_unsupported",
          safeMessage: "workspace_instruction_policy_requires_bounded_read_only_tools",
        },
      },
    });
  });

  it("rejects a writable Claude instruction-isolation task during preparation", () => {
    expect(prepareAgentRuntimeTask(
      AgentRuntimeTaskProvider.Claude,
      {
        protocolVersion: 2,
        task: {
          kind: "review",
          prompt: "review this",
          execution: { mode: AgentRuntimeExecutionMode.SingleRun },
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
            workspaceInstructionPolicy: "deny_project_instructions_v1",
            toolPolicy: {
              allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
              onUnsupported: "fail",
            },
          },
        },
      },
      ClaudeAgentRuntimeBackend.AgentSdk,
    )).toMatchObject({
      result: {
        status: "failed",
        failure: {
          code: "task_mode_unsupported",
          safeMessage: "workspace_instruction_policy_requires_bounded_read_only_tools",
        },
      },
    });
  });

  it("emits a v2 task-mode failure when the CLI policy plan is not bounded", async () => {
    const stdout: string[] = [];
    let factoryCalled = false;
    const exitCode = await runSubscriptionAgentRuntimeTaskCli(
      ["--provider", "codex", "--ephemeral", "--format", "result-json"],
      fakeAgentRuntimeTaskCliIo({
        stdout,
        env: {},
        stdin: JSON.stringify({
          protocolVersion: 2,
          task: {
            kind: "review",
            prompt: "review this",
            execution: { mode: AgentRuntimeExecutionMode.SingleRun },
            controls: {
              workspaceInstructionPolicy: "deny_project_instructions_v1",
            },
          },
        }),
      }),
      () => {
        factoryCalled = true;
        throw new Error("must not construct");
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      protocolVersion: 2,
      status: "failed",
      failure: { code: "task_mode_unsupported" },
    });
    expect(factoryCalled).toBe(false);
  });

});
