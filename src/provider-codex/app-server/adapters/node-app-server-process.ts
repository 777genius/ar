import { hostedDependencyProviderInvocation } from "./hosted-dependency-provider-launch";
import type { DependencyToolReadyReader } from "../../../core/dependency-environment/dependency-tool-ready-reader";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "../application/app-server-process-port";
import { requiresHostedProcessAdmission, submitHostedOrdinaryProcess, invalidateHostedOrdinaryWait, releaseHostedOrdinaryProcess,
  type HostedActivationFence } from "./hosted-process-activation";
import { readHostedFdProfile } from "./hosted-fd-observation";
import { spawnHostedFdChild, hostedFdLaunch, HostedFdLaunchKind } from "./hosted-fd-launch";
import { retryHostedFenceAcquisition } from "./hosted-fd-fence";
import { abandonHostedDependencyToolInvocation, bindHostedDependencyToolChild } from "./hosted-dependency-tool-plan";
import { encodeHostedAppServerLaunchFrame } from "./hosted-app-server-launch-frame";
import { hostedReadonlyMountProperties, type HostedReadonlyMounts } from "./hosted-readonly-mounts";
import { codexProviderEgressProfileEnvVar, CodexProviderEgressProfileId } from "../../codex-provider-egress-policy";
import { assertHostedBaselineIdentity, isHostedContainment } from "./hosted-host-policy";

const hostedSandboxKind = "hosted-codex-job";
const managedLauncherNodePath = process.execPath;
const managedLauncherPath = "/opt/subscription-runtime/managed-launcher/launch.mjs";
const systemctlPath = "/usr/bin/systemctl";
const hostedLauncherPath = fileURLToPath(
  new URL("./hosted-app-server-launcher.js", import.meta.url),
);
const hostedSystemdUnits = new WeakMap<CodexAppServerChildProcess, string>();
const researchSignals = new WeakMap<CodexAppServerChildProcess, (signal: NodeJS.Signals) => void>();
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
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly systemdUnit?: string;
}, admittedMounts?: HostedReadonlyMounts): CodexAppServerProcessInvocation {
  if (
    (input.platform ?? process.platform) !== "linux" ||
    (input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== hostedSandboxKind && !isHostedContainment(input.env))
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
  const providerUuid = /^subscription-runtime-hosted-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.service$/.exec(systemdUnit)?.[1];
  const jobId = admittedMounts ? admittedMounts.jobId :
    input.env.SUBSCRIPTION_RUNTIME_JOB_ID ?? (providerUuid ? `provider-${providerUuid}` : undefined);
  if (typeof jobId !== "string" || jobId !== jobId.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) {
    throw new Error("hosted_managed_job_identity_required");
  }
  return {
    command: managedLauncherNodePath,
    systemdUnit,
    stdinBootstrap: encodeHostedAppServerLaunchFrame({
      schemaVersion: 1,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: { ...input.env, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: hostedSandboxKind, SUBSCRIPTION_RUNTIME_JOB_ID: jobId },
    }),
    args: [
      managedLauncherPath,
      "provider",
      JSON.stringify({ operation: "provider", jobId, unit: systemdUnit,
        payload: [input.nodePath ?? process.execPath, input.hostedLauncher ?? hostedLauncherPath],
        ...(admittedMounts ? { readonlyPaths: admittedMounts.readonlyPaths } : {}),
      }),
    ],
  };
}

export function spawnCodexAppServerProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}, admittedMounts?: HostedReadonlyMounts, reservedSystemdUnit?: string, submission?: object): CodexAppServerChildProcess {
  const contained = isHostedContainment(input.env);
  if (contained &&
      input.env[codexProviderEgressProfileEnvVar] === CodexProviderEgressProfileId.MimoTokenPlan) {
    throw new Error("hosted_mimo_activation_closed");
  }
  if (submission && !hostedSubmissions.has(submission)) throw new Error("hosted_custody_synchronous_fence_required");
  if (!submission && requiresHostedProcessAdmission(input.env)) {
    if (admittedMounts || reservedSystemdUnit) throw new Error("hosted_custody_synchronous_fence_required");
    return submitHostedOrdinaryProcess(input, (unit, identity, fence) => spawnInvocation(input,
      hostedDependencyProviderInvocation(fence, unit, input) ??
      codexAppServerProcessInvocation({ ...input, env: { ...input.env,
        SUBSCRIPTION_RUNTIME_JOB_ID: identity.jobId }, systemdUnit: unit }),
      (child, release) => releaseHostedOrdinaryProcess(child, release)));
  }
  const invocation = codexAppServerProcessInvocation({
    command: input.command, args: input.args, cwd: input.cwd, env: input.env,
    ...(reservedSystemdUnit ? { systemdUnit: reservedSystemdUnit } : {}),
  }, admittedMounts);
  if (invocation.systemdUnit !== undefined) {
    if (submission) {
      if (!hostedSubmissions.delete(submission)) throw new Error("hosted_custody_synchronous_fence_required");
    } else {
      if (admittedMounts || reservedSystemdUnit) throw new Error("hosted_custody_synchronous_fence_required");
      const frame = JSON.parse(invocation.stdinBootstrap!) as { env: Record<string, string> };
      if (input.env[codexProviderEgressProfileEnvVar] !== undefined &&
          ![CodexProviderEgressProfileId.ProviderApi, CodexProviderEgressProfileId.FullInternetV1]
            .includes(input.env[codexProviderEgressProfileEnvVar] as CodexProviderEgressProfileId)) {
        throw new Error("hosted_activation_authority_required");
      }
      assertHostedBaselineIdentity(frame.env.SUBSCRIPTION_RUNTIME_JOB_ID!);
    }
  } else if (process.platform === "linux" && process.getuid?.() === 0 && !submission) {
    // An interrupted installation is authority even before a per-job origin
    // exists. Unmarked native jobs retain their layout only on unenrolled Hosts.
    assertHostedBaselineIdentity(input.env.SUBSCRIPTION_RUNTIME_JOB_ID);
  }
  return spawnInvocation(input, invocation);
}

