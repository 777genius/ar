import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "../application/app-server-process-port";
import { requiresHostedProcessAdmission, submitHostedOrdinaryProcess, invalidateHostedOrdinaryWait } from "./hosted-process-activation";
import { encodeHostedAppServerLaunchFrame } from "./hosted-app-server-launch-frame";
import { hostedReadonlyMountProperties, type HostedReadonlyMounts } from "./hosted-readonly-mounts";
import {
  hostedAppServerSystemdProperties,
  hostedIoLimitPaths,
} from "./hosted-app-server-resource-policy";

const hostedSandboxKind = "hosted-codex-job";
const systemdRunPath = "/usr/bin/systemd-run";
const systemctlPath = "/usr/bin/systemctl";
const unsharePath = "/usr/bin/unshare";
const setprivPath = "/usr/bin/setpriv";
// Namespace-local identity, deliberately distinct from Linux's overflow ID 65534.
// The host UID/GID and ownership of workspaces/auth files are not changed.
const hostedNamespaceIdentity = "65532";
const hostedLauncherPath = fileURLToPath(
  new URL("./hosted-app-server-launcher.js", import.meta.url),
);
const hostedSystemdUnits = new WeakMap<CodexAppServerChildProcess, string>();
// A synchronous host-fence callback may submit one exact service, only while
// that callback is active. Launch arguments cannot supply or retain this ticket.
const hostedSubmissions = new WeakSet<object>();

export type HostedSystemctlResult = {
  readonly status: number | null;
  readonly error?: Error;
};

export type HostedSystemctlRunner = (
  args: readonly string[],
) => HostedSystemctlResult;

export function signalHostedSystemdUnit(
  systemdUnit: string,
  signal: NodeJS.Signals,
  run: HostedSystemctlRunner = (args) =>
    spawnSync(systemctlPath, args, {
      stdio: "ignore",
      timeout: 5_000,
    }),
): "stopping" | "inactive" | "bounded" {
  const killResult = run([
    "kill",
    `--signal=${signal}`,
    "--kill-whom=all",
    systemdUnit,
  ]);
  const stopResult = run(["stop", "--no-block", systemdUnit]);
  if (
    (killResult.status === 0 && killResult.error === undefined) ||
    (stopResult.status === 0 && stopResult.error === undefined)
  ) {
    return "stopping";
  }
  const activeResult = run(["is-active", "--quiet", systemdUnit]);
  if (
    activeResult.error === undefined &&
    (activeResult.status === 3 || activeResult.status === 4)
  ) {
    return "inactive";
  }

  run([
    "kill",
    "--signal=SIGKILL",
    "--kill-whom=all",
    systemdUnit,
  ]);
  run(["stop", "--no-block", systemdUnit]);
  const finalActiveResult = run(["is-active", "--quiet", systemdUnit]);
  return finalActiveResult.error === undefined &&
      (finalActiveResult.status === 3 || finalActiveResult.status === 4)
    ? "stopping"
    : "bounded";
}

export type CodexAppServerProcessInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdinBootstrap?: string;
  readonly systemdUnit?: string;
};

