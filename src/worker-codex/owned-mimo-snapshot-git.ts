import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import type { SafeExecutionCommandRunner, WorkspaceSnapshotter, SafeExecutionWorkspaceAccess } from "@vioxen/subscription-runtime/worker-core";
import { classifyManagedDependencyGitArgs, ManagedDependencyGitOperation,
  managedDependencyGitEnvironment, managedDependencyGitFlags } from "./managed-dependency-git";

import { NodeSafeExecutionWorkspaceAccess } from "../worker-local/safe-execution/adapters/node-safe-execution-workspace-access";
import { DefaultWorkspaceSnapshotter } from "../worker-local/safe-execution/adapters/default-workspace-snapshotter";

const execute = promisify(execFile);
export const ownedMimoSnapshotGitBudgetMs = 30_000;
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
  #failure: Error | undefined;
  constructor(workspace: string, assertCurrent: () => void) {
    if (!isAbsolute(workspace) || resolve(workspace) !== workspace) throw new Error("owned_mimo_snapshot_git_invalid");
    this.#workspace = workspace; this.#assertCurrent = assertCurrent;
  }
  #invalid(): never { this.#failure = new Error("owned_mimo_snapshot_git_invalid"); throw this.#failure; }
  assertHealthy(): void {
    try { this.#assertCurrent(); if (this.#failure) throw this.#failure; }
    catch (error) { this.#failure = error instanceof Error ? error : new Error("owned_mimo_snapshot_git_invalid"); throw this.#failure; }
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
      return { stdout: String(result.stdout), stderr: "" };
    } catch (error) { this.#failure = new MimoSnapshotGitFailure(facts(error, performance.now() - started)); throw this.#failure; }
    finally { this.assertHealthy(); }
  }
}

/** The ordinary snapshotter deliberately tolerates some Git failures. Owned
 * execution must not convert a failed read into a successful initial snapshot. */
export function ownedMimoWorkspaceSnapshotter(runner: OwnedMimoSnapshotGitRunner): WorkspaceSnapshotter {
  const delegate = new DefaultWorkspaceSnapshotter({ commandRunner: runner, gitBinaryPath: "/usr/bin/git", commandTimeoutMs: ownedMimoSnapshotGitBudgetMs });
  return { async capture(input) {
    runner.assertHealthy();
    const snapshot = await delegate.capture(input);
    runner.assertHealthy();
    return snapshot;
  } };
}

/** Preserve the original access implementation, including cancellation facts
 * that its ordinary compatibility path otherwise maps to a not-Git error. */
export function ownedMimoWorkspaceAccess(runner: OwnedMimoSnapshotGitRunner): SafeExecutionWorkspaceAccess {
  const delegate = new NodeSafeExecutionWorkspaceAccess({ commandRunner: runner, gitBinaryPath: "/usr/bin/git", commandTimeoutMs: ownedMimoSnapshotGitBudgetMs });
  return { canonicalizePath: input => delegate.canonicalizePath(input), async assertGitWorkspace(input) {
    runner.assertHealthy();
    try { await delegate.assertGitWorkspace(input); }
    finally { runner.assertHealthy(); }
  } };
}
