import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { HostedCustodyPhase, HostedCustodyRequirement, HostedCustodyReservationState,
  parseHostedCustodyEpoch, type HostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { HostedReadonlySupervisorHost } from "../hosted-readonly-supervisor-host";

const runtimeDirectory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const inventoryBytes = () => Buffer.from(JSON.stringify({ schemaVersion: 2, hostId: facts.epoch!.hostId, ordinaryCreators: [] }));

// Exercise the actual outer host composition with simulated kernel/store ports.
// Passing these tests establishes ordering, not operational host exclusivity.
const facts = vi.hoisted(() => ({ epoch: null as HostedCustodyEpoch | null, locked: false, activationPhase: "EXCLUSIVE",
  order: [] as string[], launch: vi.fn(), inventory: vi.fn(), descriptors: vi.fn(), stop: vi.fn(), birth: vi.fn(), fence: vi.fn(), drain: vi.fn(), terminal: vi.fn() }));
// Preserve the actual scheduling gate; only fixed private record bytes are
// substituted alongside this suite's existing epoch/kernel port observations.
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", async original => ({
  ...await original<typeof import("../../provider-codex/app-server/adapters/hosted-process-activation")>(),
  readHostedActivationBytes: (name: string) => {
    const epoch = facts.epoch!;
    const birth = { ...epoch, generation: 1, phase: "closed", revoked: false, reservations: [], outerRuntime: null };
    const bytes = Buffer.from(JSON.stringify(birth));
    if (name === "readonly-enrollment.json") return bytes;
    if (name === "readonly-epoch.json") return Buffer.from(JSON.stringify(epoch));
    if (name === "host-installation.json") return Buffer.from(JSON.stringify({ schemaVersion: 1, installationId: "install",
      hostId: epoch.hostId, runtimeDirectory, runtimeSha: epoch.identity.runtimeSha,
      runtimeManifestSha256: epoch.identity.runtimeManifestSha256, inventorySha256: createHash("sha256").update(inventoryBytes()).digest("hex") }));
    if (name === "host-activation.json") return facts.activationPhase === "missing" ? null : Buffer.from(JSON.stringify({
      schemaVersion: 1, installationId: "install", hostId: epoch.hostId, bootId: epoch.bootId, supervisorId: epoch.supervisorId,
      generation: 1, phase: facts.activationPhase, ordinaryOriginsSha256: "a".repeat(64), ordinaryStarts: [],
      exclusiveEnrollmentSha256: createHash("sha256").update(bytes).digest("hex") }));
    if (["host-activation.next", "ordinary-origins.next", "readonly-epoch.next"].includes(name)) return null;
    throw new Error("unexpected private activation record");
  },
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string) => {
    if (path === "/var/lib/subscription-runtime-host-policy/readonly-inventory.json") return inventoryBytes();
    if (path === "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" +
        createHash("sha256").update(runtimeDirectory).digest("hex") + ".json") return Buffer.from(JSON.stringify({
      schemaVersion: 1, runtimeDirectory, runtimeSha: facts.epoch!.identity.runtimeSha,
      runtimeManifestSha256: facts.epoch!.identity.runtimeManifestSha256,
    }));
    throw new Error("unexpected inspected installation record");
  },
}));
vi.mock("../hosted-readonly-custody", async original => ({
  ...await original<typeof import("../hosted-readonly-custody")>(),
  createReadonlyPrivateRecord: (...args: unknown[]) => facts.birth(...args),
}));
vi.mock("../hosted-readonly-epoch-store", () => ({ HostedReadonlyEpochStore: class {
  serialized<T>(action: () => T): T {
    if (facts.locked) throw new Error("concurrent start");
    facts.locked = true;
    try { return action(); } finally { facts.locked = false; }
  }
  readEpoch() { return parseHostedCustodyEpoch(facts.epoch); }
  publishEpoch(epoch: HostedCustodyEpoch) {
    expect(facts.locked).toBe(true); facts.order.push("publish"); facts.epoch = parseHostedCustodyEpoch(epoch);
  }
} }));
// These legacy readonly fixtures must never execute the dependency cold protocol.
// Its new import cycle reenters the kernel while the partial kernel mock awaits
// importOriginal. Keep the real kernel helpers; refuse every cold call instead.
vi.mock("../hosted-dependency-cold-controller", () => {
  const unexpectedColdCall = (): never => { throw new Error("unexpected dependency cold protocol in readonly fixture"); };
  return {
    assertOriginalHostedDependencyColdProducer: unexpectedColdCall,
    readOriginalHostedDependencyColdSelection: unexpectedColdCall,
    finishOriginalHostedDependencyColdTree: unexpectedColdCall,
    finishOriginalHostedDependencyColdInstaller: unexpectedColdCall,
    consumeOriginalHostedDependencyColdHandoff: unexpectedColdCall,
    assertOriginalHostedDependencyConsumedColdHandoff: unexpectedColdCall,
    closeOriginalHostedDependencyColdHandoff: unexpectedColdCall,
    revokeOriginalHostedDependencyColdState: unexpectedColdCall,
  } satisfies Record<keyof typeof import("../hosted-dependency-cold-controller"), typeof unexpectedColdCall>;
});
const kernelSource = vi.hoisted(() => ({ actual: undefined as typeof import("../hosted-readonly-host-kernel") | undefined }));
function actualKernelSource(): typeof import("../hosted-readonly-host-kernel") {
  if (!kernelSource.actual) throw new Error("TEST kernel Source delegates not initialized");
  return kernelSource.actual;
}
vi.mock("../hosted-readonly-host-kernel", () => ({
  get HostedReadonlyRuntimeRole() { return actualKernelSource().HostedReadonlyRuntimeRole; },
  completionPath: (...args: Parameters<typeof import("../hosted-readonly-host-kernel").completionPath>) => actualKernelSource().completionPath(...args),
  completionBytes: (...args: Parameters<typeof import("../hosted-readonly-host-kernel").completionBytes>) => actualKernelSource().completionBytes(...args),
  ordinaryCompletionPath: (...args: Parameters<typeof import("../hosted-readonly-host-kernel").ordinaryCompletionPath>) => actualKernelSource().ordinaryCompletionPath(...args),
  ordinaryCompletionBytes: (...args: Parameters<typeof import("../hosted-readonly-host-kernel").ordinaryCompletionBytes>) => actualKernelSource().ordinaryCompletionBytes(...args),
  readHostedReadonlyHostInventory: () => JSON.parse(inventoryBytes().toString()), HostedReadonlyHostKernel: class {
  runtimeInvocation(_record: unknown, command: string, args: readonly string[]) { return { command, args }; }
  verifyRuntimeOwner() {}
  runtimeRole() { return "supervisor"; }
  fenceCreator() { facts.order.push("fence"); facts.fence(); }
  drainQueuedStart() { facts.order.push("drain"); facts.drain(); }
  confirmTerminalDescendants() { facts.order.push("terminal"); facts.terminal(); }
  assertRuntimeLaunch(...args: unknown[]) { facts.order.push("launch"); facts.launch(...args); }
  verifyExclusiveInventory() { facts.order.push("inventory"); facts.inventory(); }
  verifyDescriptorBoundary() { facts.order.push("descriptors"); facts.descriptors(); }
  requestStop(...args: unknown[]) { facts.order.push("stop"); facts.stop(...args); }
} }));
beforeAll(async () => {
  kernelSource.actual = await vi.importActual<typeof import("../hosted-readonly-host-kernel")>("../hosted-readonly-host-kernel");
});
beforeEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks(); facts.locked = false; facts.order = []; facts.activationPhase = "EXCLUSIVE";
  facts.epoch = parseHostedCustodyEpoch({ schemaVersion: 1, hostId: "host", bootId: "boot", supervisorId: "supervisor",
    outerRuntime: null, generation: 3, requirement: HostedCustodyRequirement.TestManagedQualification,
    phase: HostedCustodyPhase.Ready, revoked: false, reservations: [], identity: {
      jobId: "TEST", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/W", runtimeSha: "a".repeat(40),
      runtimeManifestSha256: "b".repeat(64), issuerDeploymentDigest: "c".repeat(64), policySha256: "d".repeat(64),
      reviewSha256: "e".repeat(64), stageSha256: "f".repeat(64), grantSha256: "0".repeat(64),
    } });
  vi.spyOn(HostedReadonlySupervisorHost.prototype, "verifyReadonlyMaterial").mockImplementation(() => { facts.order.push("material"); });
});
it("outer runtime submission checks live inventory under the same fence immediately before spawn", () => {
  const host = new HostedReadonlySupervisorHost();
  const result = host.runRuntimeLaunch("/runtime/node", ["/runtime/cli.js"], "/synthetic/W", () => {
    expect(facts.locked).toBe(true); facts.order.push("submit"); return 42;
  });
  expect(result).toBe(42);
  const duplicate = vi.fn();
  expect(() => host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", duplicate)).toThrow("already_submitted");
  expect(duplicate).not.toHaveBeenCalled();
  expect(facts.order).toEqual(["launch", "material", "inventory", "descriptors", "publish", "submit"]);
  expect(facts.launch).toHaveBeenCalledWith(expect.objectContaining({ outerRuntime: null }), "/runtime/node", ["/runtime/cli.js"], "/synthetic/W");
});
it.each(["launch", "inventory", "descriptors"] as const)("closes admission when %s fails, with no process submission", check => {
  const host = new HostedReadonlySupervisorHost(), submit = vi.fn();
  facts[check].mockImplementation(() => { throw new Error("synthetic changed host"); });
  expect(() => host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", submit)).toThrow("changed host");
  expect(submit).not.toHaveBeenCalled();
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
});
it.each(["closed", "revoked", "outstanding"])("rejects %s epoch and retains reservations", state => {
  const reservations = state === "outstanding" ? [{ startId: "A", creatorId: "A", unit: "unit-A", state: HostedCustodyReservationState.Reserved }] : [];
  facts.epoch = { ...facts.epoch!, phase: state === "outstanding" ? HostedCustodyPhase.Ready : HostedCustodyPhase.Closed,
    revoked: state === "revoked", reservations };
  const submit = vi.fn();
  expect(() => new HostedReadonlySupervisorHost().runRuntimeLaunch("/runtime/node", [], "/synthetic/W", submit)).toThrow();
  expect(submit).not.toHaveBeenCalled();
  expect(facts.epoch!.reservations).toEqual(reservations);
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
});

it("synchronous outer submission failure closes the epoch", () => {
  expect(() => new HostedReadonlySupervisorHost().runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => {
    throw new Error("synthetic spawn failure");
  })).toThrow("spawn failure");
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
});
it("outer termination closes before stopping live units, retaining terminal-proof obligations", () => {
  const host = new HostedReadonlySupervisorHost();
  host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => 42);
  const live = { startId: "A", creatorId: "A", unit: "unit-A", state: HostedCustodyReservationState.Reserved };
  const terminal = { startId: "B", creatorId: "B", unit: "unit-B", state: HostedCustodyReservationState.Terminal };
  facts.epoch = { ...facts.epoch!, outerRuntime: { ...facts.epoch!.outerRuntime!, state: HostedCustodyReservationState.Terminal }, reservations: [live, terminal], revoked: true, phase: HostedCustodyPhase.Closed };
  facts.order = [];
  facts.stop.mockImplementation(() => { throw new Error("synthetic stop failure"); });
  expect(() => host.closeRuntimeLaunch()).toThrow("stop_incomplete");
  expect(facts.order).toEqual(["publish", "stop"]);
  expect(facts.epoch!.revoked).toBe(true);
  expect(facts.epoch!.reservations).toEqual([live, terminal]);
  facts.stop.mockReset(); host.closeRuntimeLaunch();
  expect(facts.stop).toHaveBeenCalledExactlyOnceWith(live);
  expect(facts.epoch!.reservations[0]!.state).toBe(HostedCustodyReservationState.Reserved);
});
it("late outer completion cannot stop a new recovered generation", () => {
  const host = new HostedReadonlySupervisorHost();
  expect(() => host.closeRuntimeLaunch()).toThrow("not_started");
  host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => 42);
  facts.epoch = { ...facts.epoch!, generation: 4, outerRuntime: null };
  facts.order = [];
  host.closeRuntimeLaunch();
  expect(facts.order).toEqual([]);
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Ready);
});

