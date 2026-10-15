import { execFile } from "node:child_process";
import { promisify, types } from "node:util";
import { isAbsolute, resolve } from "node:path";
import type { SafeExecutionCommandRunner, WorkspaceSnapshotter, SafeExecutionWorkspaceAccess } from "@vioxen/subscription-runtime/worker-core";
import { classifyManagedDependencyGitArgs, ManagedDependencyGitOperation,
  managedDependencyGitEnvironment, managedDependencyGitFlags } from "./managed-dependency-git";

import { NodeSafeExecutionWorkspaceAccess } from "../worker-local/safe-execution/adapters/node-safe-execution-workspace-access";
import { DefaultWorkspaceSnapshotter } from "../worker-local/safe-execution/adapters/default-workspace-snapshotter";
import type { ResearchAdmissionTiming } from "./research-launch-admission-diagnostics";

const execute = promisify(execFile);
export const ownedMimoSnapshotGitBudgetMs = 30_000;
export enum MimoSnapshotTimingScope { InitialAccess = "initial_access", InitialSnapshot = "initial_snapshot" }
export enum MimoSnapshotTimingOutcome { Completed = "completed", Failed = "failed" }
export type MimoSnapshotTiming = Readonly<{
  scope: MimoSnapshotTimingScope; outcome: MimoSnapshotTimingOutcome; elapsedMs: number;
  admissionCount: number; admissionElapsedMs: number; successfulGitCount: number; successfulGitElapsedMs: number;
}> & Partial<ResearchAdmissionTiming>;
type TimingCounters = { admissionCount: number; admissionElapsedMs: number; successfulGitCount: number;
  successfulGitElapsedMs: number; invalid: boolean; partCount: number; serviceCount: number; parts: ResearchAdmissionTiming };
const admissionPartKeys = ["admissionAuthorityElapsedMs", "admissionArtifactElapsedMs", "admissionExecutableElapsedMs"] as const;
enum TimingCounterKind { Admission = "admission", SuccessfulGit = "successful_git" }
const timingNow = (): number | undefined => {
  try { const value = performance.now(); return Number.isFinite(value) ? value : undefined; } catch { return undefined; }
};
const elapsedTiming = (started: number | undefined): number | undefined => {
  const now = timingNow(), value = now === undefined || started === undefined ? undefined : now - started;
  return value !== undefined && value >= 0 && value <= 86_400_000 ? value : undefined;
};
export enum MimoSnapshotGitStderrCategory {
  Absent = "absent", Permission = "permission", ReadOnly = "read_only", Ownership = "ownership",
  IndexLock = "index_lock", NotRepository = "not_repository", Other = "other",
}
export enum MimoSnapshotGitSignal { None = "none", Term = "SIGTERM", Kill = "SIGKILL", Interrupt = "SIGINT", Other = "other" }
export type MimoSnapshotGitFailureFacts = Readonly<{
  exitCode: number | null; signal: MimoSnapshotGitSignal; killed: boolean; aborted: boolean;
  timedOut: boolean; elapsedMs: number; budgetMs: number; stderrCategory: MimoSnapshotGitStderrCategory;
}>;
function ownValue(error: unknown, key: string): unknown {
  return error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined;
}
function facts(error: unknown, elapsedMs: number): MimoSnapshotGitFailureFacts {
  const code = ownValue(error, "code"), rawSignal = ownValue(error, "signal"), killed = ownValue(error, "killed") === true;
  const signal = rawSignal === "SIGTERM" ? MimoSnapshotGitSignal.Term : rawSignal === "SIGKILL" ? MimoSnapshotGitSignal.Kill
    : rawSignal === "SIGINT" ? MimoSnapshotGitSignal.Interrupt : rawSignal == null ? MimoSnapshotGitSignal.None : MimoSnapshotGitSignal.Other;
  const raw = ownValue(error, "stderr");
  const stderr = typeof raw === "string" && Buffer.byteLength(raw) <= 65536 ? raw.toLowerCase() : undefined;
  const category = raw === "" || raw == null ? MimoSnapshotGitStderrCategory.Absent
    : stderr?.includes("permission denied") ? MimoSnapshotGitStderrCategory.Permission
    : stderr?.includes("read-only file system") ? MimoSnapshotGitStderrCategory.ReadOnly
    : stderr?.includes("dubious ownership") ? MimoSnapshotGitStderrCategory.Ownership
    : stderr?.includes("index.lock") ? MimoSnapshotGitStderrCategory.IndexLock
    : stderr?.includes("not a git repository") ? MimoSnapshotGitStderrCategory.NotRepository : MimoSnapshotGitStderrCategory.Other;
  const elapsed = Math.max(0, Math.min(86400000, Math.floor(elapsedMs)));
  return Object.freeze({ exitCode: typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
    signal, killed, aborted: code === "ABORT_ERR", timedOut: code === null && killed && signal === MimoSnapshotGitSignal.Term && elapsed >= ownedMimoSnapshotGitBudgetMs,
    elapsedMs: elapsed, budgetMs: ownedMimoSnapshotGitBudgetMs, stderrCategory: category });
}
export enum MimoSnapshotGitFailureCode { Failed = "owned_mimo_snapshot_git_failed", Aborted = "ABORT_ERR" }
export class MimoSnapshotGitFailure extends Error {
  readonly code: MimoSnapshotGitFailureCode;
  constructor(readonly facts: MimoSnapshotGitFailureFacts) {
    const { aborted, ...messageFacts } = facts;
    const outcome = aborted ? "abort" : facts.timedOut ? "timeout" : "failed";
    super("owned_mimo_snapshot_git_failed:" + outcome + ":" + JSON.stringify(messageFacts));
    this.name = facts.aborted ? "AbortError" : "MimoSnapshotGitFailure";
    this.code = facts.aborted ? MimoSnapshotGitFailureCode.Aborted : MimoSnapshotGitFailureCode.Failed;
  }
}
/** Native owner-side read IO only. Pure Git hygiene does not issue a managed
 * dependency purpose. Composition supplies the genuine MiMo admission guard. */
