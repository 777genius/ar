import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedNonqualifiedResourcePolicyId, retainedNonqualifiedResourceLimits } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody, localProjectControlEvidenceCustodySupported } from "../../worker-local/project-control-evidence-custody-local-adapter";
import { defaultProjectControlGitPort } from "../application/project-control/adapters/host-command-adapters";
import { captureRetainedWorkspaceInventory } from "../application/project-control/codex-goal-retained-nonqualified-inventory";
import { captureRetainedTrackedPatch } from "../application/project-control/codex-goal-retained-nonqualified-tracked-patch";
import { preflightRetainedResources } from "../application/project-control/codex-goal-retained-nonqualified-resources";
import { retainedLifecyclePaths } from "../application/project-control/codex-goal-retained-nonqualified-lifecycle";
import { buildTar } from "../codex-goal-handoff-untracked-tar";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";

// Suite roles (rule 31 clause 3): the tracked-patch tests drive the REAL helper against a real Git
// repository and BIND "tracked.diff excludes untracked bytes" by contrasting the retained helper with
// the unchanged approved-output helper that does include them. The inventory/preflight tests need the
// Linux held-descriptor custody and run only there; they bind that an oversize corpus is refused from
// metadata alone and that measured archive sizes equal the archives actually built.

const exec = promisify(execFile);
const MIB = 1024 * 1024;
const defaultLimits = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.Default)!;
const expandedLimits = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.ExpandedV1)!;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retained-capacity-TEST-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
  await git("init", "-q", "-b", "main");
  // The raw-identity guard refuses any Git conversion, including one inherited from a host's global config.
  await git("config", "core.autocrlf", "false");
  await git("config", "user.name", "iliya"); await git("config", "user.email", "iliyazelenkog@gmail.com");
  return { root, git };
}

describe("retention-only tracked patch", () => {
  it("is exactly the tracked HEAD-to-worktree diff: binary, mode, delete and staged add included, untracked bytes excluded", async () => {
    const { root, git } = await repository();
    await writeFile(join(root, "tracked.txt"), "before\n");
    await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
    await writeFile(join(root, "gone.txt"), "will be deleted\n");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
    await git("add", "-A"); await git("commit", "-q", "-m", "chore(test): base");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "bin.dat"), Buffer.from([9, 8, 7, 0, 254]));
    await unlink(join(root, "gone.txt"));
    await chmod(join(root, "run.sh"), 0o755);
    await writeFile(join(root, "added.txt"), "staged addition\n"); await git("add", "added.txt");
    await writeFile(join(root, "untracked-input.txt"), "UNTRACKED-MARKER useful input\n");

    const patch = (await captureRetainedTrackedPatch({ workspacePath: root, maxBytes: 1 * MIB })).toString("utf8");
    expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(patch).toContain("+after");
    expect(patch).toContain("GIT binary patch");
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("new file mode 100644"); // the staged addition is part of HEAD-to-worktree
    expect(patch).toMatch(/old mode 100644\nnew mode 100755/);
    expect(patch).not.toContain("UNTRACKED-MARKER");
    expect(patch).not.toContain("untracked-input.txt");
    // The unchanged approved-output helper still appends untracked no-index diffs: the contrast that binds the difference.
    const approvedOutputPatch = await captureGitWorkspacePatch({ workspacePath: root });
    expect(approvedOutputPatch).toContain("UNTRACKED-MARKER");
  });

  it("applies cleanly to a clean checkout of HEAD and reproduces the tracked worktree exactly", async () => {
    const { root, git } = await repository();
    await writeFile(join(root, "tracked.txt"), "before\n"); await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
    await git("add", "-A"); await git("commit", "-q", "-m", "chore(test): base");
    await writeFile(join(root, "tracked.txt"), "after\n"); await writeFile(join(root, "bin.dat"), Buffer.from([9, 8, 7, 0, 254]));
    const patch = await captureRetainedTrackedPatch({ workspacePath: root, maxBytes: 1 * MIB });
    const clone = join(root, "..", `${root.split("/").at(-1)}-restore`);
    cleanups.push(() => rm(clone, { recursive: true, force: true }));
    await exec("git", ["clone", "-q", root, clone]);
    const patchFile = join(root, "..", `${root.split("/").at(-1)}-retained.patch`);
    cleanups.push(() => rm(patchFile, { force: true }));
    await writeFile(patchFile, patch);
    await exec("git", ["apply", "--binary", patchFile], { cwd: clone });
    // Independent comparison with the original worktree bytes, not with another patch.
    expect(await readFile(join(clone, "tracked.txt"))).toEqual(await readFile(join(root, "tracked.txt")));
    expect(await readFile(join(clone, "bin.dat"))).toEqual(Buffer.from([9, 8, 7, 0, 254]));
  });

  it("refuses a patch beyond its cap instead of truncating it", async () => {
    const { root, git } = await repository();
    await writeFile(join(root, "tracked.txt"), "before\n"); await git("add", "-A"); await git("commit", "-q", "-m", "chore(test): base");
    await writeFile(join(root, "tracked.txt"), `${"x".repeat(4096)}\n`);
    await expect(captureRetainedTrackedPatch({ workspacePath: root, maxBytes: 64 })).rejects.toThrow("retained_nonqualified_patch_too_large");
    expect((await captureRetainedTrackedPatch({ workspacePath: root, maxBytes: 1 * MIB })).length).toBeGreaterThan(4096);
  });
});

