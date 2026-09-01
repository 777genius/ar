import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectAuthorityCasStatus,
  adoptProjectAuthorityTuple,
  type AdoptProjectAuthorityTupleInput,
  type ProjectAuthorityTupleStorePort,
} from "../index";

describe("adoptProjectAuthorityTuple", () => {
  it("binds the exact receipt to the five-field tuple and null pre-state", async () => {
    const input = authorityInput();
    const compareAndSet = vi.fn<
      ProjectAuthorityTupleStorePort["compareAndSet"]
    >().mockResolvedValue(ProjectAuthorityCasStatus.Applied);

    await expect(adoptProjectAuthorityTuple({ compareAndSet }, input))
      .resolves.toBe(ProjectAuthorityCasStatus.Applied);

    expect(compareAndSet).toHaveBeenCalledExactlyOnceWith({
      expected: {
        packetRevision: input.packetRevision,
        baseSha: input.baseSha,
        phaseStartSha: null,
        inputPatchHash: input.inputPatchHash,
      },
      desired: {
        packetRevision: input.packetRevision,
        baseSha: input.baseSha,
        phaseStartSha: input.phaseStartSha,
        inputPatchHash: input.inputPatchHash,
        reviewReceiptSha256: input.reviewReceiptSha256,
      },
    });
  });

  it("fails before storage when the exact receipt hash does not match", async () => {
    const input = authorityInput();
    const compareAndSet = vi.fn<
      ProjectAuthorityTupleStorePort["compareAndSet"]
    >();

    await expect(adoptProjectAuthorityTuple({ compareAndSet }, {
      ...input,
      reviewReceiptSha256: "0".repeat(64),
    })).rejects.toThrow("project_authority_review_receipt_hash_mismatch");
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("fails before storage when receipt fields conflict with the tuple", async () => {
    const input = authorityInput();
    const reviewReceipt = JSON.stringify({
      schemaVersion: 1,
      packetRevision: input.packetRevision,
      baseSha: input.baseSha,
      phaseStartSha: "9".repeat(40),
      inputPatchHash: input.inputPatchHash,
    });
    const compareAndSet = vi.fn<
      ProjectAuthorityTupleStorePort["compareAndSet"]
    >();

    await expect(adoptProjectAuthorityTuple({ compareAndSet }, {
      ...input,
      reviewReceipt,
      reviewReceiptSha256: sha256(reviewReceipt),
    })).rejects.toThrow("project_authority_review_receipt_tuple_mismatch");
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("rejects unbounded or extended receipt schemas", async () => {
    const input = authorityInput();
    const extended = JSON.stringify({
      ...JSON.parse(input.reviewReceipt),
      providerCredential: "must-never-be-accepted",
    });
    const compareAndSet = vi.fn<
      ProjectAuthorityTupleStorePort["compareAndSet"]
    >();

    await expect(adoptProjectAuthorityTuple({ compareAndSet }, {
      ...input,
      reviewReceipt: extended,
      reviewReceiptSha256: sha256(extended),
    })).rejects.toThrow("project_authority_review_receipt_invalid");
    await expect(adoptProjectAuthorityTuple({ compareAndSet }, {
      ...input,
      reviewReceipt: "x".repeat(16_385),
      reviewReceiptSha256: sha256("x".repeat(16_385)),
    })).rejects.toThrow("project_authority_review_receipt_invalid");
    expect(compareAndSet).not.toHaveBeenCalled();
  });
});

function authorityInput(): AdoptProjectAuthorityTupleInput {
  const tuple = {
    packetRevision: "hosted-web-core-v1-r1",
    baseSha: "a".repeat(40),
    phaseStartSha: "b".repeat(40),
    inputPatchHash: "c".repeat(64),
  };
  const reviewReceipt = JSON.stringify({
    schemaVersion: 1,
    ...tuple,
  });
  return {
    ...tuple,
    reviewReceipt,
    reviewReceiptSha256: sha256(reviewReceipt),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
