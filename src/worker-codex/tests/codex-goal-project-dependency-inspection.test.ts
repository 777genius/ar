import { join, basename } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, rmdir, statfs, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { inspectStandaloneProjectDependencies } from "../application/project-control/codex-goal-project-dependency-inspection";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock,
  type ProjectControlWorkspaceLease } from "../codex-goal-project-workspace-lock";
import { hostedDependencyBindingRoot, hostedDependencyBindingName, HostedDependencyReferenceKind } from "../hosted-dependency-workspace";
import type { CodexGoalJobManifestInput } from "../codex-goal-jobs";

// These cases use actual filesystem/lease evidence in the original service's
// empty private policy tmpfs. Shared research mocks must not replace retained
// /proc/self/fd link reads, protected binding paths, or the actual mount table.
const actualRoot = process.platform === "linux" && process.getuid?.() === 0;
const policy = "/var/lib/subscription-runtime-host-policy";
const jobs = policy + "/dependency-test-jobs/jobs";
type Identity = Readonly<{ dev: number; ino: number }>;
let ownedJob: { path: string; identity: Identity } | undefined;
let ownedBindingDirectory: Identity | undefined;
let ownedBindingLink: Identity | undefined;
const ownedBindings = new Map<string, Identity>();
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
(actualRoot ? describe : describe.skip)("standalone project dependency observation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // Refuse a changed identity rather than deleting a replacement or foreign
    // record. These are exclusively created paths in the private TEST mount.
    for (const [path, identity] of ownedBindings) {
      const now = await lstat(path);
      expect(now.isFile() && !now.isSymbolicLink() && sameIdentity(identity, now)).toBe(true);
      await rm(path);
    }
    ownedBindings.clear();
    if (ownedBindingLink) {
      const now = await lstat(hostedDependencyBindingRoot);
      expect(now.isSymbolicLink() && sameIdentity(ownedBindingLink, now)).toBe(true);
      await rm(hostedDependencyBindingRoot);
      ownedBindingLink = undefined;
    }
    if (ownedBindingDirectory) {
      const now = await lstat(hostedDependencyBindingRoot);
      expect(now.isDirectory() && !now.isSymbolicLink() && sameIdentity(ownedBindingDirectory, now)).toBe(true);
      expect(await readdir(hostedDependencyBindingRoot)).toEqual([]);
      await rmdir(hostedDependencyBindingRoot);
      ownedBindingDirectory = undefined;
    }
    if (ownedJob) {
      const now = await lstat(ownedJob.path);
      expect(now.isDirectory() && !now.isSymbolicLink() && sameIdentity(ownedJob.identity, now)).toBe(true);
      await rm(ownedJob.path, { recursive: true });
      ownedJob = undefined;
    }
  });
  async function bindingDirectory(): Promise<void> {
    await mkdir(hostedDependencyBindingRoot, { mode: 0o700 });
    ownedBindingDirectory = await lstat(hostedDependencyBindingRoot);
  }
  async function bindingRecord(jobId: string, body: string): Promise<void> {
    const path = join(policy, hostedDependencyBindingName(jobId));
    await writeFile(path, body, { flag: "wx", mode: 0o600 });
    ownedBindings.set(path, await lstat(path));
  }
  async function fixture() {
    expect(process.getuid?.()).toBe(0); expect(process.geteuid?.()).toBe(0);
    expect(process.env.SR_ARCHIVE_TEST_PRIVILEGE).toBe("root");
    expect((await readFile("/proc/self/uid_map", "utf8")).trim().split(/\s+/)).toEqual(["0", "0", "4294967295"]);
    for (const namespace of ["user", "mnt", "pid"]) {
      expect(await readlink(`/proc/self/ns/${namespace}`)).toBe(await readlink(`/proc/1/ns/${namespace}`));
    }
    expect((await statfs(policy, { bigint: true })).type).toBe(0x01021994n);
    for (const path of [policy, policy + "/dependency-test-jobs", jobs]) {
      const info = await lstat(path);
      expect(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o777) === 0o700).toBe(true);
      expect(await realpath(path)).toBe(path);
    }
    await expect(lstat(hostedDependencyBindingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const job = await mkdtemp(join(jobs, "TEST-readonly-dependencies-"));
    ownedJob = { path: job, identity: await lstat(job) };
    const workspace = join(job, "workspace"), registry = join(job, "state/registry"), jobId = basename(job);
    for (const path of [workspace, join(workspace, ".git/objects/info"), registry, join(job, "auth")])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const scope = { projectId: "TEST-readonly-dependencies", worktreeRoots: [workspace],
      registryRoot: registry, authRoot: join(job, "auth") };
    const manifest: CodexGoalJobManifestInput = { jobId, taskId: jobId, jobRootDir: job, workspacePath: workspace,
      promptPath: join(job, "prompt.md"), authRootDir: scope.authRoot, accounts: ["account-a"],
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, executionEngine: "app-server-goal",
      durableHandoffRootDir: join(job, "durable-handoffs") };
    const input = { manifest, target: { jobId, path: workspace, sourceWorkspacePath: workspace,
      expectedSourceRealPath: workspace, expectedRealPath: workspace, expectedRevision: "a".repeat(40), baseBranch: "main" },
      scope, registryRootDir: registry, mode: "preflight" as const };
    const withLease = async <T>(effect: (lease: ProjectControlWorkspaceLease) => Promise<T>) =>
      await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registry), scope,
        requestedWorkspacePath: workspace, owner: "TEST-dependency-inspection", effect });
    return { job, workspace, registry, input, withLease };
  }
  it("observes supported Node metadata without a diagnostic, cache, claim or install", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "package.json"), JSON.stringify({ packageManager: "npm@11", scripts: { test: "vitest" } }));
    await writeFile(join(f.workspace, "package-lock.json"), "{}\n");
    const before = await readdir(f.job), packageBefore = await readFile(join(f.workspace, "package.json"));
    const result = await f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }));
    expect(result).toMatchObject({ mode: "preflight", ecosystem: "node", status: "deps_missing", packageManager: { name: "npm" } });
    expect(result?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("diagnosticPath"); expect(result).not.toHaveProperty("cacheRoot");
    expect(result).not.toHaveProperty("installCommand"); expect(await readdir(f.job)).toEqual(before);
    expect(await readFile(join(f.workspace, "package.json"))).toEqual(packageBefore);
  });
  it("observes locked Python metadata and off-mode safety without writing", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "pyproject.toml"), "[project]\nname='test'\n");
    await writeFile(join(f.workspace, "uv.lock"), "version = 1\n");
    const before = await readdir(f.job);
    await f.withLease(async workspace => {
      expect(await inspectStandaloneProjectDependencies({ ...f.input, workspace })).toMatchObject({
        ecosystem: "python", status: "deps_missing", packageManager: { name: "uv" }, binaryChecks: expect.any(Array) });
      expect(await inspectStandaloneProjectDependencies({ ...f.input, workspace, mode: "off" })).toMatchObject({ mode: "off", status: "off" });
    });
    expect(await readdir(f.job)).toEqual(before);
  });
  it("rejects a structural lease copy and a genuine closed lease", async () => {
    const f = await fixture(); let closed!: ProjectControlWorkspaceLease;
    await f.withLease(async workspace => {
      closed = workspace;
      await expect(inspectStandaloneProjectDependencies({ ...f.input, workspace: { ...workspace } })).rejects.toThrow("lease_not_held");
    });
    await expect(inspectStandaloneProjectDependencies({ ...f.input, workspace: closed })).rejects.toThrow("lease_not_held");
  });
  it("rejects an escaping manifest link rather than reading its bytes", async () => {
    const f = await fixture(), foreign = join(f.job, "outside-package.json");
    await writeFile(foreign, '{"private":"TEST-private-sentinel"}'); await symlink(foreign, join(f.workspace, "package.json"));
    await expect(f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }))).rejects.toThrow();
    expect(await readFile(foreign, "utf8")).toBe('{"private":"TEST-private-sentinel"}');
  });
  it("delegates explicit V1 to the unchanged legacy route before reader-only lease checks", async () => {
    const f = await fixture(), identity = await lstat(f.workspace, { bigint: true });
    await bindingDirectory();
    const binding = { version: 1, jobId: f.input.manifest.jobId, jobRootDir: f.job,
      workspace: { canonicalPath: f.workspace, dev: identity.dev.toString(), ino: identity.ino.toString() },
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64) };
    await bindingRecord(binding.jobId, JSON.stringify(binding) + "\n");
    let reads = 0;
    const workspace: ProjectControlWorkspaceLease = { requestedWorkspacePath: f.workspace,
      get canonicalWorkspacePath(): never { reads++; throw new Error("reader lease evaluated"); },
      lease: { workspacePath: f.workspace, owner: "unused", lockId: "unused" } };
    expect(await inspectStandaloneProjectDependencies({ ...f.input, workspace })).toBeUndefined();
    expect(reads).toBe(0);
  });
  it("does not interpret an existing malformed binding as absence", async () => {
    const f = await fixture(); await bindingDirectory();
    await bindingRecord(f.input.manifest.jobId, "{}\n");
    await expect(f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }))).rejects.toThrow();
  });
  it("rejects a symlinked protected binding namespace", async () => {
    const f = await fixture(), target = join(f.job, "other-bindings"); await mkdir(target, { mode: 0o700 });
    await symlink(target, hostedDependencyBindingRoot);
    ownedBindingLink = await lstat(hostedDependencyBindingRoot);
    await expect(f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }))).rejects.toThrow();
  });
  it("rejects retained enrolled physical identity even after the original job path is gone", async () => {
    const f = await fixture(), identity = await lstat(f.workspace, { bigint: true }), jobId = "TEST-moved-enrolled";
    await bindingDirectory();
    const binding = { version: 3, jobId,
      jobRootDir: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + jobId,
      workspace: { canonicalPath: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + jobId + "/workspace",
        dev: identity.dev.toString(), ino: identity.ino.toString() },
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64),
      reference: { kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
    await bindingRecord(jobId, JSON.stringify(binding) + "\n");
    await expect(f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }))).rejects.toThrow("dependency_admission:unsupported");
  });
  it("rejects a mounted workspace alias from the bounded mount observation", async () => {
    const f = await fixture(), table = join(f.job, "denial-mountinfo");
    await writeFile(table, `1 0 8:1 / ${f.workspace} rw - ext4 /dev/TEST rw\n`);
    // A negative observation only: no mount is created and this can grant no
    // authority. Every positive above keeps the actual native mount table.
    const nativeOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) =>
      nativeOpen(path === "/proc/self/mountinfo" ? table : path, flags, mode));
    await expect(f.withLease(async workspace => await inspectStandaloneProjectDependencies({ ...f.input, workspace }))).rejects.toThrow("dependency_admission:unsupported");
  });
  it("does not select a noncanonical or different child layout", async () => {
    const f = await fixture(); await f.withLease(async workspace => {
      expect(await inspectStandaloneProjectDependencies({ ...f.input, workspace,
        manifest: { ...f.input.manifest, workspacePath: f.workspace + "/." } })).toBeUndefined();
      expect(await inspectStandaloneProjectDependencies({ ...f.input, workspace,
        scope: { ...f.input.scope, worktreeRoots: [f.job] } })).toBeUndefined();
    });
  });
});