describe.runIf(localProjectControlEvidenceCustodySupported)("retained inventory resource measurement (Linux held-descriptor custody)", () => {
  async function workspace() {
    const { root, git } = await repository();
    await writeFile(join(root, ".gitignore"), "logs/\n");
    await writeFile(join(root, "tracked.txt"), "before\n"); await git("add", "-A"); await git("commit", "-q", "-m", "chore(test): base");
    return { root, git };
  }
  const sparse = async (path: string, size: number) => { await writeFile(path, ""); await truncate(path, size); };

  it("refuses an oversize file from metadata alone, one byte beyond each policy's per-file cap", async () => {
    const { root } = await workspace();
    await sparse(join(root, "big.bin"), defaultLimits.fileBytes);
    expect((await captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: defaultLimits })).measure.largestFileBytes).toBe(defaultLimits.fileBytes);
    await truncate(join(root, "big.bin"), defaultLimits.fileBytes + 1);
    await expect(captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: defaultLimits })).rejects.toThrow("retained_nonqualified_inventory_too_large");
    // The expanded policy admits it (metadata only: no 64 MiB body was read to decide) and has its own cap.
    expect((await captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: expandedLimits })).measure.largestFileBytes).toBe(defaultLimits.fileBytes + 1);
    await truncate(join(root, "big.bin"), expandedLimits.fileBytes + 1);
    await expect(captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: expandedLimits })).rejects.toThrow("retained_nonqualified_inventory_too_large");
  });

  it("refuses the combined worktree + staged aggregate one byte beyond the policy, without reading bodies", async () => {
    const { root, git } = await workspace();
    // Staged: a blob that differs from HEAD, counted in the same aggregate as worktree bytes.
    await sparse(join(root, "staged.bin"), 1 * MIB); await git("add", "staged.bin");
    // staged blob 1 MiB + the same file's worktree bytes 1 MiB + worktree.bin: exactly the aggregate cap.
    await sparse(join(root, "worktree.bin"), defaultLimits.inventoryBytes - 2 * MIB);
    const read = vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "readImmutableFile");
    const measured = await captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: defaultLimits });
    expect(measured.measure).toMatchObject({ stagedBytes: 1 * MIB, worktreeBytes: defaultLimits.inventoryBytes - 1 * MIB });
    await truncate(join(root, "worktree.bin"), defaultLimits.inventoryBytes - 2 * MIB + 1);
    await expect(captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: defaultLimits })).rejects.toThrow("retained_nonqualified_inventory_too_large");
    expect(read).not.toHaveBeenCalled();
  });

  it("measures the exact padded USTAR lengths the archives really have, including a long path and a staged blob", async () => {
    const { root, git } = await workspace();
    const longDir = `${"d".repeat(60)}/${"e".repeat(60)}`;
    await mkdir(join(root, longDir), { recursive: true });
    await writeFile(join(root, longDir, "input.txt"), "x".repeat(1000));
    await writeFile(join(root, "small.txt"), "tiny");
    await writeFile(join(root, "tracked.txt"), "staged side\n"); await git("add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "worktree side\n");
    const measured = await captureRetainedWorkspaceInventory(root, { measureOnly: true });
    const collected = await captureRetainedWorkspaceInventory(root, { collect: true });
    expect(collected.measure).toEqual(measured.measure);
    expect(buildTar(collected.untrackedFiles).length).toBe(collected.measure.untrackedTarBytes);
    expect(buildTar(collected.stagedFiles).length).toBe(collected.measure.stagedTarBytes);
    // The receipt-entry bound really bounds the pretty-printed entries it describes.
    expect(Buffer.byteLength(JSON.stringify(collected.entries, null, 2))).toBeLessThan(collected.measure.receiptEntriesBoundBytes);
  });

  it("fetches a LARGE independently staged blob only when collecting: verification binds index oid, mode and size without any body fetch", async () => {
    const { root, git } = await workspace();
    // MM: a 24 MiB staged side (index) and a tiny, different worktree side. Real bytes (Git needs them), not sparse.
    const stagedBody = Buffer.alloc(24 * MIB);
    for (let i = 0; i < stagedBody.length; i += 1) stagedBody[i] = (i * 31 + (i >> 8)) & 0xff;
    await writeFile(join(root, "big-staged.bin"), stagedBody); await git("add", "big-staged.bin");
    await writeFile(join(root, "big-staged.bin"), "tiny worktree side\n");
    const oid = (await git("rev-parse", ":big-staged.bin")).trim();
    expect(oid).toBe(createHash("sha1").update(`blob ${stagedBody.length}\0`).update(stagedBody).digest("hex"));
    const gitCalls = () => runBuffered.mock.calls.map(([call]) => (call as { args: readonly string[] }).args);
    const bodyFetches = () => gitCalls().filter(args => args.includes("cat-file") && args.includes("blob")).length;
    const runBuffered = vi.spyOn(defaultProjectControlGitPort, "runBuffered");

    // Verification mode (what admission and the producer recheck use): no staged body is requested or kept.
    const verified = await captureRetainedWorkspaceInventory(root, { limits: expandedLimits });
    expect(bodyFetches()).toBe(0);
    expect(gitCalls().some(args => args.includes("cat-file") && args.includes("-s"))).toBe(true); // size is admitted from metadata
    expect(verified.stagedFiles).toEqual([]);
    expect(verified.measure.stagedBytes).toBe(stagedBody.length);
    expect(verified.entries.find(entry => entry.path === "big-staged.bin")).toMatchObject({ status: "MM", index: { mode: "100644", oid } });
    // Measuring mode never fetches either.
    await captureRetainedWorkspaceInventory(root, { measureOnly: true, limits: expandedLimits });
    expect(bodyFetches()).toBe(0);

    // The admitted collecting path has the authentic full payload, with the same digest and measurements.
    runBuffered.mockClear();
    const collected = await captureRetainedWorkspaceInventory(root, { collect: true, limits: expandedLimits });
    expect(bodyFetches()).toBe(1);
    expect(collected.stagedFiles).toHaveLength(1);
    expect(collected.stagedFiles[0]!.bytes.equals(stagedBody)).toBe(true);
    expect(collected.digest).toBe(verified.digest);
    expect(collected.measure).toEqual(verified.measure);

    // A changed independent index is still detected without any body: restaging different content changes the digest.
    await writeFile(join(root, "big-staged.bin"), "different staged side\n"); await git("add", "big-staged.bin");
    await writeFile(join(root, "big-staged.bin"), "tiny worktree side\n");
    runBuffered.mockClear();
    const changed = await captureRetainedWorkspaceInventory(root, { limits: expandedLimits });
    expect(bodyFetches()).toBe(0);
    expect(changed.digest).not.toBe(verified.digest);
  });

  it("keeps the untracked-symlink refusal in measure mode exactly as in capture, and never follows the link", async () => {
    const { root } = await workspace();
    await symlink("/etc/hostname", join(root, "alias"));
    await expect(captureRetainedWorkspaceInventory(root, { measureOnly: true })).rejects.toThrow("retained_nonqualified_unsafe_symlink");
  });
});

