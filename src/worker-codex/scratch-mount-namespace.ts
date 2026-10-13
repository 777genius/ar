import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { isResearchUnitCgroup } from "../provider-codex/app-server/adapters/node-app-server-process.js";
import { SCRATCH_NAMESPACE_MARKER_ENV, SCRATCH_TEMP_CONFIG_PATH } from "./host-scratch-temp.js";

const UNSHARE_PATH = "/usr/bin/unshare";
const NSENTER_PATH = "/usr/bin/nsenter";
const CAP_SYS_ADMIN_BIT = 21n;

export enum ScratchNamespaceAction {
  None = "none",
  Reexec = "reexec",
  Unavailable = "unavailable",
}

export interface ScratchNamespaceFacts {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly managedLaunch: boolean;
  readonly scratchPolicyPresent: boolean;
  /** Without CAP_SYS_ADMIN (e.g. the Codex sandbox) unshare cannot work and no bind can be made either. */
  readonly mountCapability: boolean;
  /** Research units already own a private namespace (MountFlags=private). */
  readonly researchUnit: boolean;
  /** The marker names this very process: it already re-executed into its own namespace. */
  readonly ownsNamespace: boolean;
  readonly execveAvailable: boolean;
  readonly unshareAvailable: boolean;
}

/** Every runner gets its OWN namespace. The decision never depends on PID 1's namespace: a process
 * that inherited another runner's namespace (tmux server, MCP child) must still re-exec, otherwise
 * its binds would pile up in a long-lived shared namespace that host GC cannot see.
 * Cannot-bind cases degrade to None; the guard in bindTarget still refuses fail-closed. */
export function scratchNamespaceAction(facts: ScratchNamespaceFacts): ScratchNamespaceAction {
  if (facts.platform !== "linux" || facts.uid !== 0 || facts.managedLaunch || !facts.scratchPolicyPresent ||
      !facts.mountCapability || facts.researchUnit || facts.ownsNamespace) return ScratchNamespaceAction.None;
  return facts.execveAvailable && facts.unshareAvailable ? ScratchNamespaceAction.Reexec : ScratchNamespaceAction.Unavailable;
}

/** Same PID, fds and signals: no `--fork`. Slave propagation keeps host unmounts flowing in
 * while runner mounts never propagate out. */
export function scratchUnshareInvocation(execPath: string, execArgv: readonly string[], argv: readonly string[]): readonly string[] {
  return ["unshare", "--mount", "--propagation", "slave", "--", execPath, ...execArgv, ...argv.slice(1)];
}

/** Help and version output never binds anything, so it must not need namespace privileges. */
export function isScratchHelpInvocation(args: readonly string[]): boolean {
  return args.length === 0 || ["help", "--help", "-h", "--version", "-v"].includes(args[0]!);
}

export interface ScratchNamespaceHost {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  scratchPolicyPresent(): boolean;
  mountCapability(): boolean;
  researchUnit(): boolean;
  unshareAvailable(): boolean;
  nsenterAvailable(): boolean;
  execve?: ((file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never) | undefined;
}

const unreadable = (error: unknown) => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
const systemHost: ScratchNamespaceHost = {
  platform: process.platform,
  uid: process.getuid?.(),
  pid: process.pid,
  env: process.env,
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  scratchPolicyPresent() {
    try { lstatSync(SCRATCH_TEMP_CONFIG_PATH); return true; }
    catch (error) {
      // A masked policy (Codex sandbox) is not readable here either: nothing to prepare.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || unreadable(error)) return false;
      throw error;
    }
  },
  mountCapability() {
    try {
      const effective = /^CapEff:\s+([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
      return effective !== undefined && ((BigInt(`0x${effective}`) >> CAP_SYS_ADMIN_BIT) & 1n) === 1n;
    } catch { return false; }
  },
  researchUnit: () => isResearchUnitCgroup(readFileSync("/proc/self/cgroup", "utf8")),
  unshareAvailable: () => executable(UNSHARE_PATH),
  nsenterAvailable: () => executable(NSENTER_PATH),
  execve: process.execve?.bind(process),
};

/** Call first in every goal-runner entry point, before reading stdin or starting work (skip help).
 * Re-executes the runner in its own mount namespace so per-session scratch binds vanish
 * with the process instead of accumulating in a shared namespace. Returns when no action is needed. */
export function enterScratchPrivateMountNamespace(host: ScratchNamespaceHost = systemHost): void {
  const managedLaunch = host.env.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH === "1";
  // Cheap checks first: hosts without a scratch policy never touch /proc.
  if (host.platform !== "linux" || host.uid !== 0 || managedLaunch || !host.scratchPolicyPresent()) return;
  const action = scratchNamespaceAction({
    platform: host.platform, uid: host.uid, managedLaunch, scratchPolicyPresent: true,
    mountCapability: host.mountCapability(), researchUnit: host.researchUnit(),
    ownsNamespace: host.env[SCRATCH_NAMESPACE_MARKER_ENV] === String(host.pid),
    execveAvailable: host.execve !== undefined, unshareAvailable: host.unshareAvailable(),
  });
  if (action === ScratchNamespaceAction.None) return;
  // A failed execve aborts Node (exit 134), so every precondition is checked before it.
  if (action === ScratchNamespaceAction.Unavailable || !host.execve) throw new Error("scratch_private_namespace_unavailable");
  host.execve(UNSHARE_PATH, scratchUnshareInvocation(host.execPath, host.execArgv, host.argv),
    { ...host.env, [SCRATCH_NAMESPACE_MARKER_ENV]: String(host.pid) });
}

/** Long-lived shared daemons (the tmux server) must start in the host namespace: they would
 * otherwise inherit the runner's namespace, trap operator sessions in it and make every pane share it. */
export function hostNamespaceInvocation(command: string, args: readonly string[], host: ScratchNamespaceHost = systemHost):
    { readonly command: string; readonly args: readonly string[] } {
  const inRunnerNamespace = host.platform === "linux" && host.uid === 0 && host.env[SCRATCH_NAMESPACE_MARKER_ENV] !== undefined &&
    host.mountCapability();
  if (!inRunnerNamespace) return { command, args };
  if (!host.nsenterAvailable()) throw new Error("scratch_host_namespace_launch_unavailable");
  return { command: NSENTER_PATH, args: ["--mount=/proc/1/ns/mnt", "--", command, ...args] };
}

type TmuxExec = (command: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => Promise<unknown>;

/** Starts tmux for a new goal session in the host namespace. The runner marker is not passed on:
 * it names this process only, and a stale PID left in the long-lived server's global environment
 * could later equal a pane runner's PID and make it skip its own re-exec. */
export async function launchTmuxInHostNamespace(tmuxExecutable: string, args: readonly string[], exec: TmuxExec,
    host: ScratchNamespaceHost = systemHost): Promise<void> {
  const invocation = hostNamespaceInvocation(tmuxExecutable, args, host);
  const { [SCRATCH_NAMESPACE_MARKER_ENV]: _marker, ...env } = host.env;
  await exec(invocation.command, invocation.args, { env });
}
