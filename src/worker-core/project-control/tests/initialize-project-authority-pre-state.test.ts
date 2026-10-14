import { describe, expect, it, vi } from "vitest";
import {
  ProjectAuthorityInitializeStatus,
  initializeProjectAuthorityPreState,
  type ProjectAuthorityPreState,
  type ProjectAuthorityTupleStorePort,
} from "../index";

const expected: ProjectAuthorityPreState = {
  packetRevision: "hosted-web-core-v1-r1",
  baseSha: "a".repeat(40), phaseStartSha: null,
  inputPatchHash: "b".repeat(64),
};

describe("initializeProjectAuthorityPreState", () => {
  it("passes the exact durable null-phase pre-state", async () => {
    const initialize = vi.fn<ProjectAuthorityTupleStorePort["initialize"]>()
      .mockResolvedValue(ProjectAuthorityInitializeStatus.Initialized);
    await expect(initializeProjectAuthorityPreState({ initialize }, expected))
      .resolves.toBe(ProjectAuthorityInitializeStatus.Initialized);
    expect(initialize).toHaveBeenCalledExactlyOnceWith(expected);
  });
  it("rejects reset and missing fields before storage", async () => {
    const initialize = vi.fn<ProjectAuthorityTupleStorePort["initialize"]>();
    await expect(initializeProjectAuthorityPreState({ initialize }, {
      ...expected, phaseStartSha: "c".repeat(40) as never,
    })).rejects.toThrow("project_authority_initialize_reset_denied");
    await expect(initializeProjectAuthorityPreState({ initialize }, {
      ...expected, inputPatchHash: undefined as never,
    })).rejects.toThrow("project_authority_initialize_sha_invalid");
    expect(initialize).not.toHaveBeenCalled();
  });
});
