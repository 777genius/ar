import { describe, expect, it } from "vitest";
import {
  assertProjectInputPatchContract,
  assertProjectRefillInputPatchSource,
} from "../application/project-control/codex-goal-project-input-patch-policy";

describe("project refill input patch policy", () => {
  it("allows a null input patch only for a clean first builtin implementation", () => {
    const cleanInitialImplementation = {
      inputPatchHash: null,
      reviewKind: "implementation",
      revision: 0,
      retryCount: 0,
      supersedes: null,
    };
    expect(() => assertProjectInputPatchContract({
      builtin: true,
      contract: cleanInitialImplementation,
    })).not.toThrow();

    for (const contract of [
      { ...cleanInitialImplementation, reviewKind: "review" },
      { ...cleanInitialImplementation, reviewKind: "remediation" },
      { ...cleanInitialImplementation, revision: 1 },
      { ...cleanInitialImplementation, retryCount: 1 },
      { ...cleanInitialImplementation, supersedes: "f".repeat(64) },
    ]) {
      expect(() => assertProjectInputPatchContract({ builtin: true, contract }))
        .toThrow("project_control_pre_start_input_patch_hash_required");
    }

    expect(() => assertProjectInputPatchContract({
      builtin: false,
      contract: cleanInitialImplementation,
    })).toThrow("project_control_pre_start_input_patch_hash_required");
  });

  it("requires immutable producer evidence for a non-null input patch", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: "a".repeat(64) },
      producerJobId: undefined,
      workerRole: "producer",
    })).toThrow("project_control_refill_input_patch_source_required");
  });

  it("accepts an explicitly hash-bound empty patch for a clean refill", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: {
        inputPatchHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      producerJobId: undefined,
      reviewedOutputId: undefined,
      workerRole: "producer",
    })).not.toThrow();
  });

  it("requires every refill to bind an input patch hash", () => {
    for (const contract of [undefined, {}, { inputPatchHash: null }]) {
      expect(() => assertProjectRefillInputPatchSource({
        contract,
        producerJobId: undefined,
        reviewedOutputId: undefined,
        workerRole: "producer",
      })).toThrow("project_control_refill_input_patch_hash_required");
    }
  });

  it("allows producer and adoption refill to consume immutable input patch evidence", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: "a".repeat(64) },
      producerJobId: "project-rejected-producer",
      workerRole: "producer",
    })).not.toThrow();
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: "a".repeat(64) },
      producerJobId: "project-rejected-producer",
      workerRole: "adoption",
    })).not.toThrow();
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: "a".repeat(64) },
      producerJobId: "project-rejected-producer",
      workerRole: "reviewer",
    })).toThrow("project_control_refill_input_patch_producer_role_required");
  });

  it("allows only a remediation producer to consume an attested rejected output", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: {
        inputPatchHash: "a".repeat(64),
        reviewKind: "remediation",
      },
      producerJobId: "project-rejected-producer",
      reviewedOutputId: "b".repeat(64),
      workerRole: "producer",
    })).not.toThrow();
    expect(() => assertProjectRefillInputPatchSource({
      contract: {
        inputPatchHash: "a".repeat(64),
        reviewKind: "remediation",
      },
      producerJobId: "project-rejected-producer",
      reviewedOutputId: "b".repeat(64),
      workerRole: "adoption",
    })).toThrow(
      "project_control_refill_reviewed_output_producer_role_required",
    );
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: "a".repeat(64), reviewKind: "implementation" },
      producerJobId: "project-rejected-producer",
      reviewedOutputId: "b".repeat(64),
      workerRole: "producer",
    })).toThrow("project_control_refill_reviewed_output_remediation_required");
  });

  it("requires the rejected output to name its source worker", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: {
        inputPatchHash: "a".repeat(64),
        reviewKind: "remediation",
      },
      producerJobId: undefined,
      reviewedOutputId: "b".repeat(64),
      workerRole: "producer",
    })).toThrow("project_control_refill_input_patch_source_required");
  });

  it("rejects an input patch source when the contract declares clean input", () => {
    expect(() => assertProjectRefillInputPatchSource({
      contract: { inputPatchHash: null },
      producerJobId: "project-rejected-producer",
      reviewedOutputId: "b".repeat(64),
      workerRole: "producer",
    })).toThrow("project_control_refill_input_patch_hash_required");
  });
});
