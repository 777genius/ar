import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { hostedProviderRunsInSeparateUnit } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { SCRATCH_NAMESPACE_MARKER_ENV } from "../host-scratch-temp";
import {
  enterScratchPrivateMountNamespace, hostNamespaceInvocation, isScratchHelpInvocation, launchTmuxInHostNamespace, ScratchNamespaceAction,
  scratchNamespaceAction, scratchUnshareInvocation, type ScratchNamespaceFacts, type ScratchNamespaceHost,
} from "../scratch-mount-namespace";

const ready: ScratchNamespaceFacts = {
  platform: "linux", uid: 0, managedLaunch: false, scratchPolicyPresent: true, mountCapability: true,
  researchUnit: false, ownsNamespace: false, execveAvailable: true, unshareAvailable: true,
};

test("scratch namespace decision matrix", () => {
  assert.equal(scratchNamespaceAction(ready), ScratchNamespaceAction.Reexec);
  assert.equal(scratchNamespaceAction({ ...ready, execveAvailable: false }), ScratchNamespaceAction.Unavailable);
  assert.equal(scratchNamespaceAction({ ...ready, unshareAvailable: false }), ScratchNamespaceAction.Unavailable);
  for (const change of [{ ownsNamespace: true }, { platform: "darwin" as const }, { uid: 1000 }, { uid: undefined },
    { managedLaunch: true }, { scratchPolicyPresent: false }, { mountCapability: false }, { researchUnit: true }]) {
    assert.equal(scratchNamespaceAction({ ...ready, ...change }), ScratchNamespaceAction.None, JSON.stringify(change));
  }
});

test("unshare invocation keeps the PID and runtime arguments with slave propagation", () => {
  assert.deepEqual(scratchUnshareInvocation("/opt/node", ["--flag"], ["/opt/node", "/opt/cli.js", "run", "--x"]),
    ["unshare", "--mount", "--propagation", "slave", "--", "/opt/node", "--flag", "/opt/cli.js", "run", "--x"]);
});

test("help invocations are exempt", () => {
  for (const args of [[], ["help"], ["--help"], ["-h"], ["--version"]]) assert.equal(isScratchHelpInvocation(args), true);
  assert.equal(isScratchHelpInvocation(["run", "--help"]), false);
});

function host(overrides: Partial<ScratchNamespaceHost> = {}) {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const value: ScratchNamespaceHost = {
    platform: "linux", uid: 0, pid: 4242, env: { PATH: "/usr/bin" }, execPath: "/opt/node", execArgv: ["--flag"],
    argv: ["/opt/node", "/opt/cli.js", "run"],
    scratchPolicyPresent: () => true, mountCapability: () => true, researchUnit: () => false,
    unshareAvailable: () => true, nsenterAvailable: () => true,
    execve: (file, args, env) => { calls.push({ file, args, env }); throw new Error("TEST execve reached"); },
    ...overrides,
  };
  return { value, calls };
}

// Guard: every runner re-executes into its OWN namespace and marks it with its PID.
test("a fresh runner re-executes unshare and marks its own namespace", () => {
  const h = host();
  assert.throws(() => enterScratchPrivateMountNamespace(h.value), /TEST execve reached/);
  assert.equal(h.calls[0]!.file, "/usr/bin/unshare");
  assert.deepEqual(h.calls[0]!.args, ["unshare", "--mount", "--propagation", "slave", "--", "/opt/node", "--flag", "/opt/cli.js", "run"]);
  assert.deepEqual(h.calls[0]!.env, { PATH: "/usr/bin", [SCRATCH_NAMESPACE_MARKER_ENV]: "4242" });
});

// Guard: a child that inherited ANOTHER runner's namespace (tmux server pane, MCP child) must not reuse it.
test("a process that inherited another runner's namespace re-executes into its own", () => {
  const h = host({ env: { PATH: "/usr/bin", [SCRATCH_NAMESPACE_MARKER_ENV]: "1111" } });
  assert.throws(() => enterScratchPrivateMountNamespace(h.value), /TEST execve reached/);
  assert.equal(h.calls[0]!.env[SCRATCH_NAMESPACE_MARKER_ENV], "4242");
});

test("the runner that already owns its namespace does not re-execute (no loop)", () => {
  const h = host({ env: { [SCRATCH_NAMESPACE_MARKER_ENV]: "4242" } });
  enterScratchPrivateMountNamespace(h.value);
  assert.equal(h.calls.length, 0);
});

