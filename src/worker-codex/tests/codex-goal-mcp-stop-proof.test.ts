import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountLeaseStore } from "@vioxen/subscription-runtime/store-local-file";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { codexAccountCapacityRootDir } from "../application/codex-account-capacity-store";
import { callToolJson, removeStoredTmuxSession } from "./codex-goal-mcp-test-support";

const exec = promisify(execFile);

// Actual MCP transport, Git workspace, durable packet and lease/receipt files.
// Only the OS process/tmux observations and process signaling are synthetic.
describe("public MCP scoped stop proof", () => {
  it.each([
    ["absent", false, false], ["absent", true, false],
    ["race", false, false], ["race", true, false],
    ["absent", true, true], ["race", true, true],
    ["dead", false, false], ["live", false, false],
    ["race-live", false, false], ["tmux", false, false],
    ["foreign", false, false], ["dead", true, true], ["tmux", true, true],
  ] as const)("%s force=%s materializationFailure=%s", async (mode, force, degraded) => {
    await fixture(mode, async (f) => {
      if (degraded) await writeFile(join(f.workspace, ".env"), "fixture-only=value\n");
      const progressBefore = await readFile(f.progress);
      const resultBefore = await readFile(f.result);
      const receiptBefore = await readFile(f.receipt);
      const leaseName = (await readdir(join(f.leaseRoot, "worker-account-leases", "records"))).find((name) => name.endsWith(".json"))!;
      const leasePath = join(f.leaseRoot, "worker-account-leases", "records", leaseName);
      const leaseBefore = await readFile(leasePath);
      const kill = vi.spyOn(process, "kill");
      // Signal simulation must update the synthetic table, without touching real processes.
      kill.mockImplementation((pid, signal) => {
        expect([pid, signal]).toEqual([987654, "SIGTERM"]);
        f.markTerminated();
        return true;
      });
      try {
        const response = await callToolJson(f.client, "codex_goal_project_stop", {
          registryRootDir: f.registry, controllerJobId: "proof-controller",
          jobId: "proof-child", confirmStop: true, forceStop: force,
        });
        const calls = await readFile(`${f.state}.calls`, "utf8");
        const unknown = mode === "absent" || mode === "race";
        if (unknown || mode === "foreign") {
          expect(response).toMatchObject({ ok: false });
          if (unknown) expect(String(response.error)).toContain("worker_process_observation_unavailable");
          expect(await readFile(f.progress)).toEqual(progressBefore);
          expect(await readFile(f.result)).toEqual(resultBefore);
          expect(await readFile(f.receipt)).toEqual(receiptBefore);
          expect(await readFile(leasePath)).toEqual(leaseBefore);
          expect(kill).not.toHaveBeenCalled();
          await expect(readFile(join(f.job, "proof-child.stop-event.json"))).rejects.toMatchObject({ code: "ENOENT" });
          if (!degraded && unknown) {
            expect(response.handoffPacketPath).toEqual(expect.any(String));
            const bytes = await readFile(join(String(response.handoffPacketPath), "manifest.json"));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(response.handoffManifestSha256);
            expect(await readFile(join(String(response.handoffPacketPath), "worktree.patch"), "utf8")).toContain("+dirty");
          }
          expect(calls.split("\n").filter((line) => line.startsWith("tmux kill-session"))).toHaveLength(mode === "race" ? 1 : 0);
          // Both table and direct-pid ps observations actually failed in the unknown paths.
          if (unknown) expect(calls).toContain("ps -p 987654");
        } else {
          expect(response).toMatchObject({ ok: true, accountReservationReleased: true });
          if (degraded) expect(response).toMatchObject({ preservationDegraded: true });
          expect(JSON.parse(await readFile(f.progress, "utf8"))).toMatchObject({ status: "stopped" });
          await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
          expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({ state: "released" });
          if (mode === "live" || mode === "race-live") expect(kill).toHaveBeenCalledOnce();
          else expect(kill).not.toHaveBeenCalled();
          if (mode === "dead") expect(String(response.result && (response.result as Record<string, unknown>).resourceId)).not.toContain("tmux kill-session");
        }
      } finally { kill.mockRestore(); }
    });
  });

  it.each(["dead", "live"])("direct known %s termination releases capacity", async (mode) => {
    await fixture(mode, async (f) => {
      await removeStoredTmuxSession(f.registry, "proof-child");
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect([pid, signal]).toEqual([987654, "SIGTERM"]);
        f.markTerminated();
        return true;
      });
      try {
        const response = await callToolJson(f.client, "codex_goal_project_stop", {
          registryRootDir: f.registry, controllerJobId: "proof-controller", jobId: "proof-child",
          confirmStop: true, forceStop: true,
        });
        expect(response).toMatchObject({ ok: true, accountReservationReleased: true });
        await expect(readFile(f.receipt)).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.parse(await readFile(f.progress, "utf8"))).toMatchObject({ status: "stopped" });
        if (mode === "live") expect(kill).toHaveBeenCalledOnce();
        else expect(kill).not.toHaveBeenCalled();
      } finally { kill.mockRestore(); }
    });
  });

  it("direct process unknown observation also retains custody", async () => {
    await fixture("absent", async (f) => {
      await removeStoredTmuxSession(f.registry, "proof-child");
      const before = await readFile(f.receipt);
      const response = await callToolJson(f.client, "codex_goal_project_stop", {
        registryRootDir: f.registry, controllerJobId: "proof-controller", jobId: "proof-child",
        confirmStop: true, forceStop: true,
      });
      expect(response).toMatchObject({ ok: false, error: "worker_process_observation_unavailable" });
      expect(await readFile(f.receipt)).toEqual(before);
      expect(JSON.parse(await readFile(f.progress, "utf8"))).toMatchObject({ status: "running" });
    });
  });
});

