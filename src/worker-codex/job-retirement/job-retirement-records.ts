import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { researchCustody, researchHash, researchJson, researchRead } from "../research-launch-files";
import { JobRetirementDocumentKind, JobRetirementRefusal, jobRetirementLayouts, jobRetirementRecordLocationMatches, jobRetirementRecordPaths,
  jobRetirementWorkstreamTombstonePath, refuseRetirement, validateJobRetirementDocument, type ClosedJobRecord, type RetiredJobRecord,
  type RetiredWorkstreamRecord } from "./job-retirement-contract";

/** Largest closed record, tombstone or receipt the runtime writes or reads. */
export const retirementRecordMaxBytes = 1024 * 1024;
const invalidRecord = (): never => { throw new Error("codex_goal_job_retirement_record_invalid"); };
// A link at a record path is still "present": the custody read below refuses it.
const present = (path: string): boolean => existsSync(path) || isLink(path);
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Root-private bytes in a root-private directory, or undefined when absent.
 * Presence is checked first, so callers without any record pay nothing. */
export function readRetirementRecordBytes(path: string): Buffer | undefined {
  if (!present(path)) return undefined;
  return researchRead(path, true, retirementRecordMaxBytes);
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Atomic and exclusive: the bytes are complete and synced under a private
 * temporary name before one `link` publishes them. A crash leaves either no
 * record or the whole record, and an existing record is never replaced. */
export function publishRetirementRecord(path: string, value: unknown): Buffer {
  const directory = dirname(path);
  researchCustody(directory, true);
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > retirementRecordMaxBytes) refuseRetirement(JobRetirementRefusal.RecordConflict);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); }
  finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    syncDirectory(directory);
  }
  return bytes;
}
/** A record its readers would reject is never written: Status must keep working. */
export function assertRetirementRecordValid(path: string, record: unknown): void {
  const verdict = validateJobRetirementDocument(record);
  if (!verdict.ok || !jobRetirementRecordLocationMatches(path, verdict.document) ||
      Buffer.byteLength(JSON.stringify(record)) + 1 > retirementRecordMaxBytes) refuseRetirement(JobRetirementRefusal.RecordInvalid);
}
/** Exactly-once publication for replays. An existing record must equal the
 * expected one in everything but its own timestamp, which stays the first one. */
export function publishOrVerifyRetirementRecord<T extends Record<string, unknown>>(path: string, expected: T, timestampKey: keyof T): Buffer {
  assertRetirementRecordValid(path, expected);
  const existing = readRetirementRecordBytes(path);
  if (existing) {
    const parsed = researchJson(existing) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !isDeepStrictEqual({ ...parsed, [timestampKey]: expected[timestampKey] }, expected))
      refuseRetirement(JobRetirementRefusal.RecordConflict);
    return existing;
  }
  return publishRetirementRecord(path, expected);
}

export enum JobRetirementState { Retired = "retired", Retiring = "retiring" }
export type ObservedJobRetirement =
  | Readonly<{ state: JobRetirementState.Retired; path: string; sha256: string; record: RetiredJobRecord }>
  | Readonly<{ state: JobRetirementState.Retiring; path: string; sha256: string; record: ClosedJobRecord }>;
function recordPaths(registryRootDir: string, jobId: string) {
  if (!new RegExp(jobRetirementLayouts.jobIdPattern).test(jobId)) throw new Error("codex_goal_job_id_invalid");
  return jobRetirementRecordPaths(resolve(registryRootDir), jobId);
}
const sameRegistry = (recorded: string, requested: string): boolean =>
  recorded === resolve(requested) || realpathSync(recorded) === realpathSync(requested);
/** Durable registry facts only. The workspace and run-state are never opened. */
export function observeJobRetirement(registryRootDir: string, jobId: string): ObservedJobRetirement | undefined {
  const paths = recordPaths(registryRootDir, jobId);
  for (const [path, state, kind] of [[paths.retired, JobRetirementState.Retired, JobRetirementDocumentKind.RetiredJob],
    [paths.closed, JobRetirementState.Retiring, JobRetirementDocumentKind.ClosedJob]] as const) {
    const bytes = readRetirementRecordBytes(path);
    if (!bytes) continue;
    const verdict = validateJobRetirementDocument(researchJson(bytes));
    if (!verdict.ok) return invalidRecord();
    const record = verdict.document;
    if (record.schema !== kind || record.jobId !== jobId || !sameRegistry(record.registryRootDir, registryRootDir)) return invalidRecord();
    return { state, path, sha256: researchHash(bytes), record } as ObservedJobRetirement;
  }
  return undefined;
}
/** Effect guard, owned by the job reader: a closed or retired job, or any job
 * of a MiMo workstream that is being retired, never runs or changes. */
