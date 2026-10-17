/** Finite SOURCE predicates over copied facts, never original custody.
 * No entry point, spawn, signal, membership factory or success brand exists here.
 * P1–P5 remain Held: the original FULL constructor must retain/requery kernel
 * facts, serialize its one effect and prove native completion independently.
 */
import type { HostedFdUnitLifecycle } from "../../src/provider-codex/app-server/adapters/hosted-fd-unit-lifecycle.js";

export enum ManagerDrainCase { Preparation = "preparation", Ready = "ready" }
export enum ManagerDrainPhase { Pending = "pending", Captured = "captured", Ready = "ready", Effect = "effect", TerminalFacts = "terminal-facts", Held = "held" }
export enum ManagerDrainEvent { Capture = "capture", Ready = "ready", MainSignal = "main-signal", Terminal = "terminal", Fail = "fail" }
export enum ManagerDrainActorRole { Tini = "tini", Workload = "workload", TermResistant = "term-resistant", Stopped = "stopped" }
export enum ManagerDrainDeathFact { Dead = "dead", Live = "live", Unknown = "unknown" }
export enum ManagerDrainUnitState { Inactive = "inactive", Failed = "failed", Active = "active", Deactivating = "deactivating", Restarting = "restarting", Unknown = "unknown" }
export enum ManagerDrainCompletionFact { Observed = "observed", Unknown = "unknown" }
export enum ManagerDrainStreamFact { Eof = "eof", Open = "open", Unknown = "unknown" }
export enum ManagerDrainProcessState { Running = "R", Sleeping = "S", Uninterruptible = "D", Idle = "I", Stopped = "T", Traced = "t", Zombie = "Z", Unknown = "?" }
export enum ManagerDrainSignal { Kill = "SIGKILL", Term = "SIGTERM", Unknown = "unknown" }
export enum ManagerDrainMainCode { Unknown = 0, Exited = 1, Killed = 2 }
export enum ManagerDrainUnitResult { Signal = "signal", Success = "success", Timeout = "timeout", Unknown = "unknown" }
export enum ManagerDrainHeldReason { Case = "TEST_manager_drain_case", Phase = "TEST_manager_drain_phase", Budget = "TEST_manager_drain_budget", Identity = "TEST_manager_drain_identity", Birth = "TEST_manager_drain_birth", Census = "TEST_manager_drain_census", Terminal = "TEST_manager_drain_terminal" }
function check(value: unknown, reason: ManagerDrainHeldReason): asserts value { if (!value) throw new Error(reason); }

const lifecycleKeys = ["Type", "ExitType", "RemainAfterExit", "KillMode", "SendSIGKILL", "Restart", "Delegate", "ProtectControlGroups", "TimeoutStopUSec", "KillSignal", "FinalKillSignal"] as const;
const actorRoles = [ManagerDrainActorRole.Tini, ManagerDrainActorRole.Workload, ManagerDrainActorRole.TermResistant, ManagerDrainActorRole.Stopped] as const;
const caseMs = 40_000, nsPerMs = 1_000_000n;
function closed(value: object, keys: readonly string[], reason: ManagerDrainHeldReason): void {
  check(value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")), reason);
}
function natural(value: string, positive = false): boolean { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n && (!positive || value !== "0"); }
function birth(value: string): number {
  const fields = typeof value === "string" ? value.split(":") : [];
  check(fields.length === 2 && natural(fields[0]!, true) && natural(fields[1]!, true) && Number.isSafeInteger(Number(fields[0])), ManagerDrainHeldReason.Birth);
  return Number(fields[0]);
}
function digest(value: string): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function sameKeys(a: object, b: object, keys: readonly string[]): boolean { return keys.every(key => Reflect.get(a, key) === Reflect.get(b, key)); }
function canonicalGroup(path: string): boolean { return typeof path === "string" && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) && path.split("/").every(p => p !== "." && p !== "..") && path.split("/").length <= 9; }
function validCase(value: ManagerDrainCase): void { check(value === ManagerDrainCase.Preparation || value === ManagerDrainCase.Ready, ManagerDrainHeldReason.Case); }

