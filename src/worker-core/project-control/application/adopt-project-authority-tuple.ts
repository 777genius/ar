import { createHash } from "node:crypto";
import type {
  ProjectAuthorityPreState,
  ProjectAuthorityTuple,
  ProjectAuthorityTupleStorePort,
} from "../ports/project-authority-tuple-store-port";

const MAX_REVIEW_RECEIPT_BYTES = 16_384;

export type AdoptProjectAuthorityTupleInput = ProjectAuthorityTuple & {
  readonly reviewReceipt: string;
};

export async function adoptProjectAuthorityTuple(
  store: Pick<ProjectAuthorityTupleStorePort, "compareAndSet">,
  input: AdoptProjectAuthorityTupleInput,
): ReturnType<ProjectAuthorityTupleStorePort["compareAndSet"]> {
  assertSimpleId(input.packetRevision, "packet_revision");
  assertSha(input.baseSha, 40, "base_sha");
  assertSha(input.phaseStartSha, 40, "phase_start_sha");
  assertSha(input.inputPatchHash, 64, "input_patch_hash");
  assertSha(input.reviewReceiptSha256, 64, "review_receipt_sha256");
  const receiptBytes = Buffer.byteLength(input.reviewReceipt, "utf8");
  if (receiptBytes === 0 || receiptBytes > MAX_REVIEW_RECEIPT_BYTES) {
    throw new Error("project_authority_review_receipt_invalid");
  }
  const digest = createHash("sha256").update(input.reviewReceipt, "utf8").digest("hex");
  if (digest !== input.reviewReceiptSha256) {
    throw new Error("project_authority_review_receipt_hash_mismatch");
  }
  const receipt = parseReceipt(input.reviewReceipt);
  for (const key of ["packetRevision", "baseSha", "phaseStartSha", "inputPatchHash"] as const) {
    if (receipt[key] !== input[key]) {
      throw new Error("project_authority_review_receipt_tuple_mismatch");
    }
  }
  const expected: ProjectAuthorityPreState = {
    packetRevision: input.packetRevision,
    baseSha: input.baseSha,
    phaseStartSha: null,
    inputPatchHash: input.inputPatchHash,
  };
  return store.compareAndSet({
    expected,
    desired: {
      packetRevision: input.packetRevision,
      baseSha: input.baseSha,
      phaseStartSha: input.phaseStartSha,
      inputPatchHash: input.inputPatchHash,
      reviewReceiptSha256: input.reviewReceiptSha256,
    },
  });
}

function parseReceipt(value: string): ProjectAuthorityTuple {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("project_authority_review_receipt_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("project_authority_review_receipt_invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "baseSha,inputPatchHash,packetRevision,phaseStartSha,schemaVersion" ||
    record.schemaVersion !== 1
  ) {
    throw new Error("project_authority_review_receipt_invalid");
  }
  const tuple = record as unknown as ProjectAuthorityTuple;
  assertSimpleId(tuple.packetRevision, "review_receipt_packet_revision");
  assertSha(tuple.baseSha, 40, "review_receipt_base_sha");
  assertSha(tuple.phaseStartSha, 40, "review_receipt_phase_start_sha");
  assertSha(tuple.inputPatchHash, 64, "review_receipt_input_patch_hash");
  return tuple;
}

function assertSimpleId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value.includes("..")
  ) throw new Error(`project_authority_${field}_invalid`);
}

function assertSha(value: unknown, length: 40 | 64, field: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new Error(`project_authority_${field}_invalid`);
  }
}