test("missing execve or unshare fails with the typed error before any exec", () => {
  assert.throws(() => enterScratchPrivateMountNamespace(host({ execve: undefined }).value), /scratch_private_namespace_unavailable/);
  const missing = host({ unshareAvailable: () => false });
  assert.throws(() => enterScratchPrivateMountNamespace(missing.value), /scratch_private_namespace_unavailable/);
  assert.equal(missing.calls.length, 0);
});

test("sandboxes, research units, managed launches and plain hosts degrade without error or exec", () => {
  const unread = () => { throw new Error("TEST must not be consulted"); };
  for (const overrides of [
    { scratchPolicyPresent: () => false, mountCapability: unread, researchUnit: unread },
    { platform: "darwin" as const, scratchPolicyPresent: unread },
    { uid: 1000, scratchPolicyPresent: unread },
    { env: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, scratchPolicyPresent: unread },
    { mountCapability: () => false },
    { researchUnit: () => true },
  ]) {
    const h = host(overrides);
    enterScratchPrivateMountNamespace(h.value);
    assert.equal(h.calls.length, 0);
  }
});

test("the tmux server is started in the host namespace from inside a runner namespace", () => {
  const inside = host({ env: { [SCRATCH_NAMESPACE_MARKER_ENV]: "4242" } }).value;
  assert.deepEqual(hostNamespaceInvocation("/usr/bin/tmux", ["new-session", "-d"], inside),
    { command: "/usr/bin/nsenter", args: ["--mount=/proc/1/ns/mnt", "--", "/usr/bin/tmux", "new-session", "-d"] });
  assert.throws(() => hostNamespaceInvocation("/usr/bin/tmux", [], { ...inside, nsenterAvailable: () => false }), /scratch_host_namespace_launch_unavailable/);
  for (const outside of [host().value, { ...inside, mountCapability: () => false }, { ...inside, uid: 1000 }]) {
    assert.deepEqual(hostNamespaceInvocation("/usr/bin/tmux", ["x"], outside), { command: "/usr/bin/tmux", args: ["x"] });
  }
});

test("tmux starts through nsenter without leaking the runner marker into the server environment", async () => {
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec = async (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => { calls.push({ command, args, env: options.env }); };
  const inside = host({ env: { PATH: "/usr/bin", [SCRATCH_NAMESPACE_MARKER_ENV]: "4242" } }).value;
  await launchTmuxInHostNamespace("/usr/bin/tmux", ["new-session", "-d"], exec, inside);
  assert.deepEqual(calls[0], { command: "/usr/bin/nsenter", args: ["--mount=/proc/1/ns/mnt", "--", "/usr/bin/tmux", "new-session", "-d"], env: { PATH: "/usr/bin" } });
  await launchTmuxInHostNamespace("/usr/bin/tmux", ["new-session"], exec, host().value);
  assert.equal(calls[1]!.command, "/usr/bin/tmux");
});

// Binding R3: startCodexGoalTmux must go through the host-namespace launcher, never exec tmux directly.
test("startCodexGoalTmux launches tmux through the host-namespace launcher", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "codex-goal-ops.ts"), "utf8");
  assert.match(source, /await launchTmuxInHostNamespace\(tmuxExecutable, command\.args, execFileAsync\);/);
  assert.doesNotMatch(source, /execFileAsync\(tmuxExecutable/);
});

// Binding G6: the entry points must call the helper first (unit tests cannot import the main modules).
test("goal CLI and MCP main modules enter the private namespace before doing any work", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of ["codex-goal-cli.ts", "codex-goal-mcp.ts"]) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.match(source, /if \(await isMainModule\(\)\) \{\n  (?:if \(!isScratchHelpInvocation\(process\.argv\.slice\(2\)\)\) )?enterScratchPrivateMountNamespace\(\);/, file);
  }
});

test("separate hosted provider unit predicate excludes research units", () => {
  const cgroup = (unit: string) => () => `0::/system.slice/${unit}\n`;
  const kind = { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
  assert.equal(hostedProviderRunsInSeparateUnit(kind, "linux", cgroup("sshd.service")), true);
  assert.equal(hostedProviderRunsInSeparateUnit({}, "linux", cgroup("subscription-runtime-hosted-1.service")), true);
  assert.equal(hostedProviderRunsInSeparateUnit({}, "linux", cgroup("subscription-runtime-outer-1.service")), true);
  assert.equal(hostedProviderRunsInSeparateUnit({}, "linux", cgroup("sshd.service")), false);
  assert.equal(hostedProviderRunsInSeparateUnit(kind, "linux", cgroup("subscription-runtime-research-1.service")), false);
  assert.equal(hostedProviderRunsInSeparateUnit(kind, "darwin", cgroup("subscription-runtime-hosted-1.service")), false);
});
