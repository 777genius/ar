import { describe, expect, it } from "vitest";
import { armManagerDrainBudget, observeManagerDrainBudget, nextManagerDrainPhase, assertManagerDrainIdentityFacts,
  assertSameManagerDrainIdentityFacts, assertManagerDrainCapturedBirthFacts, assertManagerDrainCapturedGroupFacts,
  assertManagerDrainEmptyGroupFacts, assertManagerDrainTerminalFacts, ManagerDrainCase as Case, ManagerDrainPhase as Phase,
  ManagerDrainEvent as Event, ManagerDrainActorRole as Role, ManagerDrainDeathFact as Death, ManagerDrainUnitState as UnitState,
  ManagerDrainCompletionFact as Completion, ManagerDrainStreamFact as Stream, ManagerDrainProcessState as State,
  ManagerDrainSignal as Signal, ManagerDrainMainCode as Code, ManagerDrainUnitResult as Result,
  type ManagerDrainIdentityFacts, type ManagerDrainActorFacts, type ManagerDrainGroupFacts, type ManagerDrainTerminalFacts,
} from "../../../scripts/dependency-retention-os-test/current-manager-drain-probe.js";

// Synthetic copied DATA for portable predicates only: no proc, metadata mock,
// native handle, original session, constructor, effect, or native PASS exists.
function facts(probeCase = Case.Preparation) {
  const identity: ManagerDrainIdentityFacts = { probeCase, machineId: "a".repeat(32), bootId: "11111111-1111-1111-1111-111111111111",
    managerBirth: "1:10", pidNamespace: "pid:[100]", managerSourceSha256: "a".repeat(64),
    unit: `TEST-manager-drain-${probeCase}-22222222-2222-2222-2222-222222222222.service`, invocation: "b".repeat(32),
    mainBirth: "10:20", group: `/system.slice/TEST-manager-drain-${probeCase}-22222222-2222-2222-2222-222222222222.service`,
    groupRoot: { dev: "20", ino: "30", mountId: "40" }, root: { dev: "21", ino: "31", mountId: "41" }, rootUid: 0, rootGid: 0, rootMode: 0o700,
    programSha256: "c".repeat(64), tiniSha256: "d".repeat(64), nodeSha256: "e".repeat(64),
    lifecycle: { Type: "exec", ExitType: "main", RemainAfterExit: "no", KillMode: "control-group", SendSIGKILL: "yes", Restart: "no", Delegate: "no",
      ProtectControlGroups: "yes", TimeoutStopUSec: "30000000", KillSignal: "15", FinalKillSignal: "9" } };
  const actors: ManagerDrainActorFacts[] = [Role.Tini, Role.Workload, Role.TermResistant, Role.Stopped].map((role, i) => ({ role, birth: `${10 + i}:${20 + i}`,
    parentBirth: i === 0 ? identity.managerBirth : i === 1 ? identity.mainBirth : "11:21", pidNamespace: identity.pidNamespace, group: identity.group,
    state: role === Role.Stopped ? State.Stopped : State.Sleeping, executableSha256: role === Role.Tini ? identity.tiniSha256 : identity.nodeSha256,
    programSha256: identity.programSha256, taskBirths: [`${10 + i}:${20 + i}`, ...(role === Role.Workload ? ["14:24"] : [])] }));
  const groups: ManagerDrainGroupFacts[] = [{ path: identity.group, identity: { ...identity.groupRoot }, procs: "10\n11\n12\n13\n", threads: "10\n11\n12\n13\n14\n", events: "populated 1\nfrozen 0\n" }];
  const terminal: ManagerDrainTerminalFacts = { identity: structuredClone(identity), mainPid: 0, unitState: UnitState.Failed, pendingJobs: 0, signalSubmissions: 1,
    cleanupEffects: 0, managerAlive: true, proxyCompletion: Completion.Observed, stdin: Stream.Eof, stdout: Stream.Eof, stderr: Stream.Eof,
    mainSignal: Signal.Kill, mainStatus: 9, mainCode: Code.Killed, unitResult: Result.Signal,
    deaths: actors.flatMap(actor => actor.taskBirths.map(birth => ({ birth, state: Death.Dead }))),
    groups: groups.map(group => ({ ...group, procs: "", threads: "", events: "populated 0\nfrozen 0\n" })) };
  return { identity, actors, groups, terminal };
}

