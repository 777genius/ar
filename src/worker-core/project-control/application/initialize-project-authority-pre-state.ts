import type {
  ProjectAuthorityPreState,
  ProjectAuthorityTupleStorePort,
} from "../ports/project-authority-tuple-store-port";

export async function initializeProjectAuthorityPreState(
  store: Pick<ProjectAuthorityTupleStorePort, "initialize">,
  expected: ProjectAuthorityPreState,
): ReturnType<ProjectAuthorityTupleStorePort["initialize"]> {
  assertId(expected.packetRevision);
  assertSha(expected.baseSha, 40);
  assertSha(expected.inputPatchHash, 64);
  if (expected.phaseStartSha !== null) {
    throw new Error("project_authority_initialize_reset_denied");
  }
  return store.initialize(expected);
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw new Error("project_authority_initialize_packet_revision_invalid");
  }
}

function assertSha(value: unknown, length: 40 | 64): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new Error("project_authority_initialize_sha_invalid");
  }
}