/** This phase value is copied observation DATA, not an effect permission. */
export function nextManagerDrainPhase(probeCase: ManagerDrainCase, phase: ManagerDrainPhase, event: ManagerDrainEvent): ManagerDrainPhase {
  validCase(probeCase);
  check(Object.values(ManagerDrainPhase).includes(phase) && Object.values(ManagerDrainEvent).includes(event) &&
    phase !== ManagerDrainPhase.Held && phase !== ManagerDrainPhase.TerminalFacts, ManagerDrainHeldReason.Phase);
  if (event === ManagerDrainEvent.Fail) return ManagerDrainPhase.Held;
  if (phase === ManagerDrainPhase.Pending && event === ManagerDrainEvent.Capture) return ManagerDrainPhase.Captured;
  if (probeCase === ManagerDrainCase.Ready && phase === ManagerDrainPhase.Captured && event === ManagerDrainEvent.Ready) return ManagerDrainPhase.Ready;
  if (event === ManagerDrainEvent.MainSignal && phase === (probeCase === ManagerDrainCase.Preparation ? ManagerDrainPhase.Captured : ManagerDrainPhase.Ready)) return ManagerDrainPhase.Effect;
  if (phase === ManagerDrainPhase.Effect && event === ManagerDrainEvent.Terminal) return ManagerDrainPhase.TerminalFacts;
  throw new Error(ManagerDrainHeldReason.Phase);
}

export type ManagerDrainBudgetFacts = Readonly<{ armedNs: bigint; deadlineNs: bigint; lastObservedNs: bigint }>;
/** Only the original constructor can supply a genuine minimum remaining port.
 * The numerical helper neither refreshes that port nor validates its origin. */
export function armManagerDrainBudget(nowNs: bigint, originalRemainingMs: number): ManagerDrainBudgetFacts {
  check(typeof nowNs === "bigint" && nowNs >= 0n && Number.isSafeInteger(originalRemainingMs) && originalRemainingMs >= caseMs, ManagerDrainHeldReason.Budget);
  return Object.freeze({ armedNs: nowNs, deadlineNs: nowNs + BigInt(caseMs) * nsPerMs, lastObservedNs: nowNs });
}
export function observeManagerDrainBudget(previous: ManagerDrainBudgetFacts, nowNs: bigint, originalRemainingMs: number): Readonly<{ budget: ManagerDrainBudgetFacts; remainingMs: number; queryTimeoutMs: number; pollingSleepMs: number }> {
  closed(previous, ["armedNs", "deadlineNs", "lastObservedNs"], ManagerDrainHeldReason.Budget);
  check(typeof previous.armedNs === "bigint" && typeof previous.deadlineNs === "bigint" && typeof previous.lastObservedNs === "bigint" &&
    previous.armedNs >= 0n && previous.deadlineNs === previous.armedNs + BigInt(caseMs) * nsPerMs && previous.lastObservedNs >= previous.armedNs &&
    typeof nowNs === "bigint" && nowNs >= previous.lastObservedNs && Number.isSafeInteger(originalRemainingMs) && originalRemainingMs > 0, ManagerDrainHeldReason.Budget);
  const localMs = (previous.deadlineNs - nowNs) / nsPerMs;
  check(nowNs < previous.deadlineNs && localMs > 0n, ManagerDrainHeldReason.Budget);
  const remainingMs = Math.min(Number(localMs), originalRemainingMs);
  return Object.freeze({ budget: Object.freeze({ ...previous, lastObservedNs: nowNs }), remainingMs,
    queryTimeoutMs: Math.min(2000, remainingMs), pollingSleepMs: Math.min(10, remainingMs) });
}

export type ManagerDrainInodeFacts = Readonly<{ dev: string; ino: string; mountId: string }>;
export type ManagerDrainIdentityFacts = Readonly<{ probeCase: ManagerDrainCase; machineId: string; bootId: string; managerBirth: string; pidNamespace: string;
  managerSourceSha256: string; unit: string; invocation: string; mainBirth: string; group: string; groupRoot: ManagerDrainInodeFacts;
  root: ManagerDrainInodeFacts; rootUid: number; rootGid: number; rootMode: number; programSha256: string; tiniSha256: string; nodeSha256: string; lifecycle: HostedFdUnitLifecycle }>;