// Exercise the actual CLI handlers, with process creation and host authority
// substituted. No signal is sent to this test process or to an OS child.
it.each(["exit", "error", "SIGTERM", "SIGINT", "SIGHUP", "close-failure", "cancelled-zero", "stdin-error", "error-zero", "child-signal", "signal-close-failure"] as const)(
  "outer CLI handles %s without promoting process exit into unit termination", async event => {
    const { ChildProcess } = await import("node:child_process");
    const child = new ChildProcess(), order: string[] = [];
    const receipt = vi.fn();
    const { PassThrough } = await import("node:stream");
    Object.defineProperty(child, "stdin", { value: new PassThrough() });
    const killChild = vi.spyOn(child, "kill").mockImplementation(() => { order.push("signal"); return true; });
    let lastEffectAtSelfSignal: string | undefined, detachedAtSelfSignal = false;
    const killSelf = vi.spyOn(process, "kill").mockImplementation(() => {
      lastEffectAtSelfSignal = order.at(-1);
      detachedAtSelfSignal = signals.every((signal, index) => {
        const listeners = process.listeners(signal), previous = before[index]!;
        return listeners.length === previous.length && listeners.every((listener, i) => listener === previous[i]);
      });
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const close = vi.fn(() => {
      order.push("close");
      if (event === "close-failure" || event === "signal-close-failure") throw new Error("synthetic publication failure");
    });
    const argv = process.argv, exitCode = process.exitCode;
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const before = signals.map(signal => process.listeners(signal));
    let markSubmitted = () => {};
    const submitted = new Promise<void>(resolve => { markSubmitted = resolve; });
    let cli: Promise<unknown> | undefined, joined = false;
    vi.doMock("node:child_process", async () => ({
      ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
      spawn: () => { markSubmitted(); return child; },
    }));
    vi.doMock("../hosted-readonly-supervisor-host", () => ({ HostedReadonlySupervisorHost: class {
      runRuntimeLaunch(_command: string, _args: readonly string[], _cwd: string, submit: (launch: { command: string; args: string[] }) => unknown) { return submit({ command: "/usr/bin/systemd-run", args: [] }); }
      recordRuntimeWaitCompletion() { receipt(); }
      closeRuntimeLaunch() { close(); }
    } }));
    try {
      process.argv = ["node", "host-cli", "runtime", "--", "/synthetic/node", "/synthetic/cli"];
      process.exitCode = undefined;
      vi.resetModules();
      cli = import("../hosted-readonly-host-launch-cli");
      await Promise.race([submitted, cli.then(() => { throw new Error("TEST CLI completed before submission"); })]);
      expect(child.listenerCount("exit")).toBe(1);
      if (event === "cancelled-zero" || event === "stdin-error" || event === "error-zero") {
        if (event === "cancelled-zero") {
          const handler = process.listeners("SIGTERM").find(listener => !before[0]!.includes(listener));
          expect(handler).toBeDefined(); handler!("SIGTERM");
        } else if (event === "stdin-error") child.stdin!.emit("error", new Error("synthetic EPIPE"));
        else child.emit("error", new Error("synthetic process error"));
        if (event !== "error-zero") expect(order).toEqual(["close", "signal"]);
        child.emit("exit", 0, null);
        expect(receipt).not.toHaveBeenCalled();
      }
      else if (event === "error") child.emit("error", new Error("synthetic asynchronous spawn failure"));
      else if (event === "exit" || event === "close-failure") child.emit("exit", 0, null);
      else if (event === "child-signal") child.emit("exit", null, "SIGTERM");
      else {
        const signal = event === "signal-close-failure" ? "SIGTERM" : event;
        const index = signals.indexOf(signal);
        const handler = process.listeners(signal).find(listener => !before[index]!.includes(listener));
        expect(handler).toBeDefined();
        handler!(signal);
        expect(order).toEqual(["close", "signal"]);
        expect(killChild).toHaveBeenCalledExactlyOnceWith(signal);
        child.emit("exit", null, signal);
      }
      await cli; joined = true;
      if (event === "child-signal" || event === "SIGTERM" || event === "SIGINT" || event === "SIGHUP") {
        expect(killSelf).toHaveBeenCalledExactlyOnceWith(process.pid, event === "child-signal" ? "SIGTERM" : event);
        expect(lastEffectAtSelfSignal).toBe("close"); expect(detachedAtSelfSignal).toBe(true);
        expect(receipt).not.toHaveBeenCalled();
      } else expect(killSelf).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      if (event === "error" || event === "close-failure" || event === "cancelled-zero" || event === "stdin-error" ||
          event === "error-zero" || event === "signal-close-failure") expect(process.exitCode).toBe(70);
      else if (event === "exit") { expect(process.exitCode).toBe(0); expect(receipt).toHaveBeenCalledOnce(); }
      signals.forEach((signal, index) => expect(process.listeners(signal)).toEqual(before[index]));
    } finally {
      if (cli && !joined) { child.emit("exit", 70, null); await cli; }
      signals.forEach((signal, index) => {
        for (const listener of process.listeners(signal)) if (!before[index]!.includes(listener)) process.off(signal, listener);
      });
      process.argv = argv; process.exitCode = exitCode;
      vi.doUnmock("node:child_process"); vi.doUnmock("../hosted-readonly-supervisor-host");
      vi.resetModules();
    }
  },
);

it("separate outer host instances cannot submit concurrently or erase the retained outer reservation", () => {
  const first = new HostedReadonlySupervisorHost(), second = new HostedReadonlySupervisorHost();
  first.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => {
    expect(facts.epoch!.outerRuntime?.state).toBe(HostedCustodyReservationState.Reserved);
    expect(facts.epoch!.outerRuntime?.generation).toBe(3);
    expect(facts.birth).toHaveBeenCalledOnce();
  });
  const retained = facts.epoch!.outerRuntime, submit = vi.fn();
  expect(() => second.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", submit)).toThrow("outer_runtime_held");
  expect(submit).not.toHaveBeenCalled();
  expect(facts.epoch!.outerRuntime).toEqual(retained);
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
});

it.each(["valid", "command-injection", "owner-denied"])("outer bootstrap %s uses only reviewed command and private pipe environment", async scenario => {
  const { PassThrough } = await import("node:stream");
  const { ChildProcess } = await import("node:child_process");
  const stdin = new PassThrough(), child = new ChildProcess();
  Object.defineProperty(child, "stdin", { value: new PassThrough() });
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as NodeJS.ReadStream & { fd: 0 });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("synthetic-bootstrap-denial"); });
  const spawn = vi.fn(() => child), owner = vi.fn(() => { if (scenario === "owner-denied") throw new Error("synthetic owner denied"); });
  vi.doMock("node:child_process", async () => ({ ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), spawn }));
  vi.doMock("../hosted-readonly-supervisor-host", () => ({ HostedReadonlySupervisorHost: class {
    verifyRuntimeOwner() { owner(); }
    verifyReadonlyMaterial() {}
    verifyDescriptorBoundary() {}
    readEpoch() { return { identity: {} }; }
  } }));
  vi.doMock("../hosted-readonly-host-kernel", () => ({ readHostedReadonlyHostInventory: () => ({
    runtimeLaunch: { command: "/reviewed/node", args: ["/reviewed/cli.js"], cwd: "/synthetic/W" },
  }) }));
  try {
    vi.resetModules(); await import("../hosted-readonly-runtime-bootstrap");
    const frame = { schemaVersion: 1, env: { SYNTHETIC_PRIVATE: "never-log-this" },
      ...(scenario === "command-injection" ? { command: "/unreviewed/node" } : {}) };
    stdin.emit("data", Buffer.from(JSON.stringify(frame)));
    const listeners = stdin.listeners("end"); expect(listeners).toHaveLength(1);
    const end = listeners[0]; if (!end) throw new Error("TEST bootstrap end handler absent");
    if (scenario === "valid") {
      await end.call(stdin);
      expect(spawn).toHaveBeenCalledWith("/reviewed/node", ["/reviewed/cli.js"], {
        cwd: "/synthetic/W", env: frame.env, stdio: ["pipe", "inherit", "inherit"],
      });
    } else {
      await expect(end.call(stdin)).rejects.toThrow("synthetic-bootstrap-denial");
      expect(exit).toHaveBeenCalledWith(70);
      expect(spawn).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith("hosted_custody_runtime_bootstrap_denied\n");
    }
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("never-log-this");
  } finally {
    stdin.removeAllListeners();
    vi.doUnmock("node:child_process"); vi.doUnmock("../hosted-readonly-supervisor-host"); vi.doUnmock("../hosted-readonly-host-kernel");
    vi.resetModules();
  }
});

