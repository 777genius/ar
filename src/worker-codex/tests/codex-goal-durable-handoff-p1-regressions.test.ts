import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { materializeDurableCodexGoalHandoffPacket } from
  "../codex-goal-durable-handoff-packet";

import { durableHandoffStopEvidence, preserveTerminalHandoffBeforeForcedStop } from "../codex-goal-preserve-before-stop";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("durable handoff P1 regressions", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("preserves A as base after committed B and reconstructs dirty C", async () => {
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

    const packet = await capture(fixture, head);
    expect(packet!.manifest.git).toMatchObject({
      base: fixture.base,
      head,
      headTree,
    });

    const reconstructed = join(fixture.root, "reconstructed");
    await git(fixture.root, ["clone", "--quiet", fixture.workspace, reconstructed]);
    await git(reconstructed, ["apply", "--cached", join(packet!.packetPath, "index.patch")]);
    await git(reconstructed, ["checkout-index", "--all", "--force"]);
    await git(reconstructed, ["apply", join(packet!.packetPath, "worktree.patch")]);
    expect(await gitText(reconstructed, ["show", "HEAD:tracked.txt"])).toBe("committed B\n");
    expect(await gitText(reconstructed, ["show", ":tracked.txt"])).toBe("staged C\n");
    expect(await readFile(join(reconstructed, "tracked.txt"), "utf8")).toBe("worktree C\n");
  });

  it.each(["error_result", "throw"] as const)(
    "retains the verified pre-stop packet when forced terminal capture fails (%s)",
    async (failureMode) => {
      const fixture = await dirtyFixture();
      let preStopPacket: Awaited<ReturnType<typeof capture>>;
      let stops = 0;
      const result = await preserveTerminalHandoffBeforeForcedStop({
        materialize: async () => {
          if (failureMode === "throw") {
            const packet = await capture(fixture);
            preStopPacket = packet;
            return packet!;
          }
          try {
            const packet = await capture(fixture);
            preStopPacket = packet;
            return packet!;
          } catch (error) {
            return { errorCode: (error as Error).message.split(":")[0] ?? "unknown" };
          }
        },
        stop: async () => {
          stops++;
          await writeFile(join(fixture.workspace, ".env"), "test-only=value\n");
          return "terminated";
        },
        forceAfterMaterializationFailure: true,
      });
      expect(stops).toBe(1);
      expect(result.stopResult).toBe("terminated");
      expect(result.preservationError).toContain("handoff_sensitive_path_rejected");
      expect(durableHandoffStopEvidence(result)).toMatchObject({
        handoffPacketPath: preStopPacket!.packetPath,
        handoffManifestSha256: preStopPacket!.manifestSha256,
        preservationDegraded: "true",
      });
      const bytes = await readFile(join(preStopPacket!.packetPath, "worktree.patch"), "utf8");
      expect(bytes).toContain("+changed");
      const manifestBytes = await readFile(join(preStopPacket!.packetPath, "manifest.json"));
      expect(createHash("sha256").update(manifestBytes).digest("hex"))
        .toBe(preStopPacket!.manifestSha256);
    },
  );

  it("rejects idempotent reuse with a missing referenced layer", async () => {
    const fixture = await dirtyFixture();
    const packet = await capture(fixture);
    await unlink(join(packet!.packetPath, "worktree.patch"));
    await expect(capture(fixture)).rejects.toThrow(
      "handoff_packet_verification_failed",
    );
  });

  it("rejects idempotent reuse with a corrupted referenced layer", async () => {
    const fixture = await dirtyFixture();
    const packet = await capture(fixture);
    await writeFile(join(packet!.packetPath, "index.patch"), "corrupt\n");
    await expect(capture(fixture)).rejects.toThrow(
      "handoff_packet_verification_failed",
    );
  });
});

async function dirtyFixture() {
  const fixture = await createFixture();
  await writeFile(join(fixture.workspace, "tracked.txt"), "changed\n");
  return fixture;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "durable-handoff-p1-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  const durableRoot = join(root, "durable");
  await mkdir(workspace);
  await mkdir(durableRoot);
  await git(workspace, ["init", "--quiet", "--initial-branch=main"]);
  await git(workspace, ["config", "user.name", "Test"]);
  await git(workspace, ["config", "user.email", "test@example.com"]);
  await writeFile(join(workspace, "tracked.txt"), "base\n");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "--quiet", "-m", "base"]);
  const base = (await gitText(workspace, ["rev-parse", "HEAD"])).trim();
  return { root, workspace, durableRoot, base };
}

async function capture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  expectedHeadCommit?: string,
) {
  return await materializeDurableCodexGoalHandoffPacket({
    workerJobId: "worker-1",
    taskId: "task-1",
    workspacePath: fixture.workspace,
    durableRootDir: fixture.durableRoot,
    expectedBaseCommit: fixture.base,
    ...(expectedHeadCommit ? { expectedHeadCommit } : {}),
  });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
