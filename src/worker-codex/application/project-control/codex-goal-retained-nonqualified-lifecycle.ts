import { join } from "node:path";
import {
  RETAINED_NONQUALIFIED_LIFECYCLE_ROLES,
  type RetainedNonqualifiedFileState,
  type RetainedNonqualifiedLifecycleRole,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "../../../worker-local/project-control-evidence-custody-local-adapter";
import { statOptionalHeldImmutableFile } from "../../../worker-local/project-control-evidence-custody-held-stat";
import { codexGoalJobManifestPath, type CodexGoalJobManifest } from "../../codex-goal-jobs";
import { codexGoalOutputPath, codexGoalProgressPath, codexGoalRuntimeEventsPath } from "../../codex-goal-runner";
import { buildTar } from "../../codex-goal-handoff-untracked-tar";
import { codexProjectAccountReservationPath } from "./codex-goal-project-account-reservation";

/** Ordinary lifecycle aggregate (the policy default); a caller passes the validated policy's limit. */
export const RETAINED_NONQUALIFIED_MAX_LIFECYCLE_BYTES = 64 * 1024 * 1024;

/** Exact USTAR cost of one regular member built by buildTar: a 512-byte header plus data padded to 512. */
export const ustarMemberBytes = (size: number) => 512 + Math.ceil(size / 512) * 512;
/** buildTar appends two zero blocks. */
export const USTAR_TRAILER_BYTES = 1024;

export type RetainedLifecyclePaths = Readonly<Record<RetainedNonqualifiedLifecycleRole, string>>;
export type RetainedLifecycleStates = Readonly<Record<RetainedNonqualifiedLifecycleRole, RetainedNonqualifiedFileState>>;

/** File names inside lifecycle.tar. The tar holds exactly the present originals, byte for byte. */
export const RETAINED_LIFECYCLE_ARCHIVE_NAMES: Readonly<Record<RetainedNonqualifiedLifecycleRole, string>> = {
  result: "result.json", progress: "progress.json", events: "events.jsonl", stopEvent: "stop-event.json",
  accountReservation: "account-reservation.json", manifest: "job.json", log: "job.log", prompt: "prompt.md",
};

/**
 * Every lifecycle path is derived from the job manifest by the same rules the
 * runtime uses (result, progress and event defaults, stop-event marker, account
 * reservation, log default), so producer and admission cannot disagree.
 */
export function retainedLifecyclePaths(manifest: CodexGoalJobManifest, registryRootDir: string): RetainedLifecyclePaths {
  const layout = { jobRootDir: manifest.jobRootDir, taskId: manifest.taskId };
  const output = manifest.outputPath === undefined ? {} : { outputPath: manifest.outputPath };
  return {
    result: codexGoalOutputPath({ ...layout, ...output }),
    progress: codexGoalProgressPath({ ...layout, ...(manifest.progressPath === undefined ? {} : { progressPath: manifest.progressPath }) }),
    events: codexGoalRuntimeEventsPath({ ...layout, ...output }),
    stopEvent: join(manifest.jobRootDir, `${manifest.taskId}.stop-event.json`),
    accountReservation: codexProjectAccountReservationPath(manifest),
    manifest: codexGoalJobManifestPath({ registryRootDir, jobId: manifest.jobId }),
    log: manifest.logPath ?? join(manifest.jobRootDir, `${manifest.taskId}.log`),
    prompt: manifest.promptPath,
  };
}

/**
 * Every retained read goes through the existing evidence custody: each ancestor is opened
 * component by component without following symlinks and held, the bytes and permission
 * bits come from the SAME held descriptor, the byte cap is enforced while reading, and
 * the lexical binding is revalidated after the read (a replaced parent or leaf refuses).
 * A missing leaf reads as absent only beneath such a certified parent chain; a missing,
 * dangling or aliased parent refuses. Unsupported (non-Linux) hosts fail closed.
 */
export async function readRegularFileWithMode(path: string, maxBytes: number): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  const file = await new LocalProjectControlEvidenceCustody().readImmutableFile(path, maxBytes);
  // The custody buffer is already an exact private copy; do not duplicate a possibly large body.
  return { bytes: Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes), mode: file.mode };
}

