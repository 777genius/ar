import { expect, it } from "vitest";
import { hostedMimoProjectOperationErrorCode } from "../hosted-mimo-project-operation-error";

it.each(["mimo_project_runtime_routing_invalid", "mimo_project_runtime_routing_invalid: TEST private detail"])(
  "preserves only the fixed routing refusal code from %s", message => {
    const error = new Error(message);
    expect(hostedMimoProjectOperationErrorCode(error)).toBe("mimo_project_runtime_routing_invalid");
    expect(JSON.stringify({ ok: false, error: hostedMimoProjectOperationErrorCode(error) })).not.toContain("TEST private detail");
  });

it.each(["mimo_project_bridge_scope_denied", "project_control_submission_outcome_unknown", "hosted_research_invalid",
  "codex_goal_invalid", "owned_mimo_invalid"])("preserves the existing public code %s", code => {
  expect(hostedMimoProjectOperationErrorCode(new Error(code + ": TEST private detail"))).toBe(code);
});

it.each([new Error("mimo_project_runtime_arbitrary"), new Error("mimo_project_runtime_routing_invalid_suffix"),
  new Error("mimo_project_runtime_routing_invalid\nTEST private detail"), new Error("TEST private detail"),
  "mimo_project_runtime_routing_invalid", { message: "mimo_project_runtime_routing_invalid" }, undefined])(
  "refuses unapproved or non-Error diagnostic input %#", error => {
    expect(hostedMimoProjectOperationErrorCode(error)).toBe("mimo_project_bridge_operation_failed");
  });