/** Trusted worker composition captures established Ready history. The worker
 * executor separately brands this exact returned factory; accepting this port
 * as a public caller option is never sufficient for v2 admission. */
export function admittedDependencyToolCodexProcessFactory(readyReader: DependencyToolReadyReader): CodexAppServerProcessFactory {
  return input => submitHostedOrdinaryProcess(input, (unit, _identity, fence) => {
    const invocation = hostedDependencyProviderInvocation(fence, unit, input, readyReader);
    if (!invocation) throw new Error("hosted_dependency_tool_binding_required");
    return spawnInvocation(input, invocation, (child, release) => releaseHostedOrdinaryProcess(child, release));
  });
}

function spawnInvocation(input: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  invocation: CodexAppServerProcessInvocation,
  finalRelease?: (child: CodexAppServerChildProcess, release: (fence: HostedActivationFence, revalidate: () => void) => void) => void): CodexAppServerChildProcess {
  const fdProfile = invocation.systemdUnit && finalRelease ? readHostedFdProfile() : undefined;
  if (fdProfile) {
    if (!finalRelease || !invocation.systemdUnit || invocation.stdinBootstrap === undefined) {
      throw new Error("hosted_fd_final_authority_required");
    }
    let args = invocation.args;
    if (invocation.command === process.execPath && args[0] === managedLauncherPath) {
      const request = JSON.parse(args[2]!) as { payload: string[] };
      request.payload = [...request.payload, "--fd-ready-v1"];
      args = [args[0]!, args[1]!, JSON.stringify(request)];
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnHostedFdChild(invocation.command, args, { cwd: input.cwd, detached: process.platform !== "win32" },
        invocation.systemdUnit, HostedFdLaunchKind.Provider) as ChildProcessWithoutNullStreams;
      bindHostedDependencyToolChild(invocation, child);
    } catch (error) { abandonHostedDependencyToolInvocation(invocation); throw error; }
    hostedSystemdUnits.set(child, invocation.systemdUnit);
    const guard = hostedFdLaunch(child);
    void guard.observe().then(() => retryHostedFenceAcquisition(() =>
      finalRelease(child, (fence, revalidate) => guard.release(fence, invocation.stdinBootstrap!, false, revalidate)), guard.remainingSetupMs()))
      .catch(() => { guard.invalidate(); invalidateHostedOrdinaryWait(child); signalCodexAppServerChildGroup(child, "SIGTERM"); });
    return child;
  }
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
  finalRelease?: (unit: string, child: CodexAppServerChildProcess, release: (fence: HostedActivationFence, revalidate: () => void) => void) => void,
): CodexAppServerProcessFactory {
  hostedReadonlyMountProperties(policy);
  const mounts = Object.freeze({
    jobId: policy.jobId,
    workspacePath: policy.workspacePath,
    readonlyPaths: Object.freeze([...policy.readonlyPaths]),
  });
  return input => {
    if (!submitSystemdUnit) throw new Error("hosted_custody_synchronous_fence_required");
    const unit = `subscription-runtime-hosted-${randomUUID()}.service`;
    const ticket = {};
    const submit = () => {
      if (!readHostedFdProfile()) return spawnCodexAppServerProcess(input, mounts, unit, ticket);
      if (!finalRelease || !hostedSubmissions.delete(ticket)) throw new Error("hosted_fd_final_authority_required");
      const invocation = codexAppServerProcessInvocation({ ...input, systemdUnit: unit }, mounts);
      return spawnInvocation(input, invocation, (child, release) => finalRelease(unit, child, release));
    };
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

/** Worker-owned research admission supplies the immutable installed launcher and
 * synchronous authority recheck. No environment marker selects this route. */
export function admittedResearchCodexProcessFactory(input: {
  readonly jobId: string;
  readonly launcherPath: string;
  readonly submit: (unit: string, effect: () => CodexAppServerChildProcess) => CodexAppServerChildProcess;
  readonly signal: (unit: string, signal: NodeJS.Signals) => void;
}): CodexAppServerProcessFactory {
  return launch => {
    const unit = `subscription-runtime-research-provider-${randomUUID()}.service`;
    return input.submit(unit, () => {
      const child = spawnInvocation(launch, { command: process.execPath,
        args: [input.launcherPath, input.jobId, unit, launch.env.CODEX_HOME!],
        stdinBootstrap: encodeHostedAppServerLaunchFrame({ schemaVersion: 1, ...launch, args: [...launch.args] }),
      });
      researchSignals.set(child, signal => input.signal(unit, signal));
      return child;
    });
  };
}

export function signalCodexAppServerChildGroup(
  child: CodexAppServerChildProcess,
  signal: NodeJS.Signals,
): void {
  invalidateHostedOrdinaryWait(child);
  const researchSignal = researchSignals.get(child);
  if (researchSignal) { researchSignal(signal); return; }
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