const identityKeys = ["probeCase", "machineId", "bootId", "managerBirth", "pidNamespace", "managerSourceSha256", "unit", "invocation", "mainBirth", "group", "groupRoot", "root", "rootUid", "rootGid", "rootMode", "programSha256", "tiniSha256", "nodeSha256", "lifecycle"] as const;
const inodeKeys = ["dev", "ino", "mountId"] as const;
function inode(value: ManagerDrainInodeFacts): void {
  closed(value, inodeKeys, ManagerDrainHeldReason.Identity);
  check(natural(value.dev) && natural(value.ino, true) && natural(value.mountId, true), ManagerDrainHeldReason.Identity);
}
export function assertManagerDrainIdentityFacts(value: ManagerDrainIdentityFacts): void {
  closed(value, identityKeys, ManagerDrainHeldReason.Identity); validCase(value.probeCase); inode(value.groupRoot); inode(value.root);
  birth(value.managerBirth); birth(value.mainBirth);
  check(birth(value.managerBirth) !== birth(value.mainBirth) && /^[a-f0-9]{32}$/.test(value.machineId) && value.machineId !== "0".repeat(32) &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId) && value.bootId !== "00000000-0000-0000-0000-000000000000" && /^pid:\[[1-9][0-9]*\]$/.test(value.pidNamespace) &&
    [value.managerSourceSha256, value.programSha256, value.tiniSha256, value.nodeSha256].every(digest) &&
    new RegExp("^TEST-manager-drain-" + value.probeCase + "-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.service$").test(value.unit) &&
    /^[a-f0-9]{32}$/.test(value.invocation) && value.invocation !== "0".repeat(32) && canonicalGroup(value.group) && value.group.endsWith("/" + value.unit) &&
    value.rootUid === 0 && value.rootGid === 0 && value.rootMode === 0o700, ManagerDrainHeldReason.Identity);
  closed(value.lifecycle, lifecycleKeys, ManagerDrainHeldReason.Identity);
  check(value.lifecycle.Type === "exec" && value.lifecycle.ExitType === "main" && value.lifecycle.RemainAfterExit === "no" &&
    value.lifecycle.KillMode === "control-group" && value.lifecycle.SendSIGKILL === "yes" && value.lifecycle.Restart === "no" &&
    value.lifecycle.Delegate === "no" && value.lifecycle.ProtectControlGroups === "yes" && value.lifecycle.TimeoutStopUSec === "30000000" &&
    value.lifecycle.KillSignal === "15" && value.lifecycle.FinalKillSignal === "9", ManagerDrainHeldReason.Identity);
}
/** Equality of complete copied observations cannot establish retained custody. */
export function assertSameManagerDrainIdentityFacts(before: ManagerDrainIdentityFacts, after: ManagerDrainIdentityFacts): void {
  assertManagerDrainIdentityFacts(before); assertManagerDrainIdentityFacts(after);
  check(sameKeys(before, after, identityKeys.filter(key => !["groupRoot", "root", "lifecycle"].includes(key))) &&
    sameKeys(before.root, after.root, inodeKeys) && sameKeys(before.groupRoot, after.groupRoot, inodeKeys) && sameKeys(before.lifecycle, after.lifecycle, lifecycleKeys), ManagerDrainHeldReason.Identity);
}

export type ManagerDrainActorFacts = Readonly<{ role: ManagerDrainActorRole; birth: string; parentBirth: string; pidNamespace: string; group: string;
  state: ManagerDrainProcessState; executableSha256: string; programSha256: string; taskBirths: readonly string[] }>;
export function assertManagerDrainCapturedBirthFacts(identity: ManagerDrainIdentityFacts, actors: readonly ManagerDrainActorFacts[]): void {
  assertManagerDrainIdentityFacts(identity);
  check(Array.isArray(actors) && actors.length === 4, ManagerDrainHeldReason.Birth);
  for (const actor of actors) closed(actor, ["role", "birth", "parentBirth", "pidNamespace", "group", "state", "executableSha256", "programSha256", "taskBirths"], ManagerDrainHeldReason.Birth);
  const byRole = new Map(actors.map(actor => [actor.role, actor]));
  check(byRole.size === 4 && actorRoles.every(role => byRole.has(role)), ManagerDrainHeldReason.Birth);
  const tini = byRole.get(ManagerDrainActorRole.Tini)!, workload = byRole.get(ManagerDrainActorRole.Workload)!;
  check(tini.birth === identity.mainBirth && tini.parentBirth === identity.managerBirth && workload.parentBirth === tini.birth, ManagerDrainHeldReason.Birth);
  const allTasks = new Set<string>(), allPids = new Set<number>(), taskPids = new Set<number>(), managerPid = birth(identity.managerBirth);
  for (const actor of actors) {
    closed(actor, ["role", "birth", "parentBirth", "pidNamespace", "group", "state", "executableSha256", "programSha256", "taskBirths"], ManagerDrainHeldReason.Birth);
    const pid = birth(actor.birth); birth(actor.parentBirth);
    check(pid !== managerPid && !allPids.has(pid) && actor.pidNamespace === identity.pidNamespace && actor.group === identity.group &&
      actor.executableSha256 === (actor.role === ManagerDrainActorRole.Tini ? identity.tiniSha256 : identity.nodeSha256) &&
      actor.programSha256 === identity.programSha256 && (actor.role === ManagerDrainActorRole.Stopped ? /^[Tt]$/.test(actor.state) : /^[RSDI]$/.test(actor.state)) &&
      (actor.role === ManagerDrainActorRole.Tini || actor.role === ManagerDrainActorRole.Workload || actor.parentBirth === workload.birth) &&
      Array.isArray(actor.taskBirths) && actor.taskBirths.length > 0 && actor.taskBirths.includes(actor.birth), ManagerDrainHeldReason.Birth);
    allPids.add(pid);
    for (const task of actor.taskBirths) { const tid = birth(task); check(tid !== managerPid && !allTasks.has(task) && !taskPids.has(tid), ManagerDrainHeldReason.Birth); allTasks.add(task); taskPids.add(tid); }
  }
  check(allTasks.size <= 512, ManagerDrainHeldReason.Census);
}

