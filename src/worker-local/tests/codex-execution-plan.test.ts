import { describe, expect, it } from "vitest";
import {
  AgentRuntimeAccessBoundary,
  AgentRuntimeBudgetEnforcement,
  AgentRuntimeBudgetMetric,
  AgentRuntimeExecutionMode,
  AgentRuntimeTool,
  type ProviderTask,
} from "@vioxen/subscription-runtime/core";
import {
  codexCapabilitiesForExecutionPlan,
  compileCodexExecutionPlan,
} from "../agent-runtime-task-runner/codex-execution-plan";

describe("Codex execution-plan compilation", () => {
  it("derives a bounded plan from existing accessBoundary and toolPolicy controls", () => {
    const plan = compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      toolPolicy: {
        allow: [
          AgentRuntimeTool.ReadFile,
          AgentRuntimeTool.EditFile,
          AgentRuntimeTool.Shell,
        ],
        deny: [AgentRuntimeTool.Shell],
      },
    }));

    expect(plan).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      workspaceToolPolicy: {
        allowedTools: [AgentRuntimeTool.EditFile, AgentRuntimeTool.ReadFile],
      },
    });
    expect(codexCapabilitiesForExecutionPlan(plan)).toMatchObject({
      toolPolicyMode: "host-filtered",
      accessBoundaryMode: "host-scoped",
      supportsToolCalling: true,
      requiresWritableWorkspace: true,
    });
  });

  it("supports an explicit read-only file surface without inventing a profile enum", () => {
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
      toolPolicy: {
        allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
      },
    }))).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      workspaceToolPolicy: {
        allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
      },
    });
  });

  it("opts into instruction isolation only with the bounded read-only contract", () => {
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
      workspaceInstructionPolicy: "deny_project_instructions_v1",
      toolPolicy: {
        allow: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
      },
    }))).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      workspaceToolPolicy: {
        allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
        denyProjectInstructions: true,
      },
    });

    expect(() => compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.ReadOnly,
      workspaceInstructionPolicy: "deny_project_instructions_v1",
    }))).toThrow("workspace_instruction_policy_requires_bounded_read_only_tools");
  });

  it("refuses implicit writes, native tools, provider tools, and broad boundaries", () => {
    expect(compileCodexExecutionPlan(task({
      toolPolicy: { allow: [AgentRuntimeTool.WriteFile] },
    }))).toBeUndefined();
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      toolPolicy: { allow: [AgentRuntimeTool.Shell] },
    }))).toBeUndefined();
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      toolPolicy: {
        allow: [AgentRuntimeTool.ReadFile],
        allowProviderTools: ["provider_native_tool"],
      },
    }))).toBeUndefined();
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.IsolatedWorkspaceWrite,
      toolPolicy: {
        allow: [AgentRuntimeTool.ReadFile],
        denyProviderTools: ["provider_native_tool"],
      },
    }))).toBeUndefined();
    expect(compileCodexExecutionPlan(task({
      accessBoundary: AgentRuntimeAccessBoundary.DangerFullAccess,
      toolPolicy: { allow: [AgentRuntimeTool.ReadFile] },
    }))).toBeUndefined();
  });

  it("derives provider-native weighted-token budget capabilities", () => {
    const plan = compileCodexExecutionPlan(task({
      budget: {
        metric: AgentRuntimeBudgetMetric.WeightedTokens,
        limit: 75_000,
      },
    }));

    expect(plan).toEqual({
      execution: { mode: AgentRuntimeExecutionMode.SingleRun },
      rolloutBudget: { weightedTokenLimit: 75_000 },
    });
    expect(codexCapabilitiesForExecutionPlan(plan)).toMatchObject({
      budgetCapabilities: [
        {
          metric: AgentRuntimeBudgetMetric.WeightedTokens,
          enforcement: AgentRuntimeBudgetEnforcement.ProviderNative,
        },
      ],
    });
  });
});

function task(controls: NonNullable<ProviderTask["controls"]>): ProviderTask {
  return {
    kind: "structured-prompt",
    prompt: "test",
    controls,
  };
}
