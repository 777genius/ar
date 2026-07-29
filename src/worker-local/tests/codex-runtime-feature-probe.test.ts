import { describe, expect, it, vi } from "vitest";

import {
  CodexCliRuntimeFeatureProbe,
  CodexRuntimeFeature,
} from "../agent-runtime-task-runner/codex-runtime-feature-probe";

describe("Codex CLI runtime feature probing", () => {
  it("accepts a feature advertised by the first observation", async () => {
    const readFeatureList = vi.fn(async () => "goals stable true\n");
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).resolves.toBe(true);
    expect(readFeatureList).toHaveBeenCalledTimes(1);
  });

  it("recovers from one transient feature-absence observation", async () => {
    const readFeatureList = vi
      .fn()
      .mockResolvedValueOnce("rollout_budget stable true\n")
      .mockResolvedValueOnce("goals stable true\n");
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).resolves.toBe(true);
    expect(readFeatureList).toHaveBeenCalledTimes(2);
  });

  it("recovers from one empty feature-list observation", async () => {
    const readFeatureList = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("goals stable true\n");
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).resolves.toBe(true);
    expect(readFeatureList).toHaveBeenCalledTimes(2);
  });

  it("reports an absent feature only after two observations", async () => {
    const readFeatureList = vi.fn(async () => "rollout_budget stable true\n");
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).resolves.toBe(false);
    expect(readFeatureList).toHaveBeenCalledTimes(2);
  });

  it("does not disguise command failures as feature absence", async () => {
    const failure = new Error("codex is unavailable");
    const readFeatureList = vi.fn(async () => {
      throw failure;
    });
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).rejects.toBe(failure);
    expect(readFeatureList).toHaveBeenCalledTimes(1);
  });

  it("does not classify two empty observations as unsupported", async () => {
    const readFeatureList = vi.fn(async () => "");
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).rejects.toThrow(
      "Codex runtime returned an empty feature-list observation.",
    );
    expect(readFeatureList).toHaveBeenCalledTimes(2);
  });

  it("does not disguise a second-observation failure as feature absence", async () => {
    const failure = new Error("second probe failed");
    const readFeatureList = vi
      .fn()
      .mockResolvedValueOnce("rollout_budget stable true\n")
      .mockRejectedValueOnce(failure);
    const probe = new CodexCliRuntimeFeatureProbe({
      readFeatureList,
      waitBeforeAbsenceRetry: async () => {},
    });

    await expect(probe.supports(input())).rejects.toBe(failure);
    expect(readFeatureList).toHaveBeenCalledTimes(2);
  });
});

function input() {
  return {
    binaryPath: "codex",
    feature: CodexRuntimeFeature.Goals,
    env: {},
    signal: new AbortController().signal,
  };
}