export function codexAppServerProcessInvocation(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly hostedLauncher?: string;
  readonly ioLimitPaths?: readonly string[];
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly systemdUnit?: string;
}, admittedMounts?: HostedReadonlyMounts): CodexAppServerProcessInvocation {
  if (
    (input.platform ?? process.platform) !== "linux" ||
    input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== hostedSandboxKind
  ) {
    if (admittedMounts) throw new Error("hosted_readonly_engine_unsupported");
    return { command: input.command, args: input.args };
  }
  // Detached provider units need persisted ownership before host jobs can own them.
  if (input.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID !== undefined) {
    throw new Error("host-job detached provider ownership is not supported");
  }
  const systemdUnit =
    input.systemdUnit ?? `subscription-runtime-hosted-${randomUUID()}.service`;
  const properties = hostedAppServerSystemdProperties(
    input.ioLimitPaths ?? hostedIoLimitPaths(),
  );
  return {
    command: systemdRunPath,
    systemdUnit,
    stdinBootstrap: encodeHostedAppServerLaunchFrame({
      schemaVersion: 1,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
    }),
    args: [
      `--unit=${systemdUnit}`,
      "--pipe",
      "--wait",
      "--collect",
      "--quiet",
      "--service-type=exec",
      "--slice=subscription-runtime-hosted.slice",
      ...properties.map((property) => `--property=${property}`),
      ...(admittedMounts ? hostedReadonlyMountProperties(admittedMounts)
        .map(property => `--property=${property}`) : []),
      "--",
      unsharePath,
      `--map-user=${hostedNamespaceIdentity}`,
      `--map-group=${hostedNamespaceIdentity}`,
      // Only the trusted setpriv bootstrap retains namespace capabilities; it
      // drops every set before Node/Codex runs. A capability-less UID 0 cannot
      // create the nested user namespace required by bubblewrap on Linux 5.12+.
      "--keep-caps",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      setprivPath,
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--no-new-privs",
      input.nodePath ?? process.execPath,
      input.hostedLauncher ?? hostedLauncherPath,
    ],
  };
}

export function spawnCodexAppServerProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}, admittedMounts?: HostedReadonlyMounts, reservedSystemdUnit?: string, submission?: object): CodexAppServerChildProcess {
  if (submission && !hostedSubmissions.has(submission)) throw new Error("hosted_custody_synchronous_fence_required");
  if (!submission && requiresHostedProcessAdmission(input.env)) {
    if (admittedMounts || reservedSystemdUnit) throw new Error("hosted_custody_synchronous_fence_required");
    return submitHostedOrdinaryProcess(input, unit => spawnInvocation(input,
      codexAppServerProcessInvocation({ ...input, systemdUnit: unit })));
  }
  const invocation = codexAppServerProcessInvocation({
    command: input.command, args: input.args, cwd: input.cwd, env: input.env,
    ...(reservedSystemdUnit ? { systemdUnit: reservedSystemdUnit } : {}),
  }, admittedMounts);
  if (invocation.systemdUnit !== undefined && (!submission || !hostedSubmissions.delete(submission))) {
    throw new Error("hosted_custody_synchronous_fence_required");
  }
  return spawnInvocation(input, invocation);
}

function spawnInvocation(input: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  invocation: CodexAppServerProcessInvocation): CodexAppServerChildProcess {
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  if (invocation.systemdUnit !== undefined) {
    hostedSystemdUnits.set(child, invocation.systemdUnit);
  }
  if (invocation.stdinBootstrap !== undefined) {
    child.stdin.write(invocation.stdinBootstrap);
  }
  return child;
}

/** Admission and per-spawn custody checks belong to the worker-owned closure. */
export function admittedReadonlyCodexProcessFactory(
  policy: HostedReadonlyMounts,
  submitSystemdUnit?: (unit: string, submit: () => CodexAppServerChildProcess) => CodexAppServerChildProcess,
): CodexAppServerProcessFactory {
  hostedReadonlyMountProperties(policy);
  const mounts = Object.freeze({
    workspacePath: policy.workspacePath,
    readonlyPaths: Object.freeze([...policy.readonlyPaths]),
  });
  return input => {
    if (!submitSystemdUnit) throw new Error("hosted_custody_synchronous_fence_required");
    const unit = `subscription-runtime-hosted-${randomUUID()}.service`;
    const ticket = {};
    const submit = () => spawnCodexAppServerProcess(input, mounts, unit, ticket);
    hostedSubmissions.add(ticket);
    try { return submitSystemdUnit(unit, submit); }
    finally { hostedSubmissions.delete(ticket); }
  };
}

export type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
};

export function signalCodexAppServerChildGroup(
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
): void {
  invalidateHostedOrdinaryWait(child);
  try {
    const systemdUnit = hostedSystemdUnits.get(child);
    if (systemdUnit !== undefined) {
      signalHostedSystemdUnit(systemdUnit, signal);
      // Never kill only the systemd-run proxy: the bounded service would leak.
      return;
    }
    if (process.platform === "win32" || !child.pid) {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}