it("failed outer birth publication holds the epoch and never invokes the real submitter", () => {
  const host = new HostedReadonlySupervisorHost(), submit = vi.fn();
  facts.birth.mockImplementation(() => { throw new Error("synthetic conflicting outer birth"); });
  expect(() => host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", submit)).toThrow("conflicting outer birth");
  expect(submit).not.toHaveBeenCalled();
  expect(facts.epoch!.outerRuntime!.state).toBe(HostedCustodyReservationState.Reserved);
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
});

it.each(["success", "birth", "fence", "drain", "terminal"] as const)(
  "outer completion retains its reservation until every terminal proof passes: %s", failure => {
    const host = new HostedReadonlySupervisorHost();
    host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => 42);
    facts.order = [];
    facts.birth.mockImplementation(() => { facts.order.push("receipt"); });
    if (failure !== "success") facts[failure].mockImplementation(() => { throw new Error("synthetic incomplete proof"); });
    if (failure === "success") {
      host.recordRuntimeWaitCompletion();
      expect(facts.order).toEqual(["receipt", "fence", "drain", "terminal", "publish"]);
      expect(facts.epoch!.outerRuntime!.state).toBe(HostedCustodyReservationState.Terminal);
    } else {
      expect(() => host.recordRuntimeWaitCompletion()).toThrow("incomplete proof");
      expect(facts.order).not.toContain("publish");
      expect(facts.epoch!.outerRuntime!.state).toBe(HostedCustodyReservationState.Reserved);
    }
    host.closeRuntimeLaunch();
    expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
    expect(facts.stop).toHaveBeenCalledTimes(failure === "success" ? 0 : 1);
  },
);