export function assertCodexGoalJobNotRetired(registryRootDir: string, jobId: string): void {
  const paths = recordPaths(registryRootDir, jobId);
  if (present(paths.retired) || present(paths.closed)) throw new Error("codex_goal_job_retired");
  assertCodexGoalRegistryNotRetiring(registryRootDir);
}
/** A MiMo workstream guard sits next to its registry and stays after the
 * workstream tombstone; no job is created, read for effects or run there. */
export function assertCodexGoalRegistryNotRetiring(registryRootDir: string): void {
  const stateRoot = dirname(resolve(registryRootDir));
  if (!present(jobRetirementWorkstreamGuardPath(stateRoot))) return;
  throw new Error(present(jobRetirementWorkstreamTombstonePath(stateRoot)) ? "codex_goal_job_retired" : "codex_goal_job_retirement_pending");
}
/** The Status and Stop answer for a retired or retiring job. */
export function jobRetirementAnswer(observed: ObservedJobRetirement): Readonly<Record<string, unknown>> {
  const record = observed.record;
  return { state: observed.state, retirement: observed.state === JobRetirementState.Retired
    ? { recordPath: observed.path, recordSha256: observed.sha256, retiredAt: observed.record.retiredAt, terminal: record.terminal,
        output: observed.record.output, deletion: observed.record.deletion.scope, planSha256: record.planSha256 }
    : { recordPath: observed.path, recordSha256: observed.sha256, closedAt: observed.record.closedAt, terminal: record.terminal,
        planSha256: record.planSha256 } };
}
/** Durable MiMo guard written before the first record and kept afterwards: no
 * bridge activity or source advance runs on a workstream being retired. */
export const jobRetirementWorkstreamGuardPath = (stateRoot: string): string => join(stateRoot, ".job-retirement.json");
/** Only a cancelled retirement removes its guard, durably. */
export function withdrawRetirementGuard(stateRoot: string): void {
  unlinkSync(jobRetirementWorkstreamGuardPath(stateRoot));
  syncDirectory(stateRoot);
}
export function assertNoWorkstreamRetirement(stateRoot: string, error: string): void {
  if (present(jobRetirementWorkstreamGuardPath(stateRoot))) throw new Error(error);
}
export type ObservedRetiredWorkstream = Readonly<{ path: string; sha256: string; record: RetiredWorkstreamRecord }>;
export function observeRetiredWorkstream(stateRoot: string): ObservedRetiredWorkstream | undefined {
  const path = jobRetirementWorkstreamTombstonePath(stateRoot), bytes = readRetirementRecordBytes(path);
  if (!bytes) return undefined;
  const verdict = validateJobRetirementDocument(researchJson(bytes));
  if (!verdict.ok || verdict.document.schema !== JobRetirementDocumentKind.RetiredWorkstream ||
      verdict.document.registryRootDir !== join(stateRoot, "registry")) return invalidRecord();
  return { path, sha256: researchHash(bytes), record: verdict.document };
}
/** Bridge answer for a job of a retired MiMo workstream. Status and Stop of a
 * listed job answer from the tombstones; every other request is refused. */
export function retiredWorkstreamBridgeAnswer(stateRoot: string, jobId: string, statusOrStop: boolean): Readonly<Record<string, unknown>> | undefined {
  const workstream = observeRetiredWorkstream(stateRoot);
  if (!workstream) return undefined;
  const listed = workstream.record.jobs.find(row => row.jobId === jobId);
  if (!listed || !statusOrStop) throw new Error("mimo_project_bridge_workstream_retired");
  const observed = observeJobRetirement(join(stateRoot, "registry"), jobId);
  if (observed?.state !== JobRetirementState.Retired || observed.sha256 !== listed.tombstoneSha256) return invalidRecord();
  return { ok: true, jobId, ...jobRetirementAnswer(observed), workstream: { recordPath: workstream.path, recordSha256: workstream.sha256 } };
}
