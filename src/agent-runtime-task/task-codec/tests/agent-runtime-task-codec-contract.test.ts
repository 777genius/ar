import { describe, expect, it } from "vitest";
import {
  AgentRuntimeEditMode,
  AgentRuntimeProviderSandboxMode,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTool,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  agentRuntimeTaskRequestToProviderTask,
  agentRuntimeTaskResultToProviderTaskResult,
  parseAgentRuntimeTaskRequest,
  parseAgentRuntimeTaskResult,
  providerTaskResultToAgentRuntimeTaskResult,
  createAgentRuntimeTaskRequestV2,
  createAgentRuntimeTaskRequestV3,
} from "../../codec";
import { compareAgentRuntimeTaskRoundMembers } from "../../rounds";
import {
  AgentRuntimeFailureLifecycleState,
  AgentRuntimeThreadOutcome,
  agentRuntimeTaskProtocolVersion,
  agentRuntimeTaskProtocolVersionV3,
} from "../../types";

describe("agent-runtime-task codec contract", () => {
  it("exports high-level host controls from the public agent-runtime-task entrypoint", () => {
    expect(AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite).toBe(
      "isolated_workspace_write",
    );
    expect(AgentRuntimeTool.WorktreeControl).toBe("worktree_control");
  });

  it("maps strict provider-neutral task budgets without legacy cost controls", () => {
    const request = parseAgentRuntimeTaskRequest({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Work within the execution budget.",
        controls: {
          budget: {
            metric: AgentRuntimeBudgetMetric.WeightedTokens,
            limit: 100_000,
            onUnsupported: "fail",
          },
        },
      },
    });

    expect(agentRuntimeTaskRequestToProviderTask(request).controls?.budget)
      .toEqual({
        metric: AgentRuntimeBudgetMetric.WeightedTokens,
        limit: 100_000,
        onUnsupported: "fail",
      });
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Reject legacy cost control.",
          controls: {
            costLimit: { amount: 1, currency: "USD" },
          },
        },
      }),
    ).toThrow(/controls.costLimit is unsupported/);
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Reject fractional weighted tokens.",
          controls: {
            budget: {
              metric: AgentRuntimeBudgetMetric.WeightedTokens,
              limit: 1.5,
            },
          },
        },
      }),
    ).toThrow(/budget.limit must be a positive integer/);
  });

  it("keeps request contracts JSON-safe while mapping only provider controls downstream", () => {
    const request = parseAgentRuntimeTaskRequest({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Return a JSON object.",
        controls: {
          responseFormat: "json",
          outputSchemaName: "answer",
          outputSchema: {
            type: "object",
            properties: {
              answer: { type: "string", description: undefined },
            },
            required: ["answer"],
          },
        },
      },
    });

    expect(request.task.controls?.outputSchema).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    });
    expect(agentRuntimeTaskRequestToProviderTask(request)).toEqual({
      kind: "structured-prompt",
      prompt: "Return a JSON object.",
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      controls: {
        responseFormat: "json",
        outputSchemaName: "answer",
      },
    });
  });

  it("maps high-level access boundaries to provider controls", () => {
    const request = parseAgentRuntimeTaskRequest({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Patch the sandbox workspace.",
        controls: {
          accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        },
      },
    });

    expect(agentRuntimeTaskRequestToProviderTask(request)).toEqual({
      kind: "structured-prompt",
      prompt: "Patch the sandbox workspace.",
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      controls: {
        accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
        editMode: AgentRuntimeEditMode.AllowEdits,
        providerSandboxMode: AgentRuntimeProviderSandboxMode.WorkspaceWrite,
      },
    });
  });

  it("rejects low-level provider controls at the public boundary", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Patch the sandbox workspace.",
          controls: {
            editMode: AgentRuntimeEditMode.AllowEdits,
          },
        },
      }),
    ).toThrow(/controls.editMode is unsupported/);
  });

  it("rejects project-scoped control through raw agent runtime task execution", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Coordinate project work.",
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.ProjectScopedControl,
          },
        },
      }),
    ).toThrow(/accessBoundary is unsupported/);
  });

  it("requires explicit acknowledgement before danger full access", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Run with full access.",
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.DangerFullAccess,
          },
        },
      }),
    ).toThrow(/allowDangerFullAccess=true/);
  });

  it("rejects unknown safety-control keys instead of dropping them", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Patch the workspace.",
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
            maxBudgetUsd: 1,
          },
        },
      }),
    ).toThrow(/controls.maxBudgetUsd is unsupported/);

    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Patch the workspace.",
          controls: {
            toolPolicy: {
              allow: [AgentRuntimeTool.ReadFile],
              unsupportedBehavior: "warn",
            },
          },
        },
      }),
    ).toThrow(/toolPolicy.unsupportedBehavior is unsupported/);
  });

  it("preserves an explicit empty tool allow-list", () => {
    const request = parseAgentRuntimeTaskRequest({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Answer without tools.",
        controls: {
          toolPolicy: { allow: [] },
        },
      },
    });

    expect(agentRuntimeTaskRequestToProviderTask(request).controls?.toolPolicy)
      .toEqual({ allow: [] });
  });

  it("rejects mutating tools inside a read-only boundary", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        task: {
          kind: "structured-prompt",
          prompt: "Inspect the workspace.",
          controls: {
            accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
            toolPolicy: { allow: [AgentRuntimeTool.WriteFile] },
          },
        },
      }),
    ).toThrow(/incompatible with read_only: write_file/);
  });

  it("keeps explicit web access separate from the read-only workspace boundary", () => {
    const request = parseAgentRuntimeTaskRequest({
      protocolVersion: agentRuntimeTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Research without changing the workspace.",
        controls: {
          accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
          toolPolicy: { allow: [AgentRuntimeTool.WebAccess] },
        },
      },
    });

    expect(agentRuntimeTaskRequestToProviderTask(request).controls)
      .toMatchObject({
        editMode: "read-only",
        toolPolicy: { allow: [AgentRuntimeTool.WebAccess] },
      });
  });

  it("round-trips waiting-for-input results through the provider result contract", () => {
    const agentResult = providerTaskResultToAgentRuntimeTaskResult({
      status: "waiting_for_input",
      runId: "run-1",
      outputText: "Need a decision.",
      request: {
        id: "input-1",
        kind: "decision_required",
        question: "Continue?",
        audience: "orchestrator",
        suggestedAnswers: ["yes", "no"],
      },
      resumeHandle: {
        runId: "run-1",
        providerId: "provider-1",
        workspacePath: "/workspace",
      },
      warnings: [],
    });

    expect(parseAgentRuntimeTaskResult(agentResult)).toEqual(agentResult);
    expect(agentRuntimeTaskResultToProviderTaskResult(agentResult)).toEqual({
      status: "waiting_for_input",
      runId: "run-1",
      outputText: "Need a decision.",
      request: {
        id: "input-1",
        kind: "decision_required",
        question: "Continue?",
        audience: "orchestrator",
        suggestedAnswers: ["yes", "no"],
      },
      resumeHandle: {
        runId: "run-1",
        providerId: "provider-1",
        workspacePath: "/workspace",
      },
      warnings: [],
    });
  });

  it("rejects legacy or malformed codec inputs with protocol errors", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: agentRuntimeTaskProtocolVersionV3 + 1,
        task: {
          kind: "review",
          prompt: "Review this.",
        },
      }),
    ).toThrow("request.protocolVersion must be 1, 2, or 3");

    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: 2,
        task: {
          kind: "review",
          prompt: "Review this.",
        },
      }),
    ).toThrow("request.task.execution must be an object");

    expect(() =>
      parseAgentRuntimeTaskResult({
        protocolVersion: agentRuntimeTaskProtocolVersion,
        status: "completed",
        outputText: "bad",
        structuredOutput: Number.NaN,
        warnings: [],
      }),
    ).toThrow("result.structuredOutput must be a finite JSON number");
  });

  it("round-trips an explicit v2 Goal without provider metadata activation", () => {
    const request = createAgentRuntimeTaskRequestV2({
      timeoutMs: 60_000,
      task: {
        kind: "structured-prompt",
        prompt: "Fix the deterministic fixture.",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "The fixture requirement is fully implemented.",
        },
      },
    });

    expect(parseAgentRuntimeTaskRequest(request)).toEqual(request);
    expect(agentRuntimeTaskRequestToProviderTask(request)).toMatchObject({
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "The fixture requirement is fully implemented.",
      },
    });
    expect(agentRuntimeTaskRequestToProviderTask(request).metadata).toBeUndefined();
  });

  it("round-trips a v3 logical-thread Goal without changing the v2 shape", () => {
    const request = createAgentRuntimeTaskRequestV3({
      executionId: "execution-1",
      thread: { id: "thread-1" },
      timeoutMs: 60_000,
      task: {
        kind: "structured-prompt",
        prompt: "Continue the deterministic fixture.",
        execution: {
          mode: AgentRuntimeExecutionMode.Goal,
          completionCondition: "The fixture is complete.",
        },
      },
    });

    expect(parseAgentRuntimeTaskRequest(request)).toEqual(request);
    expect(agentRuntimeTaskRequestToProviderTask(request)).toMatchObject({
      execution: {
        mode: AgentRuntimeExecutionMode.Goal,
        completionCondition: "The fixture is complete.",
      },
    });
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: 2,
        executionId: "execution-1",
        thread: { id: "thread-1" },
        task: {
          kind: "structured-prompt",
          prompt: "Do not expand v2.",
          execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        },
      }),
    ).toThrow("request.executionId is unsupported");
  });

  it("requires Goal, stable identities and terminal thread evidence in v3", () => {
    expect(() =>
      createAgentRuntimeTaskRequestV3({
        executionId: "execution-1",
        thread: { id: "thread-1" },
        task: {
          kind: "structured-prompt",
          prompt: "Single run is not continuable.",
          execution: { mode: AgentRuntimeExecutionMode.SingleRun },
        },
      }),
    ).toThrow("request.task.execution.mode must be goal");
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: 3,
        executionId: "",
        thread: { id: "thread-1" },
        task: {
          kind: "structured-prompt",
          prompt: "Invalid identity.",
          execution: {
            mode: AgentRuntimeExecutionMode.Goal,
            completionCondition: "done",
          },
        },
      }),
    ).toThrow("request.executionId must be a non-empty string");
    expect(() =>
      providerTaskResultToAgentRuntimeTaskResult({
        status: "completed",
        outputText: "missing thread evidence",
        warnings: [],
      }, { protocolVersion: 3 }),
    ).toThrow("result.thread is required");

    const completed = providerTaskResultToAgentRuntimeTaskResult({
      status: "completed",
      outputText: "done",
      warnings: [],
    }, {
      protocolVersion: 3,
      thread: {
        id: "thread-1",
        outcome: AgentRuntimeThreadOutcome.Continued,
      },
    });
    expect(parseAgentRuntimeTaskResult(completed)).toEqual(completed);
  });

  it("fails v3 waiting-for-input results closed with an explicit lifecycle", () => {
    const result = providerTaskResultToAgentRuntimeTaskResult({
      status: "waiting_for_input",
      runId: "run-1",
      outputText: "Need input.",
      request: {
        id: "input-1",
        kind: "decision_required",
        question: "Continue?",
        audience: "orchestrator",
      },
      resumeHandle: {
        runId: "run-1",
        providerId: "codex",
        workspacePath: "/workspace",
      },
      telemetry: {
        durationMs: 42,
        providerSessionId: "provider-session-must-not-leak",
      },
      warnings: [
        {
          code: "control-warning",
          safeMessage: "Control warning.",
        },
        {
          code: "worker-warning",
          safeMessage: "Worker warning.",
        },
      ],
    }, {
      protocolVersion: 3,
      failureLifecycle: {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
        taskStarted: true,
      },
    });

    expect(result).toMatchObject({
      protocolVersion: 3,
      status: "failed",
      failure: { code: "provider_output_invalid" },
      lifecycle: {
        state: AgentRuntimeFailureLifecycleState.ExecutionFailed,
        taskStarted: true,
      },
      telemetry: { durationMs: 42 },
      warnings: [
        { code: "control-warning" },
        { code: "worker-warning" },
      ],
    });
    expect(result.telemetry).not.toHaveProperty("providerSessionId");
    expect(() =>
      parseAgentRuntimeTaskResult({
        protocolVersion: 3,
        status: "waiting_for_input",
        runId: "run-1",
        outputText: "",
        request: {
          id: "input-1",
          kind: "decision_required",
          question: "Continue?",
          audience: "orchestrator",
        },
        resumeHandle: {
          runId: "run-1",
          providerId: "codex",
          workspacePath: "/workspace",
        },
        warnings: [],
      }),
    ).toThrow("waiting_for_input is unsupported for protocolVersion 3");
  });

  it("rejects v2 execution on the frozen v1 request shape", () => {
    expect(() =>
      parseAgentRuntimeTaskRequest({
        protocolVersion: 1,
        task: {
          kind: "structured-prompt",
          prompt: "Do not infer Goal from this payload.",
          execution: { mode: AgentRuntimeExecutionMode.Goal },
        },
      }),
    ).toThrow("request.task.execution is unsupported");
  });

  it("keeps round-member comparison available through compatibility imports", () => {
    expect(
      compareAgentRuntimeTaskRoundMembers(
        {
          id: "critic",
          adapterId: "codex",
          agentType: "critic",
          provider: "openai",
          model: "gpt-5",
          independenceGroup: "openai:gpt-5",
        },
        {
          id: "advocate",
          adapterId: "claude",
          agentType: "advocate",
          provider: "anthropic",
          model: "sonnet",
          independenceGroup: "anthropic:sonnet",
        },
      ),
    ).toEqual({ ok: true });
  });
});