import { readFileSync, writeFileSync } from "node:fs";
async function fixture(mode: string, action: (f: {
  client: Client; registry: string; workspace: string; job: string;
  progress: string; result: string; receipt: string; leaseRoot: string; state: string;
  markTerminated: () => void;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pr135-proof-"));
  const registry = join(root, "registry");
  const workspace = join(root, "worktrees", "proof-child");
  const job = join(root, "jobs", "proof-child");
  const auth = join(root, "auth");
  const bin = join(root, "bin");
  const state = join(root, "host-state.json");
  const envKeys = ["PATH", "PR135_SYNTHETIC_STATE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "SUBSCRIPTION_RUNTIME_TMUX_PATH"] as const;
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "stop-proof", version: "1" });
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(bin); await mkdir(auth); await mkdir(job, { recursive: true });
    for (const kind of ["ps", "tmux"]) {
      const helper = resolve("src/worker-codex/tests/codex-goal-stop-synthetic-host.ts");
      await writeFile(join(bin, kind), `#!/bin/sh\nexec '${process.execPath}' '${helper}' '${kind}' "$@"\n`, { mode: 0o700 });
    }
    await symlink("/usr/bin/git", join(bin, "git"));
    await writeFile(state, JSON.stringify({ mode, stopped: false, psReads: 0 }));
    process.env.PATH = bin;
    process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = join(bin, "tmux");
    process.env.PR135_SYNTHETIC_STATE = state;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    await exec("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "base\n");
    await exec("git", ["add", "."], { cwd: workspace });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "dirty\n");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const controllerRoot = join(root, "workspaces", "proof-controller");
    await mkdir(controllerRoot, { recursive: true });
    expect(await callToolJson(client, "codex_goal_create_job", {
      registryRootDir: registry, jobId: "proof-controller", jobRootDir: join(root, "jobs", "proof-controller"),
      authRootDir: auth, workspacePath: controllerRoot, promptPath: join(root, "controller.md"),
      taskId: "proof-controller", accounts: ["account-a"], accessBoundary: AccessBoundary.ProjectScopedControl,
      networkAccess: NetworkAccessMode.Restricted, projectAccessScope: {
        projectId: "proof", workspaceRoots: [join(root, "workspaces")], worktreeRoots: [join(root, "worktrees")],
        registryRoot: registry, jobIdPrefixes: ["proof-"], tmuxSessionPrefixes: ["proof-"], allowedAccountIds: ["account-a"],
      },
    })).toMatchObject({ ok: true });
    const created = await callToolJson(client, "codex_goal_project_create_job", {
      registryRootDir: registry, controllerJobId: "proof-controller", jobId: "proof-child", jobRootDir: job,
      authRootDir: auth, workspacePath: workspace, promptPath: join(job, "prompt.md"), taskId: "proof-child",
      accounts: ["account-a"], tmuxSession: "proof-session", workerRole: "reviewer", confirmCreate: true,
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const progress = join(job, "proof-child.progress.json");
    const result = join(job, "proof-child.latest-result.json");
    await writeFile(progress, JSON.stringify({ schemaVersion: 1, taskId: "proof-child", status: "running", pid: 987654, updatedAt: "2020-01-01T00:00:00Z" }));
    await writeFile(result, JSON.stringify({ status: "running", task: { updatedAt: "2020-01-01T00:00:00Z" }, fixture: "retain these bytes" }));
    const capacityRoot = codexAccountCapacityRootDir(auth);
    const leaseRoot = join(dirname(dirname(capacityRoot)), ".subscription-runtime-account-leases", basename(capacityRoot));
    const acquired = await new LocalFileWorkerAccountLeaseStore({ rootDir: leaseRoot }).acquire({
      accountId: "account-a", ownerId: "proof-child", ttlMs: 600_000, now: new Date(),
    });
    if (acquired.status !== "granted") throw new Error("fixture lease denied");
    const receipt = join(job, "account-reservation.json");
    await writeFile(receipt, JSON.stringify({ schemaVersion: 1, accountId: "account-a", leaseId: acquired.lease.leaseId,
      fencingToken: acquired.lease.fencingToken, acquiredAt: acquired.lease.acquiredAt.toISOString(), expiresAt: acquired.lease.expiresAt.toISOString() }));
    await action({ client, registry, workspace, job, progress, result, receipt, leaseRoot, state,
      markTerminated: () => { const s = JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown>; s.stopped = true; s.terminated = true; writeFileSync(state, JSON.stringify(s)); },
    });
  } finally {
    await client.close(); await server.close();
    for (const key of envKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    await rm(root, { recursive: true, force: true });
  }
}