/** Present/absent state with hash, size and mode for every lifecycle role; bytes only when collecting. */
export async function captureRetainedLifecycle(
  paths: RetainedLifecyclePaths,
  options: { readonly collect: boolean; /** Aggregate cap from the validated policy. */ readonly maxBytes?: number } = { collect: false },
): Promise<{
  readonly states: RetainedLifecycleStates;
  readonly files: readonly { readonly role: RetainedNonqualifiedLifecycleRole; readonly bytes: Buffer; readonly mode: number }[];
  readonly totalBytes: number;
}> {
  const maxBytes = options.maxBytes ?? RETAINED_NONQUALIFIED_MAX_LIFECYCLE_BYTES;
  const custody = new LocalProjectControlEvidenceCustody();
  const states: Partial<Record<RetainedNonqualifiedLifecycleRole, RetainedNonqualifiedFileState>> = {};
  const files: { role: RetainedNonqualifiedLifecycleRole; bytes: Buffer; mode: number }[] = [];
  let totalBytes = 0;
  for (const role of RETAINED_NONQUALIFIED_LIFECYCLE_ROLES) {
    const path = paths[role];
    // The remaining allowance is the read cap, so the aggregate is enforced while reading, not afterwards.
    const file = await custody.readOptionalImmutableFile(path, Math.max(0, maxBytes - totalBytes));
    if (file === undefined) { states[role] = { state: "absent", path }; continue; }
    totalBytes += file.length;
    if (totalBytes > maxBytes) throw new Error("retained_nonqualified_lifecycle_too_large");
    states[role] = { state: "present", path, sha256: file.sha256, size: file.length, mode: file.mode };
    if (options.collect) files.push({ role, bytes: Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes), mode: file.mode });
  }
  return { states: states as RetainedLifecycleStates, files, totalBytes };
}

/**
 * Metadata-only measurement for the pre-allocation budget: held-descriptor sizes of the present
 * originals, the exact padded lifecycle.tar length, and the aggregate checked against the policy.
 */
export async function measureRetainedLifecycle(paths: RetainedLifecyclePaths, maxBytes: number): Promise<{
  readonly totalBytes: number;
  readonly tarBytes: number;
}> {
  let totalBytes = 0;
  let tarBytes = USTAR_TRAILER_BYTES;
  for (const role of RETAINED_NONQUALIFIED_LIFECYCLE_ROLES) {
    const measured = await statOptionalHeldImmutableFile(paths[role]);
    if (measured === undefined) continue;
    totalBytes += measured.length;
    if (totalBytes > maxBytes) throw new Error("retained_nonqualified_lifecycle_too_large");
    tarBytes += ustarMemberBytes(measured.length);
  }
  return { totalBytes, tarBytes };
}

export function retainedLifecycleTar(files: readonly { readonly role: RetainedNonqualifiedLifecycleRole; readonly bytes: Buffer; readonly mode: number }[]): Buffer {
  return buildTar(files.map(file => ({ path: RETAINED_LIFECYCLE_ARCHIVE_NAMES[file.role], bytes: file.bytes, mode: file.mode })));
}

/** An account reservation that is unexpired or malformed is a possible live holder: refuse (producer and admission). */
export function assertRetainedReservationInactive(bytes: Uint8Array | undefined, nowMs: number = Date.now()): void {
  if (bytes === undefined) return;
  let expiresAt: unknown;
  try { expiresAt = (JSON.parse(Buffer.from(bytes).toString("utf8")) as { expiresAt?: unknown }).expiresAt; }
  catch { throw new Error("retained_nonqualified_account_lease_active"); }
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) > nowMs) {
    throw new Error("retained_nonqualified_account_lease_active");
  }
}

export function lifecycleBytes(
  capture: { readonly files: readonly { readonly role: RetainedNonqualifiedLifecycleRole; readonly bytes: Buffer }[] },
  role: RetainedNonqualifiedLifecycleRole,
): Buffer | undefined {
  return capture.files.find(file => file.role === role)?.bytes;
}
