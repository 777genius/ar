import { buildTar } from "../codex-goal-handoff-untracked-tar";
import { handoffPreservationRefusalReason } from "../codex-goal-handoff-preservation-budget";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  materializeDurableCodexGoalHandoffPacket,
  durableCodexGoalHandoffPacketFiles,
} from "../codex-goal-durable-handoff-packet";
import {
  terminalCodexGoalHandoffResultDetails,
  tryMaterializeTerminalCodexGoalHandoff,
} from "../codex-goal-terminal-handoff-materialization";
import { withMcpErrors } from "../codex-goal-mcp-response";
import { preserveTerminalHandoffBeforeStop } from
  "../codex-goal-preserve-before-stop";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("durable terminal handoff packet", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  // RED: authority revocation still creates/chmods the requested sink or allows
  // a packet rename. Check actual files/modes, not merely callback invocation.
  it("denies revoked publication before sink permission or file effects", async () => {
    const fixture = await createFixture();
    const sink = join(fixture.root, "TEST-foreign-source");
    await mkdir(sink, { mode: 0o755 });
    await chmod(sink, 0o755);
    await writeFile(join(sink, "TEST-preserved-source.txt"), "TEST original source");
    await expect(materializeDurableCodexGoalHandoffPacket({ workerJobId: "TEST-worker", taskId: "TEST-task",
      workspacePath: fixture.workspace, durableRootDir: sink,
      publicationAuthority: { assertPublicationAuthorized: async () => { throw new Error("TEST-revoked"); } },
    })).rejects.toThrow("TEST-revoked");
    expect((await stat(sink)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(sink, "TEST-preserved-source.txt"), "utf8")).toBe("TEST original source");
  });

  it("denies authority lost during capture before durable packet publication", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "TEST dirty source\n");
    let authorized = true;
    await expect(materializeDurableCodexGoalHandoffPacket({ workerJobId: "TEST-worker", taskId: "TEST-task",
      workspacePath: fixture.workspace, durableRootDir: fixture.durableRoot,
      publicationAuthority: { assertPublicationAuthorized: async () => { if (!authorized) throw new Error("TEST-revoked"); } },
      testHooks: { beforePublish: async () => { authorized = false; } },
    })).rejects.toThrow("TEST-revoked");
    expect(await readDirectoryNames(fixture.durableRoot)).toEqual([]);
    expect(await readFile(join(fixture.workspace, "tracked.txt"), "utf8")).toBe("TEST dirty source\n");
  });

  it("preserves mixed index and worktree layers and reconstructs them exactly", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "mixed.txt"), "staged\n");
    await git(fixture.workspace, ["add", "mixed.txt"]);
    await writeFile(join(fixture.workspace, "mixed.txt"), "worktree\n");

    const packet = await capture(fixture);
    expect(packet?.manifest.layers.index.byteLength).toBeGreaterThan(0);
    expect(packet?.manifest.layers.worktree.byteLength).toBeGreaterThan(0);
    expect(packet?.manifest.layers.headRelative?.byteLength).toBeGreaterThan(0);
    const files = durableCodexGoalHandoffPacketFiles(packet!.manifest);
    expect(files.map(file => file.descriptor.path)).toEqual(["status.porcelain-v2.z", "index.patch", "worktree.patch",
      "head-relative.patch", "untracked.tar", "untracked.paths.z", "quarantine.json"]);
    expect(files.find(file => file.descriptor.path === "untracked.tar")?.maxBytes).toBe(128 * 1024 * 1024);
    expect(files.filter(file => file.descriptor.path !== "untracked.tar").every(file => file.maxBytes === 32 * 1024 * 1024)).toBe(true);

    const reconstructed = join(fixture.root, "reconstructed");
    await git(fixture.root, ["clone", "--quiet", fixture.workspace, reconstructed]);
    await git(reconstructed, ["apply", "--cached", packet!.artifacts.find(
      (artifact) => artifact.kind === "handoff_index"
    )!.path!]);
    await git(reconstructed, ["checkout-index", "--all", "--force"]);
    await git(reconstructed, ["apply", packet!.artifacts.find(
      (artifact) => artifact.kind === "handoff_worktree"
    )!.path!]);
    expect(await gitText(reconstructed, ["show", ":mixed.txt"])).toBe("staged\n");
    expect(await readFile(join(reconstructed, "mixed.txt"), "utf8")).toBe("worktree\n");
  });

  it("preserves every byte of a Router-sized output above the old archive limit", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.alloc(7_500_000).fill("TEST cache material\n");
    for (let index = 0; index < 7; index++) await writeFile(join(fixture.workspace, `TEST-cache-${index}.bin`), bytes);
    const packet = await capture(fixture);
    expect(packet?.manifest.untracked.entries).toHaveLength(7);
    expect(packet?.manifest.untracked.archive.byteLength).toBeGreaterThan(32 * 1024 * 1024);
    for (const entry of packet!.manifest.untracked.entries) {
      expect(entry.byteLength).toBe(bytes.length);
      expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    const archive = await readFile(join(packet!.packetPath, "untracked.tar"));
    expect(createHash("sha256").update(archive).digest("hex")).toBe(packet!.manifest.untracked.archive.sha256);
    for (let index = 0; index < 7; index++) expect(createHash("sha256").update(await readFile(join(fixture.workspace, `TEST-cache-${index}.bin`))).digest("hex"))
      .toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("retains all workspace bytes when the finite untracked aggregate is exceeded", async () => {
    const fixture = await createFixture(), bytes = Buffer.alloc(8 * 1024 * 1024).fill("TEST retained cache\n");
    for (let index = 0; index < 9; index++) await writeFile(join(fixture.workspace, `TEST-over-${index}.bin`), bytes);
    await expect(capture(fixture)).rejects.toThrow("handoff_total_byte_limit_exceeded");
    expect(await readDirectoryNames(fixture.durableRoot)).toEqual([]);
    for (let index = 0; index < 9; index++) expect(createHash("sha256").update(await readFile(join(fixture.workspace, `TEST-over-${index}.bin`))).digest("hex"))
      .toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("refuses an archive above its finite bound before concatenating bodies", () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    expect(() => buildTar(Array.from({ length: 17 }, (_, index) => ({ path: `TEST-${index}.bin`, bytes, mode: 0o600 }))))
      .toThrow("handoff_total_byte_limit_exceeded");
    expect(handoffPreservationRefusalReason(new Error("dirty_terminal_handoff_unavailable:handoff_total_byte_limit_exceeded")))
      .toBe("handoff_total_byte_limit_exceeded");
    expect(handoffPreservationRefusalReason(new Error("handoff_total_byte_limit_exceeded:TEST-untrusted-extra"))).toBeUndefined();
    expect(handoffPreservationRefusalReason(new Error("TEST permission refused"))).toBeUndefined();
  });

  it("classifies only exact sensitive-path preservation refusals", () => {
    for (const code of ["handoff_sensitive_path_rejected", "dirty_terminal_handoff_unavailable:handoff_sensitive_path_rejected"]) {
      expect(handoffPreservationRefusalReason(new Error(code))).toBe("handoff_sensitive_path_rejected");
    }
    expect(handoffPreservationRefusalReason(new Error("handoff_sensitive_path_rejected:TEST-private-path"))).toBeUndefined();
    expect(handoffPreservationRefusalReason(new Error("dirty_terminal_handoff_unavailable:handoff_sensitive_path_rejected:TEST-private-path"))).toBeUndefined();
    expect(handoffPreservationRefusalReason({ message: "handoff_sensitive_path_rejected" })).toBeUndefined();
  });

  it("keeps run-start base separate from a later committed HEAD and dirty layers", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "committed B\n");
    await git(fixture.workspace, ["add", "tracked.txt"]);
    await git(fixture.workspace, ["commit", "--quiet", "-m", "commit B"]);
    const head = (await gitText(fixture.workspace, ["rev-parse", "HEAD"])).trim();
    const headTree = (await gitText(
      fixture.workspace,
      ["rev-parse", "HEAD^{tree}"],
    )).trim();
    await writeFile(join(fixture.workspace, "tracked.txt"), "staged C\n");
    await git(fixture.workspace, ["add", "tracked.txt"]);
    await writeFile(join(fixture.workspace, "tracked.txt"), "worktree C\n");

    const packet = await capture(fixture, { expectedHeadCommit: head });
    expect(packet?.manifest.git).toMatchObject({
      base: fixture.base,
      head,
      headTree,
    });

    const reconstructed = join(fixture.root, "partial-commit-reconstructed");
    await git(fixture.root, ["clone", "--quiet", fixture.workspace, reconstructed]);
    await git(reconstructed, ["apply", "--cached", join(packet!.packetPath, "index.patch")]);
    await git(reconstructed, ["checkout-index", "--all", "--force"]);
    await git(reconstructed, ["apply", join(packet!.packetPath, "worktree.patch")]);
    expect(await gitText(reconstructed, ["show", "HEAD:tracked.txt"])).toBe("committed B\n");
    expect(await gitText(reconstructed, ["show", ":tracked.txt"])).toBe("staged C\n");
    expect(await readFile(join(reconstructed, "tracked.txt"), "utf8")).toBe("worktree C\n");
  });

  it("fails closed when an idempotently reused packet is missing a layer", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "changed\n");
    const packet = await capture(fixture);
    await unlink(join(packet!.packetPath, "worktree.patch"));

    await expect(capture(fixture)).rejects.toThrow(
      "handoff_packet_verification_failed",
    );
  });

  it("fails closed when an idempotently reused packet has a corrupted layer", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "changed\n");
    const packet = await capture(fixture);
    await writeFile(join(packet!.packetPath, "index.patch"), "corrupt\n");

    await expect(capture(fixture)).rejects.toThrow(
      "handoff_packet_verification_failed",
    );
  });

  it("fails closed when the workspace changes while an existing packet is reverified", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "state-a\n");
    await capture(fixture);
    await writeFile(join(fixture.workspace, "tracked.txt"), "state-b\n");
    await capture(fixture);
    await writeFile(join(fixture.workspace, "tracked.txt"), "state-a\n");

    let mutations = 0;
    await expect(materializeDurableCodexGoalHandoffPacket({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspace,
      durableRootDir: fixture.durableRoot,
      expectedBaseCommit: fixture.base,
      testHooks: {
        afterExistingPacketRead: async (attempt) => {
          mutations += 1;
          await writeFile(
            join(fixture.workspace, "tracked.txt"),
            attempt === 1 ? "state-b\n" : "state-a\n",
          );
        },
      },
    })).rejects.toThrow("handoff_workspace_changed_during_materialization");
    expect(mutations).toBe(2);
    expect(await readDirectoryNames(fixture.durableRoot)).toHaveLength(2);
  });

  it("binds packet identity and reuse to the worker job", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "changed\n");
    const first = await capture(fixture);
    const second = await materializeDurableCodexGoalHandoffPacket({
      workerJobId: "worker-2",
      taskId: "task-1",
      workspacePath: fixture.workspace,
      durableRootDir: fixture.durableRoot,
      expectedBaseCommit: fixture.base,
    });

    expect(second?.packetPath).not.toBe(first?.packetPath);
    expect(second?.manifest.workerJobId).toBe("worker-2");
    expect(await readDirectoryNames(fixture.durableRoot)).toHaveLength(2);
  });

  it("rejects a staged-only secret even when HEAD and worktree are safe", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.workspace, "mixed.txt"),
      "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz\n",
    );
    await git(fixture.workspace, ["add", "mixed.txt"]);
    await writeFile(join(fixture.workspace, "mixed.txt"), "safe worktree bytes\n");

    await expect(capture(fixture)).rejects.toThrow("handoff_raw_secret_rejected:mixed.txt");
    expect(await readDirectoryNames(fixture.durableRoot)).toEqual([]);
  });

  it("rejects a cancelled staged secret when the worktree exactly matches HEAD", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "mixed.txt"),
      "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz\n");
    await git(fixture.workspace, ["add", "mixed.txt"]);
    await writeFile(join(fixture.workspace, "mixed.txt"), "base\n");
    expect(await gitText(fixture.workspace, ["diff", "HEAD", "--"])).toBe("");
    await expect(capture(fixture)).rejects.toThrow("handoff_raw_secret_rejected:mixed.txt");
    expect(await readDirectoryNames(fixture.durableRoot)).toEqual([]);
  });

  it("enumerates and reconstructs cancelled safe staged and unstaged layers", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "mixed.txt"), "staged only\n");
    await git(fixture.workspace, ["add", "mixed.txt"]);
    await writeFile(join(fixture.workspace, "mixed.txt"), "base\n");
    expect(await gitText(fixture.workspace, ["diff", "HEAD", "--"])).toBe("");
    const packet = await capture(fixture);
    expect(packet?.changedPaths).toEqual(["mixed.txt"]);
    expect(packet?.manifest.layers.headRelative).toBeUndefined();
    const reconstructed = join(fixture.root, "cancelled-reconstructed");
    await git(fixture.root, ["clone", "--quiet", fixture.workspace, reconstructed]);
    await git(reconstructed, ["apply", "--cached", join(packet!.packetPath, "index.patch")]);
    await git(reconstructed, ["checkout-index", "--all", "--force"]);
    await git(reconstructed, ["apply", join(packet!.packetPath, "worktree.patch")]);
    expect(await gitText(reconstructed, ["show", ":mixed.txt"])).toBe("staged only\n");
    expect(await readFile(join(reconstructed, "mixed.txt"), "utf8")).toBe("base\n");
  });

  it("rejects secret-like branch and path metadata without echoing it", async () => {
    const branchSecret = `sk-${"b".repeat(24)}`;
    const branchFixture = await createFixture();
    await git(branchFixture.workspace, ["checkout", "-q", "-b", branchSecret]);
    await writeFile(join(branchFixture.workspace, "tracked.txt"), "changed\n");
    const branchFailure = await capture(branchFixture).catch((error) => error);
    expect(branchFailure).toMatchObject({
      message: "handoff_raw_secret_metadata_rejected:branch",
    });
    expect(String(branchFailure)).not.toContain(branchSecret);

    const pathSecret = `sk-${"p".repeat(24)}.txt`;
    const pathFixture = await createFixture();
    await writeFile(join(pathFixture.workspace, pathSecret), "safe bytes\n");
    const pathFailure = await capture(pathFixture).catch((error) => error);
    expect(pathFailure).toMatchObject({
      message: "handoff_raw_secret_metadata_rejected:untracked_path",
    });
    expect(String(pathFailure)).not.toContain(pathSecret);
  });

  it("quarantines a changed symlink without losing tracked or safe untracked output", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "tracked change\n");
    await symlink("/etc/passwd", join(fixture.workspace, "unsafe-link"));
    await writeFile(join(fixture.workspace, "safe.txt"), "safe\n");

    const packet = await capture(fixture);
    expect(packet?.manifest.layers.headRelative?.byteLength).toBeGreaterThan(0);
    expect(packet?.manifest.untracked.entries).toEqual([
      expect.objectContaining({ path: "safe.txt" }),
    ]);
    expect(packet?.manifest.quarantine.entries).toEqual([
      expect.objectContaining({ path: "unsafe-link", reason: "symlink" }),
    ]);
  });

  it("uses only read-only repository operations while publishing externally", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "read only git\n");
    const gitDir = join(fixture.workspace, ".git");
    const index = join(gitDir, "index");
    await chmod(gitDir, 0o555);
    await chmod(index, 0o444);
    try {
      const packet = await capture(fixture);
      expect(packet?.packetPath.startsWith(
        await realpath(fixture.durableRoot),
      )).toBe(true);
    } finally {
      await chmod(gitDir, 0o755);
      await chmod(index, 0o644);
    }
  });

  it("quarantines an untracked nested repository without outer tracked loss", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "outer change\n");
    const nested = join(fixture.workspace, "nested");
    await mkdir(nested);
    await git(nested, ["init", "--quiet"]);
    await writeFile(join(nested, "secret-target.txt"), "nested bytes\n");

    const packet = await capture(fixture);
    expect(packet?.manifest.layers.headRelative?.byteLength).toBeGreaterThan(0);
    expect(packet?.manifest.untracked.entries).toEqual([]);
    expect(packet?.manifest.quarantine.entries).toEqual([
      expect.objectContaining({ path: "nested", reason: "nested_repository" }),
    ]);
  });

  it("archives ustar prefix paths and quarantines unrepresentable names", async () => {
    const fixture = await createFixture();
    const directory = `generated-${"d".repeat(90)}`;
    const nestedPath = `${directory}/artifact.txt`;
    const longName = "n".repeat(101);
    await mkdir(join(fixture.workspace, directory));
    await writeFile(join(fixture.workspace, nestedPath), "nested output\n");
    await writeFile(join(fixture.workspace, longName), "long-name output\n");

    const packet = await capture(fixture);
    expect(packet?.manifest.untracked.entries).toEqual([
      expect.objectContaining({ path: nestedPath }),
    ]);
    expect(packet?.manifest.quarantine.entries).toContainEqual(
      expect.objectContaining({
        path: longName,
        reason: "archive_path_unrepresentable",
        byteLength: Buffer.byteLength("long-name output\n"),
        contentSha256: sha256("long-name output\n"),
      }),
    );
    const archive = packet!.artifacts.find(
      (artifact) => artifact.kind === "handoff_untracked_archive",
    )!.path!;
    const { stdout } = await execFileAsync("tar", ["-tf", archive]);
    expect(stdout.split("\n")).toContain(nestedPath);

    await writeFile(join(fixture.workspace, longName), "changed long output\n");
    const changed = await capture(fixture);
    expect(changed?.packetPath).not.toBe(packet?.packetPath);
    expect(changed?.manifest.quarantine.entries).toContainEqual(
      expect.objectContaining({
        path: longName,
        contentSha256: sha256("changed long output\n"),
      }),
    );
  });

  it("rejects a durable-root symlink without chmodding its target", async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, "durable-target");
    const link = join(fixture.root, "durable-link");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, link);

    await expect(materializeDurableCodexGoalHandoffPacket({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspace,
      durableRootDir: link,
      expectedBaseCommit: fixture.base,
    })).rejects.toThrow("handoff_durable_root_unsafe");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it("detects repeated same-path untracked mutation and publishes no packet", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "moving.txt"), "initial\n");
    await expect(materializeDurableCodexGoalHandoffPacket({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspace,
      durableRootDir: fixture.durableRoot,
      expectedBaseCommit: fixture.base,
      testHooks: {
        afterCapture: async (attempt) => {
          await writeFile(join(fixture.workspace, "moving.txt"), `mutation-${attempt}\n`);
        },
      },
    })).rejects.toThrow("handoff_workspace_changed_during_materialization");
    expect(await readDirectoryNames(fixture.durableRoot)).toEqual([]);
  });

  it("defaults the durable root under the job root and exposes packet SHA details", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "changed\n");
    const defaulted = await tryMaterializeTerminalCodexGoalHandoff({
      jobRootDir: fixture.root,
      taskId: "task-1",
      workspacePath: fixture.workspace,
      expectedBaseCommit: fixture.base,
    });
    expect(defaulted).toMatchObject({
      packetPath: expect.stringContaining(
        join(fixture.root, "durable-handoffs"),
      ),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const explicitlyInvalid = await tryMaterializeTerminalCodexGoalHandoff({
      jobRootDir: fixture.root,
      durableHandoffRootDir: " ",
      taskId: "task-1",
      workspacePath: fixture.workspace,
      expectedBaseCommit: fixture.base,
    });
    expect(explicitlyInvalid).toMatchObject({
      artifacts: [],
      errorCode: "handoff_durable_root_required",
    });

    await writeFile(join(fixture.workspace, "tracked.txt"), "changed again\n");
    const available = await tryMaterializeTerminalCodexGoalHandoff({
      jobRootDir: fixture.root,
      durableHandoffRootDir: fixture.durableRoot,
      taskId: "task-1",
      workspacePath: fixture.workspace,
      expectedBaseCommit: fixture.base,
    });
    const details = terminalCodexGoalHandoffResultDetails(available);
    expect(details).toMatchObject({
      handoffPacketPath: available.packetPath,
      handoffManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      handoffIndexSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      handoffWorktreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      handoffUntrackedArchiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(createHash("sha256").update(
      await readFile(join(available.packetPath!, "manifest.json"))
    ).digest("hex")).toBe(available.manifestSha256);
  });

  it("returns the actual retained packet through MCP after terminal capture fails", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "tracked.txt"), "pre-stop change\n");
    const retained = await capture(fixture);
    let stops = 0;
    const result = await withMcpErrors(async () => {
      await preserveTerminalHandoffBeforeStop({
        materialize: async () => (await capture(fixture))!,
        stop: async () => {
          stops++;
          // Synthetic fixture only: force the actual second capture to fail.
          await writeFile(join(fixture.workspace, ".env"), "test-only=value\n");
        },
      });
      throw new Error("unexpected success");
    });
    expect(stops).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: "handoff_sensitive_path_rejected",
      handoffPacketPath: retained!.packetPath,
      handoffManifestSha256: retained!.manifestSha256,
      handoffPacketProvenance: "PRE-STOP",
    });
    const manifestBytes = await readFile(join(retained!.packetPath, "manifest.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex"))
      .toBe(retained!.manifestSha256);
    expect(await readFile(join(retained!.packetPath, "worktree.patch"), "utf8"))
      .toContain("+pre-stop change");
  });

  it("does not invoke a stop function when durable materialization fails", async () => {
    let stopCalled = false;
    await expect(preserveTerminalHandoffBeforeStop({
      materialize: async () => ({
        artifacts: [],
        errorCode: "handoff_packet_verification_failed",
      }),
      stop: async () => {
        stopCalled = true;
      },
    })).rejects.toThrow("durable_handoff_materialization_failed");
    expect(stopCalled).toBe(false);
  });

  it("does not invoke a direct process killer for a dirty forced pause failure", async () => {
    const forcePause = true;
    let processKillerCalled = false;
    await expect(preserveTerminalHandoffBeforeStop({
      materialize: async () => ({
        artifacts: [],
        changedPaths: ["dirty.txt"],
        errorCode: "handoff_durable_root_required",
      }),
      stop: () => {
        processKillerCalled = true;
        return "terminated";
      },
    })).rejects.toThrow("durable_handoff_materialization_failed");
    expect(forcePause).toBe(true);
    expect(processKillerCalled).toBe(false);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "durable-handoff-test-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  const durableRoot = join(root, "durable");
  await mkdir(workspace);
  await mkdir(durableRoot);
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  await git(workspace, ["config", "user.name", "iliya"]);
  await git(workspace, ["config", "user.email", "iliyazelenkog@gmail.com"]);
  await writeFile(join(workspace, "mixed.txt"), "base\n");
  await writeFile(join(workspace, "tracked.txt"), "base\n");
  await git(workspace, ["add", "."]);
  expect(await gitText(workspace, ["var", "GIT_AUTHOR_IDENT"])).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
  expect(await gitText(workspace, ["var", "GIT_COMMITTER_IDENT"])).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
  await git(workspace, ["commit", "--quiet", "-m", "base"]);
  return { root, workspace, durableRoot, base: (await gitText(
    workspace, ["rev-parse", "HEAD"]
  )).trim() };
}

async function capture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: { readonly expectedHeadCommit?: string } = {},
) {
  return await materializeDurableCodexGoalHandoffPacket({
    workerJobId: "worker-1",
    taskId: "task-1",
    workspacePath: fixture.workspace,
    durableRootDir: fixture.durableRoot,
    expectedBaseCommit: fixture.base,
    ...options,
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function readDirectoryNames(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return await readdir(path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