export class OwnedMimoSnapshotGitRunner implements SafeExecutionCommandRunner {
  readonly #workspace: string;
  readonly #assertCurrent: () => void;
  readonly #observe: ((timing: MimoSnapshotTiming) => void) | undefined;
  readonly #observed = new Set<MimoSnapshotTimingScope>();
  #timing: TimingCounters | undefined;
  #failure: Error | undefined;
  constructor(workspace: string, assertCurrent: () => void, observe?: (timing: MimoSnapshotTiming) => void) {
    if (!isAbsolute(workspace) || resolve(workspace) !== workspace) throw new Error("owned_mimo_snapshot_git_invalid");
    this.#workspace = workspace; this.#assertCurrent = assertCurrent;
    this.#observe = observe;
  }
  /** At most two initial observations. Overlapping reads have no truthful
   * aggregate and suppress observation; they do not change execution. */
  async observeInitial<T>(scope: MimoSnapshotTimingScope, operation: () => Promise<T>): Promise<T> {
    if (!this.#observe) return operation();
    if (this.#timing) {
      this.#timing.invalid = true;
      this.#observed.add(MimoSnapshotTimingScope.InitialAccess);
      this.#observed.add(MimoSnapshotTimingScope.InitialSnapshot);
      return operation();
    }
    if (this.#observed.has(scope)) return operation();
    this.#observed.add(scope);
    const counters: TimingCounters = { admissionCount: 0, admissionElapsedMs: 0,
      successfulGitCount: 0, successfulGitElapsedMs: 0, invalid: false, partCount: 0, serviceCount: 0,
      parts: { admissionAuthorityElapsedMs: 0, admissionArtifactElapsedMs: 0, admissionExecutableElapsedMs: 0,
        admissionAuthorityServiceElapsedMs: 0 } };
    this.#timing = counters;
    const started = timingNow(); let outcome = MimoSnapshotTimingOutcome.Failed;
    try { const result = await operation(); outcome = MimoSnapshotTimingOutcome.Completed; return result; }
    finally {
      this.#timing = undefined;
      const elapsedMs = elapsedTiming(started);
      if (!counters.invalid && elapsedMs !== undefined) {
        const { admissionAuthorityServiceElapsedMs, ...outerParts } = counters.parts;
        try { this.#observe(Object.freeze({ scope, outcome, elapsedMs,
          admissionCount: counters.admissionCount, admissionElapsedMs: counters.admissionElapsedMs,
          successfulGitCount: counters.successfulGitCount, successfulGitElapsedMs: counters.successfulGitElapsedMs,
          ...(counters.partCount === counters.admissionCount && counters.partCount > 0 &&
            Object.values(outerParts).reduce((sum, value) => sum + value, 0) <= counters.admissionElapsedMs
            ? { ...outerParts, ...(counters.serviceCount === counters.partCount ? { admissionAuthorityServiceElapsedMs } : {}) } : {}) })); }
        catch { /* Optional observations never replace the original result or error. */ }
      }
    }
  }
  #record(kind: TimingCounterKind, started: number | undefined): void {
    const counters = this.#timing;
    if (!counters) return;
    const elapsed = elapsedTiming(started), count = kind === TimingCounterKind.Admission ? ++counters.admissionCount : ++counters.successfulGitCount;
    if (elapsed === undefined || count > 1000) { counters.invalid = true; return; }
    if (kind === TimingCounterKind.Admission) counters.admissionElapsedMs += elapsed;
    else counters.successfulGitElapsedMs += elapsed;
    if (counters.admissionElapsedMs > 86_400_000 || counters.successfulGitElapsedMs > 86_400_000) counters.invalid = true;
  }
  #invalid(): never { this.#failure = new Error("owned_mimo_snapshot_git_invalid"); throw this.#failure; }
  #recordParts(value: unknown): void {
    const counters = this.#timing;
    if (!counters || !value || typeof value !== "object" || types.isProxy(value)) return;
    try {
      const values = admissionPartKeys.map(key => Object.getOwnPropertyDescriptor(value, key)?.value as unknown);
      if (!values.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86_400_000)) return;
      if (admissionPartKeys.some((key, i) => counters.parts[key] + values[i]! > 86_400_000)) return;
      counters.parts = { ...counters.parts, ...Object.fromEntries(admissionPartKeys.map((key, i) => [key, counters.parts[key] + values[i]!])) } as ResearchAdmissionTiming;
      counters.partCount++;
      const service = Object.getOwnPropertyDescriptor(value, "admissionAuthorityServiceElapsedMs")?.value as unknown;
      const sum = (counters.parts.admissionAuthorityServiceElapsedMs ?? 0) + (typeof service === "number" ? service : NaN);
      if (typeof service === "number" && Number.isFinite(service) && service >= 0 && service <= values[0]! && sum <= 86_400_000) {
        counters.parts = { ...counters.parts, admissionAuthorityServiceElapsedMs: sum }; counters.serviceCount++;
      }
    } catch { /* Optional data never invokes getters or replaces a guard outcome. */ }
  }
  assertHealthy(): void {
    const started = this.#timing ? timingNow() : undefined;
    try { const parts: unknown = this.#assertCurrent(); this.#recordParts(parts); if (this.#failure) throw this.#failure; }
    catch (error) { this.#failure = error instanceof Error ? error : new Error("owned_mimo_snapshot_git_invalid"); throw this.#failure; }
    finally { this.#record(TimingCounterKind.Admission, started); }
  }
  async run(input: Parameters<SafeExecutionCommandRunner["run"]>[0]) {
    const command = input.command, cwd = input.cwd, args = [...input.args], signal = input.abortSignal;
    const maximum = input.maxBufferBytes ?? 1024 * 1024;
    if (command !== "/usr/bin/git" || cwd !== this.#workspace || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32 * 1024 * 1024)
      this.#invalid();
    try { if (classifyManagedDependencyGitArgs(args) === ManagedDependencyGitOperation.PrivateIndex) throw new Error(); }
    catch { this.#invalid(); }
    this.assertHealthy();
    const started = performance.now();
    try {
      const readArgs = args[0] === "diff" ? ["diff", "--no-textconv", ...args.slice(1)] : args;
      const result = await execute("/usr/bin/git", ["--no-optional-locks", ...managedDependencyGitFlags, ...readArgs], {
        cwd, env: { ...managedDependencyGitEnvironment(), GIT_NO_LAZY_FETCH: "1" }, timeout: ownedMimoSnapshotGitBudgetMs,
        maxBuffer: maximum, ...(signal === undefined ? {} : { signal }),
      });
      this.#record(TimingCounterKind.SuccessfulGit, started);
      return { stdout: String(result.stdout), stderr: "" };
    } catch (error) { this.#failure = new MimoSnapshotGitFailure(facts(error, performance.now() - started)); throw this.#failure; }
    finally { this.assertHealthy(); }
  }
}

/** The ordinary snapshotter deliberately tolerates some Git failures. Owned
 * execution must not convert a failed read into a successful initial snapshot. */
export function ownedMimoWorkspaceSnapshotter(runner: OwnedMimoSnapshotGitRunner): WorkspaceSnapshotter {
  const delegate = new DefaultWorkspaceSnapshotter({ commandRunner: runner, gitBinaryPath: "/usr/bin/git", commandTimeoutMs: ownedMimoSnapshotGitBudgetMs });
  return { capture: input => runner.observeInitial(MimoSnapshotTimingScope.InitialSnapshot, async () => {
    runner.assertHealthy();
    const snapshot = await delegate.capture(input);
    runner.assertHealthy();
    return snapshot;
  }) };
}

/** Preserve the original access implementation, including cancellation facts
 * that its ordinary compatibility path otherwise maps to a not-Git error. */
export function ownedMimoWorkspaceAccess(runner: OwnedMimoSnapshotGitRunner): SafeExecutionWorkspaceAccess {
  const delegate = new NodeSafeExecutionWorkspaceAccess({ commandRunner: runner, gitBinaryPath: "/usr/bin/git", commandTimeoutMs: ownedMimoSnapshotGitBudgetMs });
  return { canonicalizePath: input => delegate.canonicalizePath(input), assertGitWorkspace: input =>
    runner.observeInitial(MimoSnapshotTimingScope.InitialAccess, async () => {
    runner.assertHealthy();
    try { await delegate.assertGitWorkspace(input); }
    finally { runner.assertHealthy(); }
  }) };
}
