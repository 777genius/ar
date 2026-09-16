import { HostedReadonlyRuntimeRole } from "./hosted-readonly-host-kernel";
import { spawn } from "node:child_process";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { requiresHostedProcessAdmission, withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { HostedInstallationActivationStore, readHostedInstallationActivation, isHostedOrdinaryRuntime, readHostedOrdinaryRuntime } from "./hosted-installation-activation";

/** Exact root-inventory command, foreground service lifetime. The caller never
 * supplies a host implementation or a completion receipt. */
export async function runHostedReadonlyForeground(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const host = new HostedReadonlySupervisorHost();
  const frame = Buffer.from(JSON.stringify({ schemaVersion: 1, env }));
  if (frame.length > 4 * 1024 * 1024) throw new Error("hosted_custody_launch_frame_invalid");
  const child = host.runRuntimeLaunch(command, args, cwd, launch => {
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(frame);
    return child;
  });
  return await new Promise<number>((resolve) => {
    let failed = false;
    const close = () => {
      try { host.closeRuntimeLaunch(); }
      catch { failed = true; }
    };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const handlers = signals.map(signal => {
      const handler = () => { failed = true; close(); child.kill(signal); };
      process.on(signal, handler);
      return handler;
    });
    const detach = () => signals.forEach((signal, index) => process.off(signal, handlers[index]!));
    child.stdin.on("error", () => { failed = true; close(); child.kill("SIGTERM"); });
    child.once("error", () => { failed = true; close(); detach(); resolve(70); });
    child.once("exit", (code, signal) => {
      if (!failed && code === 0 && signal === null) {
        try { host.recordRuntimeWaitCompletion(); } catch { failed = true; }
      }
      close(); detach();
      resolve(failed || signal !== null ? 70 : code ?? 70);
    });
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
    return runHostedRuntimeForeground(process.execPath, args, process.cwd(), process.env);
  }
  const host = new HostedReadonlySupervisorHost();
  if (host.runtimeRole() === HostedReadonlyRuntimeRole.Runtime) return undefined;
  return await runHostedRuntimeForeground(process.execPath, args, process.cwd(), process.env);
}

/** Both dispatch paths use this artifact and the installed activation record.
 * Selecting ORDINARY is not admission: the store then binds the exact inventoried
 * command and persists its start under the same lock as synchronous submission. */
export async function runHostedRuntimeForeground(command: string, args: readonly string[], cwd: string,
  env: Readonly<Record<string, string | undefined>>): Promise<number> {
  if (readHostedInstallationActivation().activation.phase !== HostedActivationPhase.Ordinary) {
    return runHostedReadonlyForeground(command, args, cwd, env);
  }
  const store = new HostedInstallationActivationStore();
  const frame = Buffer.from(JSON.stringify({ schemaVersion: 1, env }));
  if (frame.length > 4 * 1024 * 1024) throw new Error("hosted_custody_launch_frame_invalid");
  const child = store.runOrdinaryRuntimeLaunch(command, args, cwd, launch => {
    const child = spawn(launch.command, [...launch.args], { cwd, env, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(frame);
    return child;
  });
  return new Promise<number>(resolve => {
    let failed = false;
    const close = () => { try { store.closeOrdinaryRuntimeLaunch(); } catch { failed = true; } };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const handlers = signals.map(signal => {
      const handler = () => { failed = true; close(); child.kill(signal); };
      process.on(signal, handler); return handler;
    });
    const detach = () => signals.forEach((signal, index) => process.off(signal, handlers[index]!));
    child.stdin.on("error", () => { failed = true; close(); child.kill("SIGTERM"); });
    child.once("error", () => { failed = true; close(); detach(); resolve(70); });
    child.once("exit", (code, signal) => {
      if (!failed && code === 0 && signal === null) {
        try { store.recordOrdinaryRuntimeWaitCompletion(); } catch { failed = true; }
      }
      if (failed || signal !== null || code !== 0) close();
      detach(); resolve(failed || signal !== null ? 70 : code ?? 70);
    });
  });
}

/** Fixed service bootstrap: only environment crosses stdin; command/args/cwd
 * come from the private actual-process origin and independently pinned inventory. */
export async function runHostedOrdinaryBootstrap(): Promise<number> {
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
  });
  const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
      Object.keys(frame).sort().join(",") !== "env,schemaVersion" ||
      !("schemaVersion" in frame) || frame.schemaVersion !== 1 || !("env" in frame) ||
      !frame.env || typeof frame.env !== "object" || Array.isArray(frame.env) ||
      !Object.entries(frame.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        typeof value === "string" && !value.includes("\0"))) throw new Error("hosted_custody_launch_frame_invalid");
  const child = withHostedActivationFence(fence => {
    const { launch } = readHostedOrdinaryRuntime(fence);
    const child = spawn(launch.command, [...launch.args], { cwd: launch.cwd,
      env: frame.env as Record<string, string>, stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.end(); return child;
  });
  return new Promise<number>(resolve => {
    let failed = false;
    child.stdin.on("error", () => { failed = true; child.kill("SIGTERM"); });
    child.once("error", () => { failed = true; resolve(70); });
    child.once("exit", (code, signal) => resolve(failed || signal !== null ? 70 : code ?? 70));
  });
}
