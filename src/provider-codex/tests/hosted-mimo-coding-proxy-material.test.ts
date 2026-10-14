import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), current: vi.fn(), credential: vi.fn(), start: vi.fn() }));
vi.mock("../hosted-mimo-worker-origin", () => ({ readHostedMimoCodingWorkerOrigin: mocks.read, assertHostedMimoCodingWorkerOriginCurrent: mocks.current }));
vi.mock("../hosted-mimo-credential-source", () => ({ resolveHostedMimoCodingProxyCredential: mocks.credential }));
vi.mock("../hosted-mimo-credential-proxy", () => ({ startMimoCredentialProxy: mocks.start }));
import { createHostedMimoCodingProxyMaterial } from "../hosted-mimo-coding-proxy-material";
import { hostedMimoCodingBootstrapForFrame } from "../hosted-mimo-coding-bootstrap-registry";
import { codexMimoApiKeyEnvVarDefault } from "../codex-model-backend";
import { AppServerExecutionLifetime } from "../app-server/application/app-server-child-lifetime";
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function setup(digest: string, taskTimeoutMs = 60000) {
  const origin = { digest, startId: "12345678-1234-1234-1234-123456789abc", homeRoot: "/job/home", workspacePath: "/workspace", model: "mimo-v2.6-pro", maxGoalTurns: 32, taskTimeoutMs, codexBinaryPath: "/opt/codex" };
  const lifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + taskTimeoutMs - 10000, maxGoalTurns: 32, binding: { allocationId: "TEST", incarnationId: digest } });
  const proxy = { capability: "TEST-cap-" + digest, baseUrl: "http://127.0.0.1:1234/v1", revoke: vi.fn(), close: vi.fn(async () => {}) };
  mocks.read.mockReturnValue(origin); mocks.current.mockImplementation(() => {}); mocks.credential.mockReturnValue("TEST-real-key-never-bootstrap"); mocks.start.mockResolvedValue(proxy);
  const input = { model: origin.model, lifetime, redactor: { registerSecret: vi.fn(), redact: (value: string) => value, assertNoKnownSecret: vi.fn() } };
  return { origin, lifetime, proxy, input };
}
it.each([60000, 1200000, 7200000])("uses MiMo's reasoning/output allowance without outliving the task (%i)", async timeout => {
  const f = setup(`budget-${timeout}`, timeout);
  const material = await createHostedMimoCodingProxyMaterial(f.input);
  try {
    const limits = mocks.start.mock.calls[0]![0].limits;
    expect(limits.maxOutputTokens).toBe(131072);
    expect(limits.deadlineMs).toBe(f.lifetime.deadlineEpochMs);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(timeout - 10000);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(3600000);
    expect(limits.requestTimeoutMs).toBeGreaterThan(Math.min(timeout - 11000, 3599000));
    expect(Number.isSafeInteger(limits.requestTimeoutMs)).toBe(true);
    if (timeout === 7200000) expect(limits.requestTimeoutMs).toBe(3600000);
    const bootstrap = hostedMimoCodingBootstrapForFrame({ command: "/opt/codex", cwd: "/workspace", env: {
      CODEX_HOME: "/job/home/mimo-1/codex-home", [codexMimoApiKeyEnvVarDefault]: f.proxy.capability,
    } })!;
    const provider = bootstrap.configToml.split("[model_providers.mimo]\n")[1]!.split("\n[")[0]!;
    expect(provider.match(/^stream_idle_timeout_ms = (\d+)$/gm)).toEqual([`stream_idle_timeout_ms = ${limits.requestTimeoutMs}`]);
  } finally { await material?.close(); }
});
it("keeps key out of bootstrap, zeroes key bytes, binds executable/workspace and consumes start once", async () => {
  const f = setup("a".repeat(64));
  // The retained monotonic remainder is tighter than the captured epoch cut.
  vi.spyOn(f.lifetime, "remainingMs").mockReturnValue(12345.875);
  const epochRemaining = f.lifetime.deadlineEpochMs - Date.now();
  const material = await createHostedMimoCodingProxyMaterial(f.input);
  try {
    expect(material?.capability).toBe(f.proxy.capability);
    expect(Buffer.from(mocks.start.mock.calls[0]![0].apiKey).every(byte => byte === 0)).toBe(true);
    const frame = { command: "/opt/codex", cwd: "/workspace", env: { CODEX_HOME: "/job/home/mimo-1/codex-home", [codexMimoApiKeyEnvVarDefault]: f.proxy.capability } };
    const bootstrap = hostedMimoCodingBootstrapForFrame(frame)!;
    expect(bootstrap.specSha256).toBe(f.origin.digest); expect(bootstrap.configToml).toContain(f.proxy.baseUrl);
    const limits = mocks.start.mock.calls[0]![0].limits;
    const provider = bootstrap.configToml.split("[model_providers.mimo]\n")[1]!.split("\n[")[0]!;
    expect(provider.match(/^stream_idle_timeout_ms = (\d+)$/gm)).toEqual(["stream_idle_timeout_ms = 12345"]);
    expect(limits.requestTimeoutMs).toBe(12345);
    expect(Number.isSafeInteger(limits.requestTimeoutMs)).toBe(true);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(12345.875);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(epochRemaining);
    expect(limits.deadlineMs).toBe(f.lifetime.deadlineEpochMs);
    expect(limits.requestTimeoutMs).toBeLessThanOrEqual(f.origin.taskTimeoutMs);
    expect(bootstrap.configToml).toContain('[features.network_proxy]\nenabled = true\ndomains = { "*" = "allow" }');
    expect(bootstrap.configToml.match(/allow_local_binding = false/g)).toHaveLength(3);
    expect(bootstrap.configToml.match(/allow_upstream_proxy = false/g)).toHaveLength(3);
    expect(bootstrap.configToml).toContain('credential_broker = false');
    expect(bootstrap.configToml).toContain('request_max_retries = 0');
    expect(bootstrap.configToml).toContain('stream_max_retries = 0');
    expect(bootstrap.configToml).toContain('supports_websockets = false');
    expect(JSON.stringify(bootstrap)).not.toContain("TEST-real-key"); expect(JSON.stringify(bootstrap)).not.toContain(f.proxy.capability);
    expect(() => hostedMimoCodingBootstrapForFrame({ ...frame, command: "/bin/sh" })).toThrow("frame_invalid");
    await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("start_consumed");
    f.lifetime.close(new Error("TEST-stop")); expect(f.proxy.revoke).toHaveBeenCalled();
  } finally { await material?.close(); }
  expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("refuses a sub-millisecond request budget before credentials or proxy effects", async () => {
  const f = setup("5".repeat(64));
  vi.spyOn(f.lifetime, "remainingMs").mockReturnValue(0.875);
  await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("hosted_mimo_coding_proxy_binding_invalid");
  expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
it("denies stale independent authority before credential read", async () => {
  const f = setup("b".repeat(64)); mocks.current.mockImplementation(() => { throw new Error("stale"); });
  await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("stale"); expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
});
it("opens no credential or proxy when origin preparation exhausts the original lifetime", async () => {
  const f = setup("preparation-expired");
  mocks.current.mockImplementationOnce(() => f.lifetime.close(new Error("TEST-original-expired")));
  await expect(createHostedMimoCodingProxyMaterial(f.input)).rejects.toThrow("TEST-original-expired");
  expect(mocks.credential).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
it("does not select Coding credentials for ordinary worker origins", async () => {
  const f = setup("c".repeat(64)); mocks.read.mockReturnValue(null);
  expect(await createHostedMimoCodingProxyMaterial(f.input)).toBeNull(); expect(mocks.credential).not.toHaveBeenCalled();
});
it("shares one proxy flight and revokes it when disposal races listener startup", async () => {
  const { HostedMimoCodingProxyOwner } = await import("../hosted-mimo-coding-proxy-material");
  const f = setup("d".repeat(64));
  let resolve!: (value: typeof f.proxy) => void;
  mocks.start.mockReturnValue(new Promise(done => { resolve = done; }));
  const owner = new HostedMimoCodingProxyOwner();
  const first = owner.acquire(f.input), second = owner.acquire(f.input);
  owner.revoke(); f.lifetime.close(new Error("TEST-dispose")); resolve(f.proxy);
  const settled = await Promise.allSettled([first, second]);
  expect(settled.every(result => result.status === "rejected")).toBe(true);
  expect(mocks.start).toHaveBeenCalledOnce(); expect(f.proxy.revoke).toHaveBeenCalled(); expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("joins concurrent listener closure instead of returning an early cleanup receipt", async () => {
  const f = setup("e".repeat(64)); let finish!: () => void;
  f.proxy.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const material = (await createHostedMimoCodingProxyMaterial(f.input))!;
  const first = material.close(), second = material.close();
  expect(first).toBe(second);
  let done = false; void second.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); finish(); await first;
  expect(f.proxy.close).toHaveBeenCalledOnce();
});
it("uses the already authenticated classified origin without a second full observation", async () => {
  const f = setup("f".repeat(64)); mocks.read.mockImplementation(() => { throw new Error("unexpected-second-full-read"); });
  const material = await createHostedMimoCodingProxyMaterial({ ...f.input, origin: f.origin as NonNullable<Parameters<typeof createHostedMimoCodingProxyMaterial>[0]["origin"]> });
  try { expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.current).toHaveBeenCalledWith(f.origin); expect(mocks.credential).toHaveBeenCalledWith(f.origin, f.input.redactor, expect.any(Function)); }
  finally { await material?.close(); }
});

it("sets the fixed guest shell environment without inheriting ambient paths or credentials", async () => {
  for (const key of ["PATH", "HOME", "CI", "TMPDIR", "CODEX_HOME", codexMimoApiKeyEnvVarDefault]) vi.stubEnv(key, "TEST-ambient-value-must-not-inherit");
  const f = setup("1".repeat(64)), material = await createHostedMimoCodingProxyMaterial(f.input);
  try {
    const bootstrap = hostedMimoCodingBootstrapForFrame({ command: "/opt/codex", cwd: "/workspace", env: {
      CODEX_HOME: "/job/home/mimo-1/codex-home", [codexMimoApiKeyEnvVarDefault]: f.proxy.capability,
    } })!;
    const policy = bootstrap.configToml.split("[shell_environment_policy]\n")[1]!.split("\n[")[0]!.trim().split("\n");
    expect(policy).toEqual([
      'inherit = "none"',
      'include_only = ["PATH", "HOME", "CI", "TMPDIR", "CODEX_HOME"]',
      `set = { PATH = ${JSON.stringify(`${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`)}, HOME = "/home/coding", CI = "1", TMPDIR = "/tmp", CODEX_HOME = "/home/coding/.codex" }`,
    ]);
    expect(bootstrap.configToml).not.toContain("TEST-ambient-value-must-not-inherit");
    expect(policy.join("\n")).not.toContain(codexMimoApiKeyEnvVarDefault);
  } finally { await material?.close(); }
});


it("keeps linked-worktree Git discovery available through the inner read-only permission projection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-mimo-inner-git-")));
  const source = join(root, "source"), workspace = join(root, "workspaces/worker");
  const git = (args: string[]) => execFileSync("git", args, { stdio: "pipe", env: {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
    GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
  } });
  const f = setup("2".repeat(64)); f.origin.workspacePath = workspace;
  let material: Awaited<ReturnType<typeof createHostedMimoCodingProxyMaterial>> = null;
  try {
    mkdirSync(source); mkdirSync(join(root, "workspaces"));
    git(["init", "--quiet", source]); writeFileSync(join(source, "tracked.txt"), "before\n");
    git(["-C", source, "add", "tracked.txt"]); git(["-C", source, "commit", "--quiet", "-m", "test: linked worktree fixture"]);
    git(["-C", source, "worktree", "add", "--quiet", "-b", "TEST-current", workspace]);
    writeFileSync(join(workspace, "tracked.txt"), "after\n");
    material = await createHostedMimoCodingProxyMaterial(f.input);
    const bootstrap = hostedMimoCodingBootstrapForFrame({ command: "/opt/codex", cwd: workspace, env: {
      CODEX_HOME: "/job/home/mimo-1/codex-home", [codexMimoApiKeyEnvVarDefault]: f.proxy.capability,
    } })!;
    const profile = bootstrap.configToml.split("[permissions.hosted-project-write.filesystem]\n")[1]!.split("\n[")[0]!;
    expect(profile).toContain('":root" = "deny"');
    const selected = [...profile.matchAll(/^(".*") = "read"$/gm)].map(match => JSON.parse(match[1]!) as string)
      .filter(path => path.startsWith(source + "/.git/"));
    const own = join(source, ".git/worktrees/worker");
    expect(selected).toEqual([...['HEAD', 'index', 'commondir', 'gitdir'].map(leaf => join(own, leaf)),
      join(source, ".git/objects"), join(source, ".git/refs")]);
    expect(profile).not.toContain(`${JSON.stringify(join(source, ".git"))} =`);
    for (const leaf of ["config", "hooks", "worktrees", "worktrees/sibling", "HEAD"]) {
      expect(profile).not.toContain(`${JSON.stringify(join(source, ".git", leaf))} =`);
    }
    expect(profile).not.toMatch(/^".*\/.git\/.*" = "write"$/m);
    expect(bootstrap.configToml).toContain('".git" = "read"');
    const projected = join(root, "inner"), projectedWorkspace = join(projected, "workspaces/worker");
    cpSync(workspace, projectedWorkspace, { recursive: true });
    writeFileSync(join(projectedWorkspace, ".git"), `gitdir: ${join(projected, "source/.git/worktrees/worker")}\n`);
    // The previous config exposes no external Git metadata: normal discovery fails.
    expect(() => git(["-C", projectedWorkspace, "diff", "--check"])).toThrow();
    for (const path of selected) {
      const target = join(projected, path.slice(root.length + 1));
      mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      cpSync(path, target, { recursive: true });
    }
    // Normal discovery reads .git -> own HEAD/commondir -> common objects/refs.
    expect(git(["-C", projectedWorkspace, "diff", "--check"]).length).toBe(0);
    expect(git(["-C", projectedWorkspace, "diff"]).toString()).toContain("+after");
    expect(readFileSync(join(workspace, ".git"), "utf8")).toBe(`gitdir: ${own}\n`);
    // A changed pointer cannot expand permissions or open the credential.
    await material?.close(); material = null;
    writeFileSync(join(workspace, ".git"), `gitdir: ${join(source, ".git/worktrees/sibling")}\n`);
    const denied = setup("3".repeat(64)); denied.origin.workspacePath = workspace;
    mocks.credential.mockClear(); mocks.start.mockClear();
    await expect(createHostedMimoCodingProxyMaterial(denied.input)).rejects.toThrow("mimo_coding_git_binding_invalid");
    expect(mocks.credential).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  } finally { await material?.close(); rmSync(root, { recursive: true, force: true }); }
});