export type ManagerDrainGroupFacts = Readonly<{ path: string; identity: ManagerDrainInodeFacts; procs: string; threads: string; events: string }>;
function populated(raw: string): number {
  check(typeof raw === "string" && Buffer.byteLength(raw) <= 65536 &&
    /^(?:populated [01]\nfrozen 0\n|frozen 0\npopulated [01]\n)$/.test(raw), ManagerDrainHeldReason.Census);
  return Number(/(?:^|\n)populated ([01])\n/.exec(raw)![1]);
}
function ids(raw: string): readonly number[] {
  check(typeof raw === "string" && Buffer.byteLength(raw) <= 65536, ManagerDrainHeldReason.Census);
  if (raw === "") return [];
  check(/^(?:[1-9][0-9]*\n)+$/.test(raw), ManagerDrainHeldReason.Census);
  const values = raw.trimEnd().split("\n").map(Number);
  check(values.length <= 512 && values.every(Number.isSafeInteger) && new Set(values).size === values.length, ManagerDrainHeldReason.Census);
  return values;
}
export function assertManagerDrainEmptyGroupFacts(identity: ManagerDrainIdentityFacts, retained: readonly ManagerDrainGroupFacts[], after: readonly ManagerDrainGroupFacts[]): void {
  assertManagerDrainIdentityFacts(identity);
  check(Array.isArray(retained) && Array.isArray(after) && retained.length > 0 && retained.length <= 128 && after.length === retained.length, ManagerDrainHeldReason.Census);
  for (const row of after) closed(row, ["path", "identity", "procs", "threads", "events"], ManagerDrainHeldReason.Census);
  const seen = new Set<string>();
  for (const original of retained) {
    closed(original, ["path", "identity", "procs", "threads", "events"], ManagerDrainHeldReason.Census); inode(original.identity);
    check(canonicalGroup(original.path) && (original.path === identity.group || original.path.startsWith(identity.group + "/")) && !seen.has(original.path), ManagerDrainHeldReason.Census);
    seen.add(original.path); ids(original.procs); ids(original.threads); populated(original.events);
    const rows = after.filter(row => row.path === original.path); check(rows.length === 1, ManagerDrainHeldReason.Census);
    const row = rows[0]!; closed(row, ["path", "identity", "procs", "threads", "events"], ManagerDrainHeldReason.Census); inode(row.identity);
    check(sameKeys(original.identity, row.identity, inodeKeys) && ids(row.procs).length === 0 && ids(row.threads).length === 0 &&
      populated(row.events) === 0, ManagerDrainHeldReason.Census);
    if (row.path === identity.group) check(sameKeys(identity.groupRoot, row.identity, inodeKeys), ManagerDrainHeldReason.Identity);
  }
  check(seen.has(identity.group), ManagerDrainHeldReason.Census);
}