it("stops the authenticated outer and providers only after closing, retaining every reservation", () => {
  const host = new HostedReadonlySupervisorHost();
  host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => 1);
  const outer = facts.epoch!.outerRuntime;
  facts.order = [];
  facts.stop.mockImplementation(() => {
    expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
    expect(() => host.serialized(() => {})).not.toThrow();
  });
  host.stopRuntime(facts.epoch!.identity);
  expect(facts.order).toEqual(["publish", "stop"]);
  expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
  expect(facts.epoch!.outerRuntime).toEqual(outer);
});
it("outer cancellation releases the common fence before an OS stop callback", () => {
  const host = new HostedReadonlySupervisorHost();
  host.runRuntimeLaunch("/runtime/node", [], "/synthetic/W", () => 1);
  const outer = facts.epoch!.outerRuntime;
  facts.stop.mockImplementation(() => {
    expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
    expect(() => host.serialized(() => {})).not.toThrow();
    throw new Error("synthetic stop failure");
  });
  expect(() => host.closeRuntimeLaunch()).toThrow("hosted_custody_runtime_stop_incomplete");
  expect(facts.epoch!.outerRuntime).toEqual(outer);
  expect(facts.locked).toBe(false);
});
it("a different identity cannot close or stop the enrolled runtime", () => {
  const host = new HostedReadonlySupervisorHost();
  expect(() => host.stopRuntime({ ...facts.epoch!.identity, jobId: "other" })).toThrow();
  expect(facts.order).toEqual([]);
  expect(facts.stop).not.toHaveBeenCalled();
});

it.each(["CLOSED", "ORDINARY", "ENTERING_EXCLUSIVE", "LEAVING_EXCLUSIVE", "missing"])(
  "managed outer submission requires authentic EXCLUSIVE activation: %s", phase => {
    facts.activationPhase = phase;
    const submit = vi.fn();
    expect(() => new HostedReadonlySupervisorHost().runRuntimeLaunch("/runtime/node", [], "/synthetic/W", submit)).toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect(facts.epoch!.phase).toBe(HostedCustodyPhase.Closed);
  });
