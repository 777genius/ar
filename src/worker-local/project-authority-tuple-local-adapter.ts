import { isAbsolute, resolve } from "node:path";
import {
  ProjectAuthorityCasStatus, ProjectAuthorityInitializeStatus,
  type ProjectAuthorityPreState, type ProjectAuthorityTuple,
  type ProjectAuthorityTupleStorePort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  acquireAuthorityLock, cleanupAuthorityTemps, closeAuthorityBoundary,
  openAuthorityBoundary, publishAuthorityFile, certifyLocalAuthorityFilesystem, readBoundedStable,
  releaseAuthorityLock, revalidateAuthorityLock, revalidateBoundary, type AuthorityBoundary,
  type AuthorityLock, type LocalAuthorityFilesystemVerifier, LocalProjectAuthorityCrashPoint,
} from "./project-authority-linux-file-primitives";

export { LocalProjectAuthorityCrashPoint } from "./project-authority-linux-file-primitives";

const MAX_BYTES = 8_192;
const STATE_NAME = "authority-tuple.json";
export type LocalProjectAuthorityTupleStoreOptions = {
  readonly rootDir: string; readonly projectId: string;
  readonly filesystemVerifier?: LocalAuthorityFilesystemVerifier;
  readonly crashHook?: (point: LocalProjectAuthorityCrashPoint) => Promise<void> | void;
};
type Document = { readonly schemaVersion: 1; readonly projectId: string;
  readonly tuple: ProjectAuthorityPreState | ProjectAuthorityTuple };

export class LocalProjectAuthorityTupleStore implements ProjectAuthorityTupleStorePort {
  constructor(private readonly options: LocalProjectAuthorityTupleStoreOptions) {
    if (!isAbsolute(options.rootDir) || resolve(options.rootDir) !== options.rootDir) {
      throw new Error("project_authority_root_invalid");
    }
    assertId(options.projectId, "project_id");
  }
  async initialize(expected: ProjectAuthorityPreState): Promise<ProjectAuthorityInitializeStatus> {
    assertPreState(expected);
    return this.exclusive(async (boundary, lock) => {
      const current = await readDocument(boundary, this.options.projectId);
      if (current) {
        if (sameTuple(current.tuple, expected)) return ProjectAuthorityInitializeStatus.Noop;
        throw new Error("project_authority_initialize_conflict");
      }
      const result = await publish(boundary, lock, this.options.projectId, expected, true,
        this.options.crashHook);
      if (result === "exists") {
        const raced = await readDocument(boundary, this.options.projectId);
        if (raced && sameTuple(raced.tuple, expected)) return ProjectAuthorityInitializeStatus.Noop;
        throw new Error("project_authority_initialize_conflict");
      }
      return ProjectAuthorityInitializeStatus.Initialized;
    });
  }
  async compareAndSet(input: { readonly expected: ProjectAuthorityPreState;
    readonly desired: ProjectAuthorityTuple }): Promise<ProjectAuthorityCasStatus> {
    assertPreState(input.expected); assertTuple(input.desired);
    for (const key of ["packetRevision", "baseSha", "inputPatchHash"] as const) {
      if (input.expected[key] !== input.desired[key]) throw new Error("project_authority_transition_invalid");
    }
    return this.exclusive(async (boundary, lock) => {
      const current = await readDocument(boundary, this.options.projectId);
      if (!current) throw new Error("project_authority_pre_state_missing");
      if (sameTuple(current.tuple, input.desired)) return ProjectAuthorityCasStatus.Noop;
      if (!sameTuple(current.tuple, input.expected)) throw new Error("project_authority_compare_and_set_conflict");
      await publish(boundary, lock, this.options.projectId, input.desired, false, this.options.crashHook);
      return ProjectAuthorityCasStatus.Applied;
    });
  }
  private async exclusive<T>(fn: (boundary: AuthorityBoundary, lock: AuthorityLock) => Promise<T>): Promise<T> {
    const boundary = await openAuthorityBoundary(this.options.rootDir, this.options.projectId);
    try {
      const lock = await acquireAuthorityLock(
        boundary,
        this.options.filesystemVerifier ?? certifyLocalAuthorityFilesystem,
      );
      try {
        await cleanupAuthorityTemps(boundary);
        await revalidateAuthorityLock(boundary, lock);
        const result = await fn(boundary, lock);
        await revalidateAuthorityLock(boundary, lock);
        await revalidateBoundary(boundary);
        return result;
      } finally { await releaseAuthorityLock(lock); }
    } finally { await closeAuthorityBoundary(boundary); }
  }
}