function relocatedFacts(placement: "PID-only" | "TID-only" | "PID-and-TID") {
  const f = facts(), root = f.groups[0]!;
  const moveProcs = placement !== "TID-only", moveThreads = placement !== "PID-only";
  const groups = [
    { ...root, procs: moveProcs ? "" : root.procs, threads: moveThreads ? "" : root.threads },
    { path: root.path + "/child", identity: { ...root.identity, ino: "99" },
      procs: moveProcs ? root.procs : "", threads: moveThreads ? root.threads : "", events: "populated 1\nfrozen 0\n" },
  ];
  // Preserve the complete tree-wide PID/TID union and every actor's root
  // group claim, and provide positive matching terminal rows for both groups.
  return { ...f, groups, terminal: { ...f.terminal,
    groups: groups.map(row => ({ ...row, procs: "", threads: "", events: "populated 0\nfrozen 0\n" })) } };
}

describe("manager-only drain copied-fact SOURCE contract", () => {
  it.each([Case.Preparation, Case.Ready])("keeps %s finite and observational; copied consistency returns no authority", probeCase => {
    const f = facts(probeCase);
    expect(assertManagerDrainTerminalFacts(f.identity, f.actors, f.groups, f.terminal)).toBeUndefined();
    // Deserializing consistent DATA does not become original constructor proof.
    const copied: ManagerDrainTerminalFacts = JSON.parse(JSON.stringify(f.terminal));
    expect(assertManagerDrainTerminalFacts(f.identity, f.actors, f.groups, copied)).toBeUndefined();
    let phase = nextManagerDrainPhase(probeCase, Phase.Pending, Event.Capture);
    if (probeCase === Case.Ready) phase = nextManagerDrainPhase(probeCase, phase, Event.Ready);
    phase = nextManagerDrainPhase(probeCase, phase, Event.MainSignal);
    expect(nextManagerDrainPhase(probeCase, phase, Event.Terminal)).toBe(Phase.TerminalFacts);
  });
  it.each([
    [Case.Preparation, Phase.Captured, Event.Ready], [Case.Ready, Phase.Captured, Event.MainSignal],
    [Case.Preparation, Phase.Pending, Event.MainSignal], [Case.Preparation, Phase.Captured, Event.Terminal],
    [Case.Ready, Phase.Effect, Event.MainSignal], [Case.Ready, Phase.TerminalFacts, Event.Capture], [Case.Ready, Phase.Held, Event.Capture],
  ] as const)("refuses wrong order/repeat/reset: %s %s %s", (probeCase, phase, event) => {
    expect(() => nextManagerDrainPhase(probeCase, phase, event)).toThrow("TEST_manager_drain_phase");
  });
  it("retains failure and refuses unknown cases/events", () => {
    expect(nextManagerDrainPhase(Case.Ready, Phase.Effect, Event.Fail)).toBe(Phase.Held);
    expect(() => Reflect.apply(nextManagerDrainPhase, undefined, ["provider", Phase.Pending, Event.Capture])).toThrow("TEST_manager_drain_case");
    expect(() => Reflect.apply(nextManagerDrainPhase, undefined, [Case.Ready, Phase.Pending, "start"])).toThrow("TEST_manager_drain_phase");
  });
  it("uses the earlier original veto and fixed case deadline, with floored syscall bounds", () => {
    const armed = armManagerDrainBudget(10n, 40000);
    const first = observeManagerDrainBudget(armed, 1000000010n, 1234);
    expect(first).toMatchObject({ remainingMs: 1234, queryTimeoutMs: 1234, pollingSleepMs: 10 });
    expect(first.budget.deadlineNs).toBe(armed.deadlineNs);
    const final = observeManagerDrainBudget(first.budget, armed.deadlineNs - 1000001n, 40000);
    expect(final).toMatchObject({ remainingMs: 1, queryTimeoutMs: 1, pollingSleepMs: 1 });
  });
  it.each([39999, 0, -1, 40000.5, NaN, Infinity])("holds insufficient or noninteger original budget %s before arm", remaining => {
    expect(() => armManagerDrainBudget(0n, remaining)).toThrow("TEST_manager_drain_budget");
  });
  it("refuses refreshed duration, clock reversal, expiration and sub-ms residue", () => {
    const armed = armManagerDrainBudget(100n, 50000), observed = observeManagerDrainBudget(armed, 1000100n, 40000);
    expect(() => observeManagerDrainBudget({ ...armed, deadlineNs: armed.deadlineNs + 1n }, 100n, 50000)).toThrow("TEST_manager_drain_budget");
    expect(() => observeManagerDrainBudget(observed.budget, 100n, 50000)).toThrow("TEST_manager_drain_budget");
    expect(() => observeManagerDrainBudget(armed, armed.deadlineNs, 50000)).toThrow("TEST_manager_drain_budget");
    expect(() => observeManagerDrainBudget(armed, armed.deadlineNs - 999999n, 50000)).toThrow("TEST_manager_drain_budget");
    expect(() => observeManagerDrainBudget(armed, 100n, 0)).toThrow("TEST_manager_drain_budget");
  });
  it.each(["machineId", "bootId", "managerBirth", "pidNamespace", "managerSourceSha256", "unit", "invocation", "mainBirth", "group", "programSha256", "tiniSha256", "nodeSha256"] as const)
    ("refuses selected identity drift in %s", field => {
      const f = facts(), next = structuredClone(f.identity);
      const changed = { ...f.identity, machineId: "f".repeat(32), bootId: "33333333-3333-3333-3333-333333333333", managerBirth: "1:11",
        pidNamespace: "pid:[101]", managerSourceSha256: "f".repeat(64), unit: f.identity.unit.replaceAll("2", "3"), invocation: "f".repeat(32),
        mainBirth: "10:999", group: "/other.slice/" + f.identity.unit, programSha256: "f".repeat(64), tiniSha256: "f".repeat(64), nodeSha256: "f".repeat(64) };
      Object.assign(next, { [field]: changed[field], ...(field === "unit" ? { group: "/system.slice/" + changed.unit } : {}) });
      expect(() => assertManagerDrainIdentityFacts(next)).not.toThrow();
      expect(() => assertSameManagerDrainIdentityFacts(f.identity, next)).toThrow();
    });
  it.each(["root", "groupRoot"] as const)("refuses %s named inode or mount replacement", field => {
    const f = facts(), next = { ...f.identity, [field]: { ...f.identity[field], mountId: "99" } };
    expect(() => assertSameManagerDrainIdentityFacts(f.identity, next)).toThrow("TEST_manager_drain_identity");
  });
  it.each(["Type", "ExitType", "RemainAfterExit", "KillMode", "SendSIGKILL", "Restart", "Delegate", "ProtectControlGroups", "TimeoutStopUSec", "KillSignal", "FinalKillSignal"] as const)
    ("refuses manager lifecycle substitution/absence %s", field => {
      const f = facts(), lifecycle = Object.assign({}, f.identity.lifecycle, { [field]: "" });
      expect(() => assertManagerDrainIdentityFacts({ ...f.identity, lifecycle })).toThrow("TEST_manager_drain_identity");
    });
  it("rejects public grant/accessor fields and same numeric manager PID with a different tick", () => {
    const f = facts();
    expect(() => assertManagerDrainIdentityFacts(Object.assign({}, f.identity, { grant: true }))).toThrow("TEST_manager_drain_identity");
    const accessor = { ...f.identity }; Object.defineProperty(accessor, "unit", { get: () => { throw new Error("must not evaluate"); } });
    expect(() => assertManagerDrainIdentityFacts(accessor)).toThrow("TEST_manager_drain_identity");
    expect(() => assertManagerDrainIdentityFacts({ ...f.identity, mainBirth: "1:99" })).toThrow("TEST_manager_drain_identity");
    expect(() => assertManagerDrainIdentityFacts({ ...f.identity, rootMode: 0o755 })).toThrow("TEST_manager_drain_identity");
  });
  it.each(["namespace", "parent", "group", "executable", "program", "stopped", "role", "missing-task", "duplicate-tid", "manager-pid"])
    ("refuses wrong actor or incomplete births: %s", fault => {
      const f = facts(), rows = structuredClone(f.actors), row = rows[3]!;
      if (fault === "namespace") Object.assign(row, { pidNamespace: "pid:[101]" });
      if (fault === "parent") Object.assign(row, { parentBirth: f.identity.mainBirth });
      if (fault === "group") Object.assign(row, { group: f.identity.group + "/foreign" });
      if (fault === "executable") Object.assign(row, { executableSha256: "f".repeat(64) });
      if (fault === "program") Object.assign(row, { programSha256: "f".repeat(64) });
      if (fault === "stopped") Object.assign(row, { state: State.Sleeping });
      if (fault === "role") Object.assign(row, { role: Role.Tini });
      if (fault === "missing-task") Object.assign(row, { taskBirths: [] });
      if (fault === "duplicate-tid") Object.assign(row, { taskBirths: [row.birth, "14:999"] });
      if (fault === "manager-pid") Object.assign(row, { birth: "1:99", taskBirths: ["1:99"] });
      expect(() => assertManagerDrainCapturedBirthFacts(f.identity, rows)).toThrow();
    });
  it.each(["missing-process", "late-process", "missing-thread", "late-thread", "missing-root", "wrong-root", "duplicate-process", "overflow"])
    ("holds incomplete original whole group census: %s", fault => {
      const f = facts(), rows = structuredClone(f.groups), row = rows[0]!;
      if (fault === "missing-process") Object.assign(row, { procs: "10\n11\n12\n" });
      if (fault === "late-process") Object.assign(row, { procs: row.procs + "99\n" });
      if (fault === "missing-thread") Object.assign(row, { threads: row.procs });
      if (fault === "late-thread") Object.assign(row, { threads: row.threads + "99\n" });
      if (fault === "missing-root") rows.length = 0;
      if (fault === "wrong-root") Object.assign(row.identity, { ino: "99" });
      if (fault === "duplicate-process") Object.assign(row, { procs: row.procs + "10\n" });
      if (fault === "overflow") Object.assign(row, { threads: "1\n".repeat(33000) });
      expect(() => assertManagerDrainCapturedGroupFacts(f.identity, f.actors, rows)).toThrow();
    });
  it.each(["PID-only", "TID-only", "PID-and-TID"] as const)("rejects %s relocation despite unchanged whole-tree membership", placement => {
    const f = relocatedFacts(placement);
    expect(() => assertManagerDrainCapturedGroupFacts(f.identity, f.actors, f.groups)).toThrow("TEST_manager_drain_census");
  });
  it.each(["PID-only", "TID-only", "PID-and-TID"] as const)("rejects terminal facts resting on inconsistent %s captured membership", placement => {
    const f = relocatedFacts(placement);
    expect(() => assertManagerDrainTerminalFacts(f.identity, f.actors, f.groups, f.terminal)).toThrow("TEST_manager_drain_census");
  });
  it("retains empty descendants and rejects populated/late child rows independently", () => {
    const f = facts(), child = { path: f.identity.group + "/child", identity: { ...f.identity.groupRoot, ino: "99" },
      procs: "", threads: "", events: "populated 0\nfrozen 0\n" };
    const groups = [...f.groups, child], terminal = { ...f.terminal, groups: [...f.terminal.groups, child] };
    expect(() => assertManagerDrainTerminalFacts(f.identity, f.actors, groups, terminal)).not.toThrow();
    for (const fault of [{ events: "populated 1\nfrozen 0\n" }, { procs: "99\n" }, { threads: "99\n" }]) {
      const wrong = [f.groups[0]!, { ...child, ...fault }];
      expect(() => assertManagerDrainCapturedGroupFacts(f.identity, f.actors, wrong)).toThrow("TEST_manager_drain_census");
    }
  });
  it.each(["survivor", "thread", "populated", "missing-events", "unknown-events", "early-unload", "extra-group", "replacement", "traversal"])
    ("refuses terminal census without positive stable emptiness: %s", fault => {
      const f = facts(), rows = [...structuredClone(f.terminal.groups)], row = rows[0]!;
      if (fault === "survivor") Object.assign(row, { procs: "13\n" });
      if (fault === "thread") Object.assign(row, { threads: "14\n" });
      if (fault === "populated") Object.assign(row, { events: "populated 1\nfrozen 0\n" });
      if (fault === "missing-events") Object.assign(row, { events: "" });
      if (fault === "unknown-events") Object.assign(row, { events: "populated 0\nfrozen 0\ngrant 1\n" });
      if (fault === "early-unload") rows.length = 0;
      if (fault === "extra-group") rows.push({ ...row, path: row.path + "/late" });
      if (fault === "replacement") Object.assign(row.identity, { ino: "99" });
      if (fault === "traversal") Object.assign(row, { path: row.path + "/../other" });
      expect(() => assertManagerDrainEmptyGroupFacts(f.identity, f.groups, rows)).toThrow();
    });
  it("holds incomplete scans exceeding fixed tree/task/depth bounds and never truncates", () => {
    const f = facts(), manyGroups = Array.from({ length: 129 }, (_, i) => ({ ...f.groups[0]!, path: f.identity.group + "/g" + i }));
    expect(() => assertManagerDrainEmptyGroupFacts(f.identity, manyGroups, manyGroups)).toThrow("TEST_manager_drain_census");
    const deep = [{ ...f.groups[0]!, path: f.identity.group + "/a/b/c/d/e/f/g/h/i" }];
    expect(() => assertManagerDrainEmptyGroupFacts(f.identity, deep, deep)).toThrow("TEST_manager_drain_census");
    const actors = structuredClone(f.actors);
    Object.assign(actors[1]!, { taskBirths: [...actors[1]!.taskBirths, ...Array.from({ length: 508 }, (_, i) => `${100 + i}:${1000 + i}`)] });
    expect(() => assertManagerDrainCapturedBirthFacts(f.identity, actors)).toThrow("TEST_manager_drain_census");
  });
  it.each(["manager-dead", "main-live", "restarting", "deactivating", "job", "second-signal", "cleanup", "fake-close", "unknown-completion", "open-stream", "wrong-signal", "wrong-code", "zero-result", "missing-birth", "duplicate-birth", "unknown-death", "live-task"])
    ("refuses terminal shortcuts or effect substitution: %s", fault => {
      const f = facts(), t = structuredClone(f.terminal);
      if (fault === "manager-dead") Object.assign(t, { managerAlive: false });
      if (fault === "main-live") Object.assign(t, { mainPid: 10 });
      if (fault === "restarting") Object.assign(t, { unitState: UnitState.Restarting });
      if (fault === "deactivating") Object.assign(t, { unitState: UnitState.Deactivating });
      if (fault === "job") Object.assign(t, { pendingJobs: 1 });
      if (fault === "second-signal") Object.assign(t, { signalSubmissions: 2 });
      if (fault === "cleanup") Object.assign(t, { cleanupEffects: 1 });
      if (fault === "fake-close") Object.assign(t, { proxyCompletion: Completion.Unknown, closeEvent: true });
      if (fault === "unknown-completion") Object.assign(t, { proxyCompletion: Completion.Unknown });
      if (fault === "open-stream") Object.assign(t, { stdout: Stream.Open });
      if (fault === "wrong-signal") Object.assign(t, { mainSignal: Signal.Term });
      if (fault === "wrong-code") Object.assign(t, { mainCode: Code.Exited, mainStatus: 0 });
      if (fault === "zero-result") Object.assign(t, { unitResult: Result.Success });
      if (fault === "missing-birth") Object.assign(t, { deaths: t.deaths.slice(1) });
      if (fault === "duplicate-birth") Object.assign(t, { deaths: [t.deaths[0]!, t.deaths[0]!, ...t.deaths.slice(2)] });
      if (fault === "unknown-death") Object.assign(t, { deaths: t.deaths.map((r, i) => i === 0 ? { ...r, state: Death.Unknown } : r) });
      if (fault === "live-task") Object.assign(t, { deaths: t.deaths.map(r => r.birth === "14:24" ? { ...r, state: Death.Live } : r) });
      expect(() => assertManagerDrainTerminalFacts(f.identity, f.actors, f.groups, t)).toThrow();
    });
});
