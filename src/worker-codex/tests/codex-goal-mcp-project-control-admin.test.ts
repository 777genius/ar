import { describe, expect, it } from "vitest";
import { resolveProjectControlRepairWorkspaceMode } from "../codex-goal-mcp-project-control-admin";

describe("project-control manifest repair workspace mode", () => {
  it("prefers an exact reviewed snapshot over stale admitted-patch quota classification", () => {
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: true,
        reviewedOutputId: "a".repeat(64),
        admittedInputPatchCapacityContinuation: true,
      }),
    ).toBe("reviewed_dirty_continuation");
  });

  it("preserves admitted-input and clean continuation modes without a reviewed snapshot", () => {
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: true,
        admittedInputPatchCapacityContinuation: true,
      }),
    ).toBe("admitted_input_patch_continuation");
    expect(
      resolveProjectControlRepairWorkspaceMode({
        workspaceDirty: false,
        admittedInputPatchCapacityContinuation: false,
      }),
    ).toBe("clean_capacity_continuation");
  });
});