async function readDocument(boundary: AuthorityBoundary, projectId: string): Promise<Document | undefined> {
  const bytes = await readBoundedStable(boundary.project, STATE_NAME, MAX_BYTES);
  if (!bytes) return undefined;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("project_authority_state_corrupt"); }
  if (!record(value) || !keys(value, ["projectId", "schemaVersion", "tuple"]) ||
      value.schemaVersion !== 1 || value.projectId !== projectId || !record(value.tuple)) {
    throw new Error("project_authority_state_corrupt");
  }
  const tuple = value.tuple;
  if (tuple.phaseStartSha === null) {
    if (!keys(tuple, ["baseSha", "inputPatchHash", "packetRevision", "phaseStartSha"]))
      throw new Error("project_authority_state_corrupt");
    assertPreState(tuple as ProjectAuthorityPreState);
  } else {
    if (!keys(tuple, ["baseSha", "inputPatchHash", "packetRevision", "phaseStartSha", "reviewReceiptSha256"]))
      throw new Error("project_authority_state_corrupt");
    assertTuple(tuple as ProjectAuthorityTuple);
  }
  return { schemaVersion: 1, projectId, tuple: tuple as ProjectAuthorityPreState | ProjectAuthorityTuple };
}
async function publish(boundary: AuthorityBoundary, lock: AuthorityLock, projectId: string,
  tuple: ProjectAuthorityPreState | ProjectAuthorityTuple, noReplace: boolean,
  crash?: (point: LocalProjectAuthorityCrashPoint) => Promise<void> | void): Promise<"published" | "exists"> {
  const body = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId, tuple }) + "\n");
  if (body.byteLength > MAX_BYTES) throw new Error("project_authority_state_too_large");
  return publishAuthorityFile({ boundary, lock, name: STATE_NAME, body, noReplace,
    ...(crash ? { crash } : {}) });
}
function assertPreState(value: ProjectAuthorityPreState): void {
  assertId(value.packetRevision, "packet_revision"); assertSha(value.baseSha, 40, "base_sha");
  if (value.phaseStartSha !== null) throw new Error("project_authority_phase_start_sha_invalid");
  assertSha(value.inputPatchHash, 64, "input_patch_hash");
}
function assertTuple(value: ProjectAuthorityTuple): void {
  assertId(value.packetRevision, "packet_revision"); assertSha(value.baseSha, 40, "base_sha");
  assertSha(value.phaseStartSha, 40, "phase_start_sha"); assertSha(value.inputPatchHash, 64, "input_patch_hash");
  assertSha(value.reviewReceiptSha256, 64, "review_receipt_sha256");
}
function sameTuple(a: ProjectAuthorityPreState | ProjectAuthorityTuple,
  b: ProjectAuthorityPreState | ProjectAuthorityTuple): boolean {
  return a.packetRevision === b.packetRevision && a.baseSha === b.baseSha &&
    a.phaseStartSha === b.phaseStartSha && a.inputPatchHash === b.inputPatchHash &&
    ("reviewReceiptSha256" in a ? a.reviewReceiptSha256 : undefined) ===
    ("reviewReceiptSha256" in b ? b.reviewReceiptSha256 : undefined);
}
function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes(".."))
    throw new Error(`project_authority_${field}_invalid`);
}
function assertSha(value: unknown, length: 40 | 64, field: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value))
    throw new Error(`project_authority_${field}_invalid`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}
