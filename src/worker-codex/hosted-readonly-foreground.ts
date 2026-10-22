import { assertHostedOrdinaryDependencyBootstrap } from "./hosted-ordinary-dependency-reader";
import { assertHostedOrdinaryDependencyToolParentFrame } from "./hosted-managed-dependency-tool-plan";
import { assertHostedOrdinaryLaunchExtent, hostedOrdinaryLaunchEnvironment } from "./hosted-ordinary-writer-authority";
import { readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { ordinaryInstallationRemainingMs, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { collectProcessBirth } from "./hosted-readonly-linux-collector";
import { readFileSync, readlinkSync } from "node:fs";
import type { HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { watchChildDeadline } from "./child-deadline-watch";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { readHostedChildSlot } from "./hosted-child-slot-files";
import { HostedReadonlyRuntimeRole } from "./hosted-readonly-host-kernel";
import { spawn, type ChildProcess } from "node:child_process";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { requiresHostedProcessAdmission, withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedInstallationActivationStore, readHostedInstallationActivation, isHostedOrdinaryRuntime, readHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { hostedFdLaunch, hostedFdInvocationUnit, spawnHostedFdChild, HostedFdLaunchKind, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { announceHostedFdPrelude, assertHostedFdFrameEnvironment } from "../provider-codex/app-server/adapters/hosted-fd-prelude";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { closeHostedForegroundRequest, recheckHostedForegroundRequest, hostedForegroundExitCode, publishHostedForegroundResult, requireHostedForegroundRequest } from "./hosted-foreground-result";

/** Opted TEST frames are request data, not authority to load code into the
 * initial-host launcher/CLI or redirect its pre-admission Git/registry reads. */
function assertDependencyHostFrameEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "OPENSSL_CONF", "OPENSSL_MODULES",
      "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"].includes(key) ||
        /^(?:LD_|DYLD_|GIT_)/.test(key)) throw new Error("dependency_host_environment_unsupported");
  }
}

/** Exact root-inventory command, foreground service lifetime. The caller never
 * supplies a host implementation or a completion receipt. */
export async function runHostedReadonlyForeground(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<number | HostedForegroundResult> {
  return (await runHostedReadonlyCompletion(command, args, cwd, env)).result;
}

/** Outer CLI outcome only. It conveys no lifecycle receipt or admission and
 * retains the actual terminal signal only after legacy close and detach. */
export async function runHostedReadonlyCliForeground(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<Readonly<{ result: number | HostedForegroundResult; signal: NodeJS.Signals | null }>> {
  return runHostedReadonlyCompletion(command, args, cwd, env);
}

async function runHostedReadonlyCompletion(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<Readonly<{ result: number | HostedForegroundResult; signal: NodeJS.Signals | null }>> {
  const host = new HostedReadonlySupervisorHost();
  const fdProfile = readHostedFdProfile();
  const output = fdProfile ? requireHostedForegroundRequest(args, cwd) : undefined;
  let frame: Buffer;
  try {
    if (fdProfile) assertHostedFdFrameEnvironment(env);
    frame = Buffer.from(JSON.stringify({ schemaVersion: 1, env }));
    if (frame.length > 4 * 1024 * 1024) throw new Error("hosted_custody_launch_frame_invalid");
  } catch (error) { if (output) closeHostedForegroundRequest(output); throw error; }
  let child: ChildProcess;
  try { child = host.runRuntimeLaunch(command, args, cwd, launch => {
    if (fdProfile) return spawnHostedFdChild(launch.command, launch.args, { cwd }, hostedFdInvocationUnit(launch.args), HostedFdLaunchKind.Foreground);
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(frame);
    return child;
  }, output); } catch (error) { if (output) closeHostedForegroundRequest(output); throw error; }
  return await new Promise<Readonly<{ result: number | HostedForegroundResult; signal: NodeJS.Signals | null }>>((resolve) => {
    let failed = false, cleanupFailed = false;
    const close = () => {
      try { host.closeRuntimeLaunch(); }
      catch { failed = true; cleanupFailed = true; }
    };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const handlers = signals.map(signal => {
      const handler = () => { failed = true; close(); child.kill(signal); };
      process.on(signal, handler);
      return handler;
    });
    const detach = () => { if (output) closeHostedForegroundRequest(output); signals.forEach((signal, index) => process.off(signal, handlers[index]!)); };
    child.stdin!.on("error", () => { failed = true; close(); child.kill("SIGTERM"); });
    child.once("error", () => { failed = true; close(); detach(); resolve({ result: 70, signal: null }); });
    child.once(fdProfile ? "close" : "exit", (code, signal) => {
      let result: HostedForegroundResult | undefined;
      if (!failed && signal === null && code !== null && (code === 0 || output)) {
        try {
          if (code === 0) host.recordRuntimeWaitCompletion();
          if (output) {
            const guard = hostedFdLaunch(child);
            const facts = guard.foregroundResult();
            result = host.withForegroundTerminal(facts, owner => publishHostedForegroundResult(output, facts, owner));
          }
        } catch { failed = true; }
      }
      close(); detach();
      // A published nonzero result is a truthful completed failure, independent
      // of cleanup uncertainty. It grants no zero wait receipt or release.
      resolve({ result: result && result.exitCode !== 0 && signal === null ? result : failed || signal !== null ? 70 : result ?? code ?? 70,
        signal: !fdProfile && !cleanupFailed ? signal : null });
    });
    if (fdProfile) {
      const guard = hostedFdLaunch(child);
      void guard.observe().then(() => retryHostedFenceAcquisition(() =>
        host.releaseRuntimeFrame(frame,(fence, revalidate) => guard.release(fence, frame, true, revalidate)), guard.remainingSetupMs()))
        .catch(() => { failed = true; guard.invalidate(); close(); child.kill("SIGTERM"); });
    }
  });
}

/** CLI transport only: the installed inventory must name this exact foreground
 * runtime command. Controller children reread their manifest under the lease. */
export async function routeHostedRuntimeCommand(args: readonly string[]): Promise<number | undefined> {
  if (!requiresHostedProcessAdmission(process.env)) return undefined;
  if (isHostedOrdinaryRuntime()) {
    withHostedActivationFence(fence => readHostedOrdinaryRuntime(fence));
    return undefined;
  }
  if (readHostedInstallationActivation().activation.phase === HostedActivationPhase.Ordinary) {
    return hostedForegroundExitCode(await runHostedRuntimeForeground(process.execPath, args, process.cwd(), process.env));
  }
  const host = new HostedReadonlySupervisorHost();
  if (host.runtimeRole() === HostedReadonlyRuntimeRole.Runtime) return undefined;
  return hostedForegroundExitCode(await runHostedRuntimeForeground(process.execPath, args, process.cwd(), process.env));
}

/** Both dispatch paths use this artifact and the installed activation record.
 * Selecting ORDINARY is not admission: the store then binds the exact inventoried
 * command and persists its start under the same lock as synchronous submission. */
export async function runHostedRuntimeForeground(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<number | HostedForegroundResult> {
  if (readHostedInstallationActivation().activation.phase !== HostedActivationPhase.Ordinary) {
    return runHostedReadonlyForeground(command, args, cwd, env);
  }
  const store = new HostedInstallationActivationStore();
  const fdProfile = readHostedFdProfile();
  const output = fdProfile ? requireHostedForegroundRequest(args, cwd) : undefined;
  let frame: Buffer;
  try {
    if (fdProfile) assertHostedFdFrameEnvironment(env);
    if (isHostedDependencyWorkspace(cwd)) assertDependencyHostFrameEnvironment(env);
    else env = hostedOrdinaryLaunchEnvironment({ command, args, cwd }, env);
    frame = Buffer.from(JSON.stringify({ schemaVersion: 1, env }));
    if (frame.length > 4 * 1024 * 1024) throw new Error("hosted_custody_launch_frame_invalid");
  } catch (error) { if (output) closeHostedForegroundRequest(output); throw error; }
  let child: ChildProcess;
  const inventory = readHostedReadonlyHostInventory();
  try { child = store.runOrdinaryRuntimeLaunch(command, args, cwd, (launch, fence, original) => {
    if (output) recheckHostedForegroundRequest(output, fence);
    if (fdProfile) return spawnHostedFdChild(launch.command, launch.args, { cwd }, hostedFdInvocationUnit(launch.args), HostedFdLaunchKind.Foreground, original);
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(frame);
    return child;
  }, output, env); } catch (error) { if (output) closeHostedForegroundRequest(output); throw error; }
  return new Promise<number | HostedForegroundResult>(resolve => {
    let failed = false;
    const supervisor = inventory.schemaVersion === 5 ? (inventory as unknown as HostedInventoryV5).supervisor : undefined;
    let proxyBirth: string | undefined;
    try { if (supervisor && child.pid) proxyBirth = collectProcessBirth(String(child.pid)); } catch { failed = true; }
    const close = () => { try { if (!store.requestOrdinaryDependencyCleanup() && !store.requestOrdinaryChildCleanup()) store.closeOrdinaryRuntimeLaunch(); } catch { failed = true; } };
    const stopProxy = (signal: NodeJS.Signals) => {
      if (!supervisor) { child.kill(signal); return; }
      try {
        if (!proxyBirth || !child.pid || child.exitCode !== null || child.signalCode !== null || collectProcessBirth(String(child.pid)) !== proxyBirth) return;
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[1] !== String(process.pid) || readlinkSync(`/proc/${child.pid}/exe`) !== trustedCustodySystemdRunExecutable) return;
        ordinaryInstallationRemainingMs(supervisor, true); child.kill(signal);
      } catch { failed = true; /* Original expired/unknown custody stays HELD. */ }
    };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const handlers = signals.map(signal => {
      const handler = () => { failed = true; close(); stopProxy(signal); };
      process.on(signal, handler); return handler;
    });
    let stopWatch = () => {};
    let originalTimer: ReturnType<typeof setTimeout> | undefined;
    if (inventory.schemaVersion === 5) {
      try {
        originalTimer = setTimeout(() => { failed = true; hostedFdLaunch(child).invalidate(); close(); stopProxy("SIGTERM"); },
          ordinaryInstallationRemainingMs((inventory as unknown as HostedInventoryV5).supervisor));
      } catch { failed = true; close(); }
    }
    const detach = () => { if (originalTimer) clearTimeout(originalTimer); if (output) closeHostedForegroundRequest(output); stopWatch(); signals.forEach((signal, index) => process.off(signal, handlers[index]!)); };
    child.stdin!.on("error", () => { failed = true; close(); stopProxy("SIGTERM"); });
    child.once("error", () => { failed = true; close(); detach(); resolve(70); });
    child.once(fdProfile ? "close" : "exit", (code, signal) => {
      let result: HostedForegroundResult | undefined;
      let actualFacts:HostedForegroundResult|undefined;
      if (!failed && signal === null && code !== null && (code === 0 || output)) {
        try {
          if (code === 0) store.recordOrdinaryRuntimeWaitCompletion();
          if (output) {
            const guard = hostedFdLaunch(child);
            const facts = guard.foregroundResult();actualFacts=facts;
            result = store.withOrdinaryForegroundTerminal(facts, owner => publishHostedForegroundResult(output, facts, owner));
          }
        } catch { failed = true; }
        let legacyRelease=true;
        if (!failed && actualFacts) {
          try {legacyRelease=!store.completeOrdinaryDependencyReader(actualFacts);}
          catch {legacyRelease=false;try {store.requestOrdinaryDependencyCleanup();} catch { /* Exact owner/recovery stays held. */ }}
        }
        if (!failed && code === 0 && legacyRelease) {
          try { store.releaseOrdinaryDependencyConsumer(); }
          catch {
            // A successful job remains successful. Durable owner/intent stay
            // held; cleanup uncertainty must not rewrite its completed result.
            if (!fdProfile) process.stderr.write("dependency_cleanup_unresolved\n");
            try { store.requestOrdinaryDependencyCleanup(); } catch { /* Recovery stays held. */ }
          }
        }
      }
      if (failed || signal !== null || code !== 0) close();
      detach(); resolve(result && result.exitCode !== 0 && signal === null ? result : failed || signal !== null ? 70 : result ?? code ?? 70);
    });
    const budget = store.ordinaryChildBudget();
    if (budget) stopWatch = watchChildDeadline(budget, () => {
      failed = true; close(); stopProxy("SIGTERM");
    });
    if (fdProfile) {
      const guard = hostedFdLaunch(child);
      void guard.observe().then(() => retryHostedFenceAcquisition(() =>
        store.releaseOrdinaryRuntimeFrame((fence, revalidate) => {
          store.assertOrdinaryDependencyFrameWithHeldFence(fence,frame);
          if (output) recheckHostedForegroundRequest(output, fence);
          guard.release(fence, frame, true, () => { revalidate(); if (output) recheckHostedForegroundRequest(output, fence); });
        }), guard.remainingSetupMs()))
        .catch(() => { failed = true; guard.invalidate(); close(); stopProxy("SIGTERM"); });
    }
  });
}

/** Fixed service bootstrap: only environment crosses stdin; command/args/cwd
 * come from the private actual-process origin and independently pinned inventory. */
export async function runHostedOrdinaryBootstrap(): Promise<number> {
  const fdProfile = readHostedFdProfile(), began = process.hrtime.bigint();
  withHostedActivationFence(fence=>assertHostedOrdinaryDependencyBootstrap(fence));
  const stopPrelude = fdProfile ? announceHostedFdPrelude() : () => {};
  const readBudget = () => withHostedActivationFence(fence => {
    const slot = readHostedChildSlot(readHostedOrdinaryRuntime(fence).creator);
    if (!slot) return undefined;
    const budget = new ChildExecutionBudget(slot.lifetime); budget.remainingMs(); return budget;
  });
  let budget = fdProfile ? undefined : readBudget();
  let stopInputWatch = () => {};
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let bytes = Buffer.alloc(0), failed = false;
    process.stdin.on("data", (chunk: Buffer) => {
      if (failed) return;
      if (bytes.length + chunk.length > 4 * 1024 * 1024) {
        failed = true; process.stdin.destroy(); reject(new Error("hosted_custody_launch_frame_invalid")); return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    process.stdin.once("end", () => { if (!failed) resolve(bytes); });
    process.stdin.once("error", reject);
    if (budget) stopInputWatch = watchChildDeadline(budget, error => {
      failed = true; process.stdin.destroy(); reject(error);
    });
  }).finally(() => { stopInputWatch(); stopPrelude(); });
  const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
      Object.keys(frame).sort().join(",") !== "env,schemaVersion" ||
      !("schemaVersion" in frame) || frame.schemaVersion !== 1 || !("env" in frame) ||
      !frame.env || typeof frame.env !== "object" || Array.isArray(frame.env) ||
      !Object.entries(frame.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        typeof value === "string" && !value.includes("\0"))) throw new Error("hosted_custody_launch_frame_invalid");
  const submit = () => withHostedActivationFence(fence => {
    const { launch, creator, start, reservation, installation } = readHostedOrdinaryRuntime(fence);
    assertHostedOrdinaryLaunchExtent(fence, start, reservation.startId, installation, launch, frame.env as Record<string, string>);
    assertHostedOrdinaryDependencyToolParentFrame(fence,reservation.startId,bytes);
    if (fdProfile) assertHostedFdFrameEnvironment(frame.env as Record<string, string>);
    if (isHostedDependencyWorkspace(creator.workspacePath)) {
      assertDependencyHostFrameEnvironment(frame.env as Record<string, string>);
    }
    const slot = readHostedChildSlot(creator);
    if (fdProfile && slot) { budget = new ChildExecutionBudget(slot.lifetime); budget.remainingMs(); }
    if (slot) { if (!budget) throw new Error("hosted_child_slot_binding_invalid"); budget.remainingMs(); }
    const child = spawn(launch.command, [...launch.args], { cwd: launch.cwd,
      env: frame.env as Record<string, string>, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(); return child;
  });
  const remaining = fdProfile ? fdProfile.limits.setupTimeoutMs - Number((process.hrtime.bigint() - began) / 1_000_000n) : 0;
  const child = fdProfile ? await retryHostedFenceAcquisition(submit, remaining) : submit();
  return new Promise<number>(resolve => {
    let failed = false;
    let stopWatch = () => {};
    child.stdin.on("error", () => { failed = true; child.kill("SIGTERM"); });
    child.once("error", () => { failed = true; stopWatch(); resolve(70); });
    child.once("exit", (code, signal) => { stopWatch(); resolve(failed || signal !== null ? 70 : code ?? 70); });
    if (budget) stopWatch = watchChildDeadline(budget, () => { failed = true; child.kill("SIGTERM"); });
  });
}
