import { describe, expect, it } from "vitest";
import { executionProfileCompatibility } from
  "../agent-runtime-task-runner/execution-profile-compatibility";

describe("execution profile compatibility", () => {
  it("preserves the pre-profile compatibility input when fields are absent", () => {
    expect(executionProfileCompatibility({})).toEqual({});
  });
});