export function assertManagerDrainCapturedGroupFacts(identity: ManagerDrainIdentityFacts, actors: readonly ManagerDrainActorFacts[], groups: readonly ManagerDrainGroupFacts[]): void {
  assertManagerDrainCapturedBirthFacts(identity, actors);
  check(Array.isArray(groups) && groups.length > 0 && groups.length <= 128, ManagerDrainHeldReason.Census);
  const paths = new Set<string>(), procs = new Set<number>(), threads = new Set<number>();
  const births = actors.map(actor => birth(actor.birth)), tasks = actors.flatMap(actor => actor.taskBirths.map(birth));
  for (const row of groups) {
    closed(row, ["path", "identity", "procs", "threads", "events"], ManagerDrainHeldReason.Census); inode(row.identity);
    check(canonicalGroup(row.path) && (row.path === identity.group || row.path.startsWith(identity.group + "/")) && !paths.has(row.path), ManagerDrainHeldReason.Census);
    paths.add(row.path); const rowProcs = ids(row.procs), rowThreads = ids(row.threads);
    for (const pid of rowProcs) { check(!procs.has(pid), ManagerDrainHeldReason.Census); procs.add(pid); }
    for (const tid of rowThreads) { check(!threads.has(tid), ManagerDrainHeldReason.Census); threads.add(tid); }
    // Each copied actor and its tasks declare the exact original root group;
    // tree-wide presence cannot substitute for membership in that row.
    if (row.path === identity.group) check(sameKeys(identity.groupRoot, row.identity, inodeKeys) && populated(row.events) === 1 &&
      births.every(pid => rowProcs.includes(pid)) && tasks.every(tid => rowThreads.includes(tid)), ManagerDrainHeldReason.Census);
    else check(rowProcs.length === 0 && rowThreads.length === 0 && populated(row.events) === 0, ManagerDrainHeldReason.Census);
  }
  check(paths.has(identity.group) && procs.size === births.length && births.every(pid => procs.has(pid)) &&
    threads.size === tasks.length && threads.size <= 512 && tasks.every(tid => threads.has(tid)), ManagerDrainHeldReason.Census);
}

export type ManagerDrainTerminalFacts = Readonly<{ identity: ManagerDrainIdentityFacts; mainPid: number; unitState: ManagerDrainUnitState; pendingJobs: number;
  signalSubmissions: number; cleanupEffects: number; managerAlive: boolean; proxyCompletion: ManagerDrainCompletionFact;
  stdin: ManagerDrainStreamFact; stdout: ManagerDrainStreamFact; stderr: ManagerDrainStreamFact; mainSignal: ManagerDrainSignal; mainStatus: number; mainCode: ManagerDrainMainCode; unitResult: ManagerDrainUnitResult;
  deaths: readonly Readonly<{ birth: string; state: ManagerDrainDeathFact }>[]; groups: readonly ManagerDrainGroupFacts[] }>;
/** Copied terminal facts never become a native/SDK/provider terminal brand.
 * Original P2 serialization and P4 native completion are independent obligations. */
export function assertManagerDrainTerminalFacts(original: ManagerDrainIdentityFacts, actors: readonly ManagerDrainActorFacts[], retainedGroups: readonly ManagerDrainGroupFacts[], terminal: ManagerDrainTerminalFacts): void {
  closed(terminal, ["identity", "mainPid", "unitState", "pendingJobs", "signalSubmissions", "cleanupEffects", "managerAlive", "proxyCompletion", "stdin", "stdout", "stderr", "mainSignal", "mainStatus", "mainCode", "unitResult", "deaths", "groups"], ManagerDrainHeldReason.Terminal);
  assertManagerDrainCapturedGroupFacts(original, actors, retainedGroups); assertSameManagerDrainIdentityFacts(original, terminal.identity);
  check(terminal.mainPid === 0 && [ManagerDrainUnitState.Inactive, ManagerDrainUnitState.Failed].includes(terminal.unitState) && terminal.pendingJobs === 0 &&
    terminal.signalSubmissions === 1 && terminal.cleanupEffects === 0 && terminal.managerAlive === true && terminal.mainSignal === ManagerDrainSignal.Kill &&
    terminal.mainStatus === 9 && terminal.mainCode === ManagerDrainMainCode.Killed && terminal.unitResult === ManagerDrainUnitResult.Signal &&
    terminal.proxyCompletion === ManagerDrainCompletionFact.Observed && [terminal.stdin, terminal.stdout, terminal.stderr].every(value => value === ManagerDrainStreamFact.Eof), ManagerDrainHeldReason.Terminal);
  const captured = new Set(actors.flatMap(actor => actor.taskBirths));
  check(Array.isArray(terminal.deaths) && terminal.deaths.length === captured.size, ManagerDrainHeldReason.Terminal);
  const dead = new Set<string>();
  for (const row of terminal.deaths) {
    closed(row, ["birth", "state"], ManagerDrainHeldReason.Terminal);
    check(captured.has(row.birth) && !dead.has(row.birth) && row.state === ManagerDrainDeathFact.Dead, ManagerDrainHeldReason.Terminal); dead.add(row.birth);
  }
  assertManagerDrainEmptyGroupFacts(original, retainedGroups, terminal.groups);
}