describe.runIf(localProjectControlEvidenceCustodySupported)("retained resource preflight refuses before any body is read", () => {
  async function fixture() {
    const { root, git } = await repository();
    await writeFile(join(root, "tracked.txt"), "before\n"); await git("add", "-A"); await git("commit", "-q", "-m", "chore(test): base");
    await writeFile(join(root, "input.txt"), "useful input\n");
    const jobRoot = join(root, "..", `${root.split("/").at(-1)}-job`);
    // Lifecycle files are absent, but their parents must be certified canonical directories.
    await mkdir(join(jobRoot, "registry", "TEST-worker"), { recursive: true });
    cleanups.push(() => rm(jobRoot, { recursive: true, force: true }));
    const lifecyclePaths = retainedLifecyclePaths({ jobId: "TEST-worker", taskId: "TEST-worker", jobRootDir: jobRoot,
      promptPath: join(jobRoot, "prompt.md") } as never, join(jobRoot, "registry"));
    return { root, lifecyclePaths, durablePath: jobRoot };
  }
  const bodiesRead = () => [
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "readImmutableFile"),
    vi.spyOn(LocalProjectControlEvidenceCustody.prototype, "readOptionalImmutableFile"),
  ];
  const request = (f: Awaited<ReturnType<typeof fixture>>, policy: RetainedNonqualifiedResourcePolicyId) => ({
    policy, limits: retainedNonqualifiedResourceLimits(policy)!, workspacePath: f.root, ignoredRetain: [] as string[],
    lifecyclePaths: f.lifecyclePaths, intentBytes: 100, durablePath: f.durablePath,
  });

  it("refuses the expanded policy when a tighter cgroup ancestor leaves too little, though the host reports plenty", async () => {
    const f = await fixture();
    const spies = bodiesRead();
    await expect(preflightRetainedResources({ ...request(f, RetainedNonqualifiedResourcePolicyId.ExpandedV1),
      readMemory: async () => ({ hostAvailableBytes: 46 * 1024 * MIB, cgroupRemainingBytes: 1024 * MIB, effectiveBytes: 1024 * MIB, cgroupVersion: "v2" }) }))
      .rejects.toThrow("retained_nonqualified_memory_insufficient");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("refuses the expanded policy on unknown limits, and admits it with enough allowance", async () => {
    const f = await fixture();
    await expect(preflightRetainedResources({ ...request(f, RetainedNonqualifiedResourcePolicyId.ExpandedV1),
      readMemory: async () => { throw new Error("linux_memory_unknown:cgroup_v2_limits_unprovable"); } }))
      .rejects.toThrow("retained_nonqualified_memory_unknown:linux_memory_unknown:cgroup_v2_limits_unprovable");
    const admitted = await preflightRetainedResources({ ...request(f, RetainedNonqualifiedResourcePolicyId.ExpandedV1),
      readMemory: async () => ({ hostAvailableBytes: 64 * 1024 * MIB, cgroupRemainingBytes: undefined, effectiveBytes: 64 * 1024 * MIB, cgroupVersion: "v2" }) });
    expect(admitted.memory).toMatchObject({ requiredBytes: 4.25 * 1024 * MIB });
    expect(admitted.budget.totalBoundBytes).toBeLessThanOrEqual(expandedLimits.backupBytes);
  });

  it("does not probe memory for the ordinary policy", async () => {
    const f = await fixture();
    let probed = false;
    const admitted = await preflightRetainedResources({ ...request(f, RetainedNonqualifiedResourcePolicyId.Default),
      readMemory: async () => { probed = true; throw new Error("must not be called"); } });
    expect(probed).toBe(false);
    expect(admitted.memory).toBeUndefined();
  });

  it("refuses an oversize corpus from metadata alone before the memory probe or any body read", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "big.bin"), ""); await truncate(join(f.root, "big.bin"), defaultLimits.fileBytes + 1);
    const spies = bodiesRead();
    let probed = false;
    await expect(preflightRetainedResources({ ...request(f, RetainedNonqualifiedResourcePolicyId.Default),
      readMemory: async () => { probed = true; throw new Error("unreachable"); } })).rejects.toThrow("retained_nonqualified_inventory_too_large");
    expect(probed).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
