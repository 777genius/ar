import { defaultHostDiskUsagePort } from "../application/project-control/adapters/host-command-adapters";
import { bindControllerStateLocation, controllerStateLocationForRelocation } from "../application/project-control/codex-goal-controller-state-location";
import { resolveCanonicalRemoteWorktreeSource } from "../application/project-control/codex-goal-project-git";
import { ledgerEpochProcessBlocks } from "../application/project-control/codex-goal-ledger-epoch-process-guard";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessBoundary, NetworkAccessMode, ProjectOperation, ProjectAdmissionWorkerRole, ProjectDebtReason,
  evaluateProjectAdmission } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { withLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";
import { readCodexGoalJob, listCodexGoalJobs, createCodexGoalJob, updateCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { codexGoalManifestRevision } from "../codex-goal-job-manifest-revision";
import { projectControlRelocateControllerWorkspaceView as relocate, type ControllerRelocationDeps } from "../codex-goal-mcp-project-controller-relocation";
import { assertControllerRelocationIdle, assertControllerRelocationWorkerStopped } from "../application/project-control/codex-goal-controller-relocation-idle";
import { projectControlWorkspaceLocks } from "../codex-goal-project-workspace-lock";
import { controllerScopeLockIdentity } from "../codex-goal-mcp-project-control-ledger-epoch";
import { projectControllerStartView } from "../codex-goal-mcp-project-controller";
import { buildCodexProjectAdmissionSnapshot } from "../application/project-control/codex-goal-project-admission";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(controllerIdentity = { jobId: "test-controller", createdAt: "2026-09-08T00:00:00.000Z" }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-controller-relocation-")));
  roots.push(root);
  const registryRootDir = join(root, "registry");
  const workspaces = join(root, "workspaces");
  const old = join(workspaces, "review");
  const target = join(workspaces, "controller");
  for (const path of [old, target]) {
    await mkdir(path, { recursive: true });
    await exec("git", ["init", "-q", path]);
    await exec("git", ["-C", path, "-c", "user.name=TEST", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "TEST fixture"]);
  }
  const scope = { projectId: "TEST", workspaceRoots: [workspaces], worktreeRoots: [],
    jobIdPrefixes: ["test-", controllerIdentity.jobId], allowedGitRemotes: [], registryRoot: registryRootDir };
  const writeManifest = async (id: string, workspacePath: string) => {
    const jobRootDir = join(root, "runtime", id);
    if (id !== controllerIdentity.jobId) await mkdir(jobRootDir, { recursive: true });
    await mkdir(join(registryRootDir, id), { recursive: true });
    const manifest: CodexGoalJobManifest = { schemaVersion: 1, jobId: id, taskId: id,
      createdAt: controllerIdentity.createdAt, updatedAt: "2026-09-08T00:00:00.000Z",
      workspacePath, jobRootDir, networkAccess: NetworkAccessMode.Restricted, promptPath: join(jobRootDir, "prompt.md"), accounts: ["TEST-unused-account"],
      accessBoundary: id === controllerIdentity.jobId ? AccessBoundary.ProjectScopedControl : AccessBoundary.ReadOnly,
      ...(id === controllerIdentity.jobId ? {} : { tags: ["worker-role-reviewer"] }), projectAccessScope: scope };
    if (id === controllerIdentity.jobId) await createCodexGoalJob({ registryRootDir, manifest });
    await writeFile(join(registryRootDir, id, "job.json"), JSON.stringify({ ...manifest, retainedUnknown: { keep: true } }, null, 2) + "\n");
    return await readCodexGoalJob({ registryRootDir, jobId: id });
  };
  const controller = await writeManifest(controllerIdentity.jobId, old);
  await writeManifest("test-review", old);
  const manifestPath = join(registryRootDir, controller.jobId, "job.json");
  const deps: ControllerRelocationDeps = {
    loadProjectControlController: async () => ({ registryRootDir,
      controller: await readCodexGoalJob({ registryRootDir, jobId: controller.jobId }), scope }),
    assertNoHostedControllers: () => {}, evidenceCustody: new LocalProjectControlEvidenceCustody(),
    // Read only fixture status/state; the host process inventory is a port.
    assertIdle: async input => await assertControllerRelocationIdle(input, { assertNoProcesses: async () => {} }),
  };
  const args = { registryRootDir, controllerJobId: controller.jobId, workspacePath: target,
    expectedWorkspacePath: old, expectedManifestSha256: await codexGoalManifestRevision(manifestPath), confirmRelocate: true };
  return { root, registryRootDir, old, target, scope, controller, manifestPath, deps, args, writeManifest };
}

describe("idle controller workspace relocation", () => {
  it("requires explicit confirmation and preserves exact manifest fields and accepted records", async () => {
    const f = await fixture();
    const original = await readFile(f.manifestPath, "utf8");
    const retained = join(f.controller.jobRootDir, "accepted-review.json");
    await writeFile(retained, '{"accepted":true}\n');
    expect(await relocate({ ...f.args, confirmRelocate: false }, f.deps)).toMatchObject({ ok: false, reason: "confirm_relocate_required" });
    expect(await readFile(f.manifestPath, "utf8")).toBe(original);
    const result = await relocate(f.args, f.deps);
    expect(result).toMatchObject({ ok: true, applied: true });
    const after = JSON.parse(await readFile(f.manifestPath, "utf8"));
    expect(after).toEqual({ ...JSON.parse(original), workspacePath: f.target, updatedAt: after.updatedAt });
    expect(await readFile(retained, "utf8")).toBe('{"accepted":true}\n');
    const prepared = JSON.parse(await readFile(result.preparedAuditPath as string, "utf8"));
    const applied = JSON.parse(await readFile(result.appliedAuditPath as string, "utf8"));
    expect(prepared.before.manifestSha256).toBe(f.args.expectedManifestSha256);
    expect(applied.after.manifestSha256).toBe(await codexGoalManifestRevision(f.manifestPath));
    expect(prepared.operationId).toBe(applied.operationId);
    expect((await listCodexGoalJobs({ registryRootDir: f.registryRootDir })).length).toBe(2);
    expect((await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "test-review" })).workspacePath).toBe(f.old);
  });

  it("keeps producer admission blocked until the actual proposed relocation removes duplicate realpaths", async () => {
    // This relocation test controls disk observations; production disk admission
    // and its separate capacity tests retain the real policy.
    const disk = vi.spyOn(defaultHostDiskUsagePort, "availableBytes").mockResolvedValue(64 * 1024 ** 3);
    try {
    const f = await fixture();
    const snapshot = async () => await buildCodexProjectAdmissionSnapshot({
      registryRootDir: f.registryRootDir, scope: f.scope, controllerJobId: f.controller.jobId,
      requestedWorkspacePath: f.target,
      deps: { listJobs: listCodexGoalJobs, readJob: readCodexGoalJob,
        buildOverviewItems: async inputs => await Promise.all(inputs.map(async input => {
          const manifest = await readCodexGoalJob(input);
          return { ok: true, jobId: manifest.jobId, workspacePath: manifest.workspacePath,
            workspaceDirty: false, workerAlive: false, resultStatus: "completed",
            lifecycleMarkerTypes: ["review"], activeWriterRisk: "none" };
        })),
      },
    });
    const before = await snapshot();
    expect(before.debt.filter(item => item.reason === ProjectDebtReason.ActiveWriterConflict)).toHaveLength(2);
    const request = { projectId: "TEST", operation: ProjectOperation.CreateWorktree,
      workerRole: ProjectAdmissionWorkerRole.Producer, workspacePath: f.target };
    expect(evaluateProjectAdmission({ request, snapshot: before }).allowed).toBe(false);
    await relocate({ ...f.args, confirmRelocate: false }, f.deps);
    expect(evaluateProjectAdmission({ request, snapshot: await snapshot() }).allowed).toBe(false);
    await relocate(f.args, f.deps);
    const after = await snapshot();
    expect(after.debt).toEqual([]);
    expect(evaluateProjectAdmission({ request, snapshot: after }).allowed).toBe(true);
    } finally { disk.mockRestore(); }
  });

  it.each([1, 2])("retains audit and reports commit truth when audit publication %i fails", async failAt => {
    const f = await fixture();
    const custody = new LocalProjectControlEvidenceCustody();
    let calls = 0;
    const broken = Object.assign(Object.create(custody) as LocalProjectControlEvidenceCustody, {
      publishImmutableBytes: async (input: Parameters<LocalProjectControlEvidenceCustody["publishImmutableBytes"]>[0]) => {
        if (++calls === failAt) throw new Error("TEST-audit-unavailable");
        return await custody.publishImmutableBytes(input);
      },
    });
    if (failAt === 1) {
      await expect(relocate(f.args, { ...f.deps, evidenceCustody: broken })).rejects.toThrow("TEST-audit-unavailable");
      expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
    } else {
      const result = await relocate(f.args, { ...f.deps, evidenceCustody: broken });
      expect(result).toMatchObject({ applied: true, reason: "controller_relocation_applied_audit_pending" });
      expect(JSON.parse(await readFile(result.preparedAuditPath as string, "utf8")).after.manifestSha256)
        .toBe(await codexGoalManifestRevision(f.manifestPath));
      await expect(relocate(f.args, f.deps)).rejects.toThrow("controller_relocation_manifest_cas_mismatch");
    }
  });

  it("retains deny-all remote semantics and requires an explicitly authorized exact remote", () => {
    const scope = { projectId: "TEST", allowedBranches: ["main"], allowedGitRemotes: [] };
    expect(() => resolveCanonicalRemoteWorktreeSource({ requestedRef: "main", scope }))
      .toThrow("project_control_canonical_remote_ambiguous");
    expect(() => resolveCanonicalRemoteWorktreeSource({ requestedRef: "origin/main", scope }))
      .toThrow("remote_denied");
    expect(resolveCanonicalRemoteWorktreeSource({ requestedRef: "trusted/main",
      scope: { ...scope, allowedGitRemotes: ["trusted"] } }))
      .toEqual({ remoteTrackingRef: "trusted/main", worktreeSourceRef: "main" });
  });

  it("rejects an untracked process using an involved workspace", async () => {
    const f = await fixture();
    const selector = { registryRootDir: f.registryRootDir, controllerJobId: f.controller.jobId,
      ledgerRoot: f.controller.jobRootDir, selfPid: 1, workspacePaths: [f.old, f.target] };
    const snapshot = { pid: 2, startTime: "TEST", argv: ["unregistered-worker"],
      executablePath: "/TEST/unregistered-worker", cwd: f.target, cgroup: "TEST" };
    expect(ledgerEpochProcessBlocks(snapshot, selector)).toBe(true);
    expect(ledgerEpochProcessBlocks({ ...snapshot, cwd: `${f.target}-sibling` }, selector)).toBe(false);
  });

  it.each(["running", "stale", "completed", "unknown"])("rejects controlled run %s with no proven stopped owner", async status => {
    const f = await fixture();
    const runId = "TEST-run";
    const path = join(f.controller.jobRootDir, "controlled-agent", "controlled-agent", "runs",
      createHash("sha256").update(runId).digest("hex"));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "run.json"), JSON.stringify({ schemaVersion: 1, runId,
      sessionId: "TEST-session", controllerJobId: f.controller.jobId, providerKind: "codex", status,
      startedAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" }));
    await expect(relocate(f.args, f.deps)).rejects.toThrow();
  });

  it("observes the manifest's explicit progress path instead of treating missing default progress as idle", async () => {
    const f = await fixture();
    const progressPath = join(f.root, "custom-progress.json");
    await writeFile(progressPath, JSON.stringify({ status: "running", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const manifest = JSON.parse(await readFile(f.manifestPath, "utf8"));
    await writeFile(f.manifestPath, JSON.stringify({ ...manifest, progressPath }));
    f.args.expectedManifestSha256 = await codexGoalManifestRevision(f.manifestPath);
    await expect(relocate(f.args, f.deps)).rejects.toThrow("controller_relocation_worker_stale_or_unknown");
  });

  it.each(["running", "unknown", "malformed"])("rejects persisted %s worker evidence", async status => {
    const f = await fixture();
    await writeFile(join(f.controller.jobRootDir, `${f.controller.taskId}.progress.json`),
      status === "malformed" ? "{" : JSON.stringify({ status, updatedAt: "2000-01-01T00:00:00.000Z" }));
    await expect(relocate(f.args, f.deps)).rejects.toThrow();
  });

  it.each(["duplicate", "outside", "symlink", "dirty", "drift"])("rejects %s target or precondition", async kind => {
    const f = await fixture();
    if (kind === "duplicate") await f.writeManifest("test-collision", f.target);
    if (kind === "outside" || kind === "symlink") {
      const outside = join(f.root, "outside"); await mkdir(outside);
      if (kind === "symlink") { const link = join(f.old, "escape"); await symlink(outside, link); f.args.workspacePath = link; }
      else f.args.workspacePath = outside;
    }
    if (kind === "dirty") await writeFile(join(f.target, "dirty"), "dirty");
    if (kind === "drift") await writeFile(f.manifestPath, (await readFile(f.manifestPath, "utf8")) + " ");
    const before = await readFile(f.manifestPath, "utf8");
    await expect(relocate(f.args, f.deps)).rejects.toThrow();
    expect(await readFile(f.manifestPath, "utf8")).toBe(before);
  });

  it.each(["controller", "old", "new"])("rejects %s lock contention", async kind => {
    const f = await fixture(); const locks = projectControlWorkspaceLocks(f.registryRootDir);
    const lease = await locks.acquire({ workspacePath: kind === "controller" ? controllerScopeLockIdentity(f.registryRootDir, f.controller.jobId) : kind === "old" ? f.old : f.target, owner: "TEST-contention" });
    try { await expect(relocate(f.args, f.deps)).rejects.toThrow(); }
    finally { await locks.release(lease); }
  });

  it("serializes actual start and update with relocation using separate registry and job roots", async () => {
    const f = await fixture();
    let checked = false;
    await relocate(f.args, { ...f.deps, assertIdle: async () => {
      checked = true;
      await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir,
        manifest: { ...f.controller, jobId: "test-racing-create", accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          projectAccessScope: { ...f.scope, isolatedWorkspaceRoot: f.target, workspaceRoots: [f.target] },
          workspacePath: f.target } })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.controller.jobId, patch: { description: "race" } })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      await expect(projectControllerStartView(f.args, {
        loadProjectControlController: f.deps.loadProjectControlController,
        runtimeVersion: "TEST", providerRegistry: { get: () => undefined, set: () => {}, delete: () => {} },
        providerRuntimeRegistry: { get: () => { throw new Error("provider must not be reached"); } } as never,
      })).rejects.toThrow("controller_maintenance_fence_active");
    } });
    expect(checked).toBe(true);
  });

  it("rejects a start loaded before relocation even after the maintenance fence is released", async () => {
    const f = await fixture();
    const observed = await f.deps.loadProjectControlController(f.args);
    let markLoaded!: () => void;
    let resume!: () => void;
    const loaded = new Promise<void>(resolve => { markLoaded = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let calls = 0;
    const starting = projectControllerStartView(f.args, {
      loadProjectControlController: async () => {
        if (++calls === 1) { markLoaded(); await resumed; return observed; }
        return await f.deps.loadProjectControlController(f.args);
      },
      runtimeVersion: "TEST", providerRegistry: { get: () => undefined, set: () => {}, delete: () => {} },
      providerRuntimeRegistry: { get: () => { throw new Error("provider must not be reached"); } } as never,
    });
    await loaded;
    await relocate(f.args, f.deps);
    resume();
    await expect(starting).rejects.toThrow("controller_start_manifest_drift");
  });

  it("rejects relocation while a start activity is already held", async () => {
    const f = await fixture();
    await withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST-start", effect: async () => {
      await expect(relocate(f.args, f.deps)).rejects.toThrow("controller_maintenance_activity_active");
    } });
  });

  it("revalidates manifest drift after publishing the prepared audit", async () => {
    const f = await fixture(); const custody = new LocalProjectControlEvidenceCustody();
    let calls = 0;
    await expect(relocate(f.args, { ...f.deps, assertIdle: async () => {
      if (++calls === 2) await writeFile(f.manifestPath, (await readFile(f.manifestPath, "utf8")) + " ");
    }, evidenceCustody: custody })).rejects.toThrow("controller_relocation_manifest_cas_mismatch");
  });

  it.each([
    { progressExists: true, progressStatus: "completed", progressProcessAlive: true },
    { progressExists: true, progressStatus: "running", progressHeartbeatAgeMs: 999999 },
    { progressExists: true, progressStatus: "unknown" },
    { progressExists: true, progressStatus: "stopped", progressPid: 123 },
    { progressExists: false, appServerProcessPid: 123 },
    { progressExists: false, workloadProcessPid: 123 },
  ])("rejects live, stale, or unknown worker facts %j", status => {
    expect(() => assertControllerRelocationWorkerStopped({ ...status, warnings: [], recommendedAction: "inspect_failure" }, () => { throw new Error("TEST indeterminate process probe"); })).toThrow();
  });
  it("accepts a never-run controller from explicit absent progress evidence", () => {
    expect(() => assertControllerRelocationWorkerStopped({ progressExists: false, warnings: [], recommendedAction: "start_worker" })).not.toThrow();
  });
});

it("completed reviewer with proven exited PID remains eligible", async () => {
  const f = await fixture();
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  const review = await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "test-review" });
  await writeFile(join(review.jobRootDir, `${review.taskId}.progress.json`), JSON.stringify({
    schemaVersion: 1, taskId: review.taskId, status: "completed", pid, updatedAt: new Date().toISOString()
  }));
  const { collectCodexGoalStatus } = await import("../codex-goal-ops");
  const facts = await collectCodexGoalStatus({ jobRootDir: review.jobRootDir, taskId: review.taskId });
  console.log("dead-pid facts", JSON.stringify({ pid, progressPid: facts.progressPid, alive: facts.progressProcessAlive, status: facts.progressStatus, warnings: facts.warnings }));
  await expect(relocate(f.args, f.deps)).resolves.toMatchObject({ ok: true, applied: true });
});

it("rejects stale controlled state at a supported custom stateDir", async () => {
  const f = await fixture();
  await rm(join(f.controller.jobRootDir, ".controller-state-origin.json"));
  const { projectControllerState } = await import("../application/project-control/codex-goal-project-controller-profile");
  const { ControlledAgentRunStatus, RunEventProviderKind } = await import("../../worker-core/index");
  const state = projectControllerState({ cwd: f.root, stateDir: join(f.root, "custom-state") },
    { controller: f.controller }, { get: () => ({ controllerProfile: () => ({ sessionId: () => "TEST-custom-session" }) }) } as never);
  await state.store.saveRun({ schemaVersion: 1, runId: "TEST-custom-run", sessionId: state.sessionId,
    controllerJobId: f.controller.jobId, providerKind: RunEventProviderKind.Codex,
    status: ControlledAgentRunStatus.Running, startedAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" });
  expect((await state.store.readRun("TEST-custom-run"))?.status).toBe(ControlledAgentRunStatus.Running);
  await expect(relocate(f.args, f.deps)).rejects.toThrow();
});

it("releases every lease after a prepared-audit failure so a legitimate retry can succeed", async () => {
  const f = await fixture();
  const custody = new LocalProjectControlEvidenceCustody();
  const broken = Object.assign(Object.create(custody), { publishImmutableBytes: async () => { throw new Error("TEST audit failure"); } });
  await expect(relocate(f.args, { ...f.deps, evidenceCustody: broken })).rejects.toThrow("TEST audit failure");
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
  await expect(relocate(f.args, f.deps)).resolves.toMatchObject({ ok: true, applied: true });
});

it("rejects a target symlink rebound while prepared audit publication awaits", async () => {
  const f = await fixture();
  const custody = new LocalProjectControlEvidenceCustody();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const { rename } = await import("node:fs/promises");
  const swapping = Object.assign(Object.create(custody), {
    publishImmutableBytes: async (input: Parameters<LocalProjectControlEvidenceCustody["publishImmutableBytes"]>[0]) => {
      const receipt = await custody.publishImmutableBytes(input);
      await rename(f.target, f.target + "-saved");
      await symlink(outside, f.target);
      return receipt;
    },
  });
  await expect(relocate(f.args, { ...f.deps, evidenceCustody: swapping })).rejects.toThrow();
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
});

it.each(["EPERM", "EACCES", "EIO", undefined])("rejects indeterminate PID probe %s even if display says absent", code => {
  const status = { progressPid: 123, progressProcessAlive: false, progressStatus: "completed", warnings: [] };
  expect(() => assertControllerRelocationWorkerStopped(status as never, () => { throw Object.assign(new Error("unknown"), { code }); })).toThrow("worker_unknown");
});
it("rejects an actually live PID despite an absent display fact", () => {
  expect(() => assertControllerRelocationWorkerStopped({ progressPid: process.pid, progressProcessAlive: false, progressStatus: "completed", warnings: [] } as never)).toThrow("worker_live");
});
it("inspects durable custom state and retains its bytes on rejection", async () => {
  const f = await fixture();
  const custom = join(f.root, "custom-state");
  await withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST", effect: () => bindControllerStateLocation(f.controller, custom) });
  const { LocalControlledAgentStateStore } = await import("@vioxen/subscription-runtime/store-local-file");
  const { ControlledAgentRunStatus, ControlledAgentProcessOwnerKind, RunEventProviderKind } = await import("@vioxen/subscription-runtime/worker-core");
  const store = new LocalControlledAgentStateStore({ rootDir: custom });
  const run: import("@vioxen/subscription-runtime/worker-core").ControlledAgentRun = { schemaVersion: 1 as const, runId: "TEST-custom", sessionId: "TEST-session", controllerJobId: f.controller.jobId, providerKind: RunEventProviderKind.Codex, status: ControlledAgentRunStatus.Running, startedAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" };
  await store.saveRun(run);
  await expect(relocate(f.args, f.deps)).rejects.toThrow("run_not_stopped");
  expect(await store.readRun(run.runId)).toEqual(run);
  await store.saveRun({ ...run, status: ControlledAgentRunStatus.Completed });
  await expect(relocate(f.args, f.deps)).rejects.toThrow("owner_unknown");
  const { hostname } = await import("node:os");
  await store.saveRun({ ...run, status: ControlledAgentRunStatus.Completed, owner: { schemaVersion: 1, ownerId: "TEST-owner", kind: ControlledAgentProcessOwnerKind.Sdk, startedAt: run.startedAt, heartbeatAt: run.updatedAt, hostname: hostname(), pid: process.pid } });
  await expect(relocate(f.args, f.deps)).rejects.toThrow("owner_live");
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
});
it("does not upgrade unknown legacy history by binding a new location", async () => {
  const f = await fixture();
  await rm(join(f.controller.jobRootDir, ".controller-state-origin.json"));
  await withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST", effect: () => bindControllerStateLocation(f.controller, join(f.root, "custom")) });
  await expect(relocate(f.args, f.deps)).rejects.toThrow("state_location_unknown");
});
it("arbitrates concurrent custom location bindings without losing either history", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled(["one", "two"].map(name => withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST", effect: () => bindControllerStateLocation(f.controller, join(f.root, name)) })));
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  expect([join(f.root, "one"), join(f.root, "two")]).toContain(await controllerStateLocationForRelocation(f.controller));
});
it("fails closed if the bound custom location disappears or becomes a symlink", async () => {
  const f = await fixture();
  const custom = join(f.root, "custom");
  await withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST", effect: () => bindControllerStateLocation(f.controller, custom) });
  await rm(custom, { recursive: true });
  await expect(relocate(f.args, f.deps)).rejects.toThrow();
  await symlink(f.old, custom);
  await expect(relocate(f.args, f.deps)).rejects.toThrow("state_location_unknown");
});

it("rejected pure preflight holds activity lease without consuming a state directory", async () => {
  const f = await fixture();
  const custom = join(f.root, "custom-start");
  const launchModule = await import("../codex-goal-mcp-launch-input");
  const { acquireLocalControllerMaintenanceFence } = await import("@vioxen/subscription-runtime/store-local-file");
  const launch = vi.spyOn(launchModule, "goalLaunchInput").mockImplementation(async () => {
    expect(await controllerStateLocationForRelocation(f.controller)).toBeUndefined();
    await expect(acquireLocalControllerMaintenanceFence({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST" })).rejects.toThrow("activity_active");
    throw new Error("TEST stop before any provider launch");
  });
  try {
    const deps = {
      loadProjectControlController: f.deps.loadProjectControlController,
      runtimeVersion: "TEST", providerRegistry: {} as never,
      providerRuntimeRegistry: { get: () => ({ controllerProfile: () => ({
        sessionId: () => "TEST-session", enforcement: {
          providerKind: "codex", canRestrictToolSurface: true, canDisableRawShell: true,
          canEnforceFilesystemSandbox: true, canIsolateHome: true, canIsolateTemp: true, canRestrictNetwork: true,
        },
      }) }) } as never,
    };
    for (const stateDir of [custom, join(f.root, "corrected-start")]) {
      await expect(projectControllerStartView({ ...f.args, stateDir }, deps)).rejects.toThrow("TEST stop before any provider launch");
    }
    expect(launch).toHaveBeenCalledTimes(2);
    expect(await controllerStateLocationForRelocation(f.controller)).toBeUndefined();
  } finally { launch.mockRestore(); }
});
it("an existing runtime root at creation cannot certify never-started history", async () => {
  const f = await fixture();
  const jobId = "test-legacy-root";
  const jobRootDir = join(f.root, "existing-runtime");
  await mkdir(jobRootDir);
  const created = await createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: { ...f.controller, jobId, jobRootDir } });
  await expect(controllerStateLocationForRelocation(created)).rejects.toThrow("state_location_unknown");
});

it("retains the immutable location after uncertain provider effects and rejects another path", async () => {
  const f = await fixture();
  const custom = join(f.root, "provider-state");
  const launchModule = await import("../codex-goal-mcp-launch-input");
  const providerModule = await import("../codex-goal-mcp-project-controller-provider");
  const launch = vi.spyOn(launchModule, "goalLaunchInput").mockResolvedValue({} as never);
  const provider = vi.spyOn(providerModule, "projectControllerProvider").mockImplementation(async () => {
    expect(await controllerStateLocationForRelocation(f.controller)).toBe(custom);
    await expect(relocate(f.args, f.deps)).rejects.toThrow("activity_active");
    throw new Error("TEST uncertain provider effect");
  });
  const deps = {
    loadProjectControlController: f.deps.loadProjectControlController,
    runtimeVersion: "TEST", providerRegistry: {} as never,
    providerRuntimeRegistry: { get: () => ({ controllerProfile: () => ({
      sessionId: () => "TEST-session", enforcement: {
        providerKind: "codex", canRestrictToolSurface: true, canDisableRawShell: true,
        canEnforceFilesystemSandbox: true, canIsolateHome: true, canIsolateTemp: true, canRestrictNetwork: true,
      },
    }) }) } as never,
  };
  try {
    await expect(projectControllerStartView({ ...f.args, stateDir: custom }, deps)).rejects.toThrow("TEST uncertain provider effect");
    await expect(projectControllerStartView({ ...f.args, stateDir: join(f.root, "other-state") }, deps)).rejects.toThrow("state_location_conflict");
    expect(provider).toHaveBeenCalledOnce();
    expect(await controllerStateLocationForRelocation(f.controller)).toBe(custom);
    expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
  } finally { launch.mockRestore(); provider.mockRestore(); }
});

async function legacyAttestationFixture(identity?: { jobId: string; createdAt: string }) {
  const f = await fixture(identity);
  await rm(join(f.controller.jobRootDir, ".controller-state-origin.json"));
  const attestation = {
    operatorIdentity: "TEST host administrator", assertedAt: new Date().toISOString(),
    controllerJobId: f.controller.jobId, controllerCreatedAt: f.controller.createdAt,
    manifestSha256: f.args.expectedManifestSha256,
    scopeSha256: createHash("sha256").update(JSON.stringify(f.scope)).digest("hex"),
    registryRootDir: f.registryRootDir, jobRootDir: await realpath(f.controller.jobRootDir),
    sourceWorkspacePath: f.old, destinationWorkspacePath: f.target,
    confirmation: "I attest complete never-run controller history through this relocation maintenance fence" as const,
    historyCompleteFromCreationThroughThisMaintenanceFence: true as const,
    noControllerProviderOrWorkerExecution: true as const,
    coversDefaultCustomDirectAndAlternateHostLaunches: true as const,
    coversStateMovementAndDeletion: true as const,
    distinguishesBrokerChildWorkersFromControllerExecution: true as const,
    evidence: [{ reference: "TEST fixture construction history", sha256: createHash("sha256").update("TEST fixture construction history").digest("hex") }],
  };
  return { ...f, attestation, attestedArgs: { ...f.args, historicalNeverRunAttestation: attestation } };
}

it("accepts explicit TEST legacy never-run history in immutable custody without fabricating origin", async () => {
  const f = await legacyAttestationFixture();
  await expect(relocate(f.args, f.deps)).rejects.toThrow("state_location_unknown");
  const before = JSON.parse(await readFile(f.manifestPath, "utf8"));
  const result = await relocate(f.attestedArgs, f.deps);
  expect(result).toMatchObject({ applied: true });
  const after = JSON.parse(await readFile(f.manifestPath, "utf8"));
  expect({ ...after, workspacePath: before.workspacePath, updatedAt: before.updatedAt }).toEqual(before);
  const { dirname } = await import("node:path");
  const receipt = JSON.parse(await readFile(join(dirname(result.preparedAuditPath as string), "historical-attestation.json"), "utf8"));
  expect(receipt.attestation).toEqual(f.attestation);
  expect(receipt.before.manifestSha256).toBe(f.args.expectedManifestSha256);
  expect(receipt.after.manifestSha256).toBe(result.manifestSha256);
  await expect(readFile(join(f.controller.jobRootDir, ".controller-state-origin.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(relocate(f.attestedArgs, f.deps)).rejects.toThrow();
});

it.each(["controllerJobId", "controllerCreatedAt", "manifestSha256", "scopeSha256", "registryRootDir", "jobRootDir", "sourceWorkspacePath", "destinationWorkspacePath", "confirmation"])("rejects legacy assertion drift in %s", async field => {
  const f = await legacyAttestationFixture();
  const bad = { ...f.attestation, [field]: field.endsWith("Sha256") ? "0".repeat(64) : field === "controllerCreatedAt" ? "2000-01-01T00:00:00.000Z" : "wrong" };
  await expect(relocate({ ...f.attestedArgs, historicalNeverRunAttestation: bad }, f.deps)).rejects.toThrow();
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
});

it("requires explicit relocation confirmation and complete attributable history", async () => {
  const f = await legacyAttestationFixture();
  await expect(relocate({ ...f.attestedArgs, confirmRelocate: false }, f.deps)).rejects.toThrow("confirmation_required");
  for (const field of ["operatorIdentity", "evidence", "coversDefaultCustomDirectAndAlternateHostLaunches", "coversStateMovementAndDeletion", "historyCompleteFromCreationThroughThisMaintenanceFence"]) {
    const bad = { ...f.attestation } as Record<string, unknown>;
    delete bad[field];
    await expect(relocate({ ...f.args, historicalNeverRunAttestation: bad as never }, f.deps)).rejects.toThrow();
  }
});

it("never-run assertion cannot override a custom binding or concurrent start lease", async () => {
  const f = await legacyAttestationFixture();
  await withLocalControllerActivityLease({ controllerJobRootDir: f.controller.jobRootDir, owner: "TEST", effect: async () => {
    await expect(relocate(f.attestedArgs, f.deps)).rejects.toThrow("activity_active");
    await bindControllerStateLocation(f.controller, join(f.root, "custom"));
  } });
  await expect(relocate(f.attestedArgs, f.deps)).rejects.toThrow("history_conflict");
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
});


it("relocates the captured legacy controller identity only with explicit TEST administrator history", async () => {
  // Identity transcribed from retained read-only controller-manifest.json.
  // Paths, scope, evidence and asserted history are exclusively TEST fixtures.
  const f = await legacyAttestationFixture({ jobId: "ar-assembly-secondary-controller", createdAt: "2026-09-08T16:43:44.734Z" });
  const events = join(f.controller.jobRootDir, `${f.controller.jobId}.project-control-events.jsonl`);
  const retained = '{"TEST":"broker decision is not execution history"}\n';
  await writeFile(events, retained);
  await expect(relocate(f.args, f.deps)).rejects.toThrow("state_location_unknown");
  await expect(relocate(f.attestedArgs, f.deps)).resolves.toMatchObject({ applied: true });
  expect(await readFile(events, "utf8")).toBe(retained);
});

it.each(["live", "unknown", "stale", "malformed-state", "custom-state", "dirty", "collision"])("legacy assertion cannot override %s facts", async kind => {
  const f = await legacyAttestationFixture();
  if (kind === "dirty") await writeFile(join(f.target, "untracked"), "TEST");
  if (kind === "collision") await f.writeManifest("test-collision", f.target);
  if (kind === "malformed-state") {
    const dir = join(f.controller.jobRootDir, "controlled-agent", "controlled-agent", "runs", "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), "malformed TEST");
  }
  if (kind === "custom-state") {
    await writeFile(join(f.controller.jobRootDir, ".controller-state-location.json"), '{"stateDir":"unknown"}');
  }
  const deps = ["live", "unknown", "stale"].includes(kind) ? {
    ...f.deps,
    assertIdle: async (input: Parameters<typeof assertControllerRelocationIdle>[0]) => assertControllerRelocationIdle(input, {
      assertNoProcesses: async () => {},
      collectStatus: async () => ({
        progressExists: kind === "stale", progressStatus: "running",
        progressPid: kind === "live" ? process.pid : undefined,
        warnings: kind === "unknown" ? ["TEST observation unknown"] : [],
      }) as never,
    }),
  } : f.deps;
  await expect(relocate(f.attestedArgs, deps)).rejects.toThrow();
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
});

it("revalidates legacy history after immutable receipt publication and retains the receipt on rejection", async () => {
  const f = await legacyAttestationFixture();
  const custody = new LocalProjectControlEvidenceCustody();
  let receiptPath: string | undefined;
  const deps = { ...f.deps, evidenceCustody: {
    ...custody,
    publishImmutableBytes: async (input: Parameters<typeof custody.publishImmutableBytes>[0]) => {
      const result = await custody.publishImmutableBytes(input);
      if (input.fileName === "historical-attestation.json") {
        receiptPath = result.path;
        // Simulate an out-of-band legacy write across an awaited audit boundary.
        await writeFile(join(f.controller.jobRootDir, ".controller-state-location.json"), "{}");
      }
      return result;
    },
  } as typeof custody };
  await expect(relocate(f.attestedArgs, deps)).rejects.toThrow("history_conflict");
  expect(await codexGoalManifestRevision(f.manifestPath)).toBe(f.args.expectedManifestSha256);
  expect(JSON.parse(await readFile(receiptPath!, "utf8")).attestation).toEqual(f.attestation);
});

it("legacy assertion rejects dangling custom metadata symlinks instead of treating them as absent", async () => {
  const f = await legacyAttestationFixture();
  await symlink(join(f.root, "missing"), join(f.controller.jobRootDir, ".controller-state-location.json"));
  await expect(relocate(f.attestedArgs, f.deps)).rejects.toThrow("state_location_unknown");
});

it("managed admission failure leaves state unbound and a corrected retry binds only after admission", async () => {
  const f = await fixture();
  const launchModule = await import("../codex-goal-mcp-launch-input");
  const providerModule = await import("../codex-goal-mcp-project-controller-provider");
  const admissionModule = await import("../hosted-readonly-controller-admission");
  const authRoot = join(f.root, "synthetic-auth-scope");
  const launch = vi.spyOn(launchModule, "goalLaunchInput").mockResolvedValue({ config: {
    authRootDir: authRoot, jobId: f.controller.jobId, jobRootDir: f.controller.jobRootDir,
    workspacePath: f.old,
  } } as never);
  const admission = vi.spyOn(admissionModule, "admitHostedControllerLaunch").mockRejectedValue(new Error("TEST missing managed policy"));
  const provider = vi.spyOn(providerModule, "projectControllerProvider").mockRejectedValue(new Error("TEST provider boundary reached"));
  const deps = {
    loadProjectControlController: async () => ({ ...await f.deps.loadProjectControlController(f.args), scope: { ...f.scope, authRoot } }),
    runtimeVersion: "TEST", providerRegistry: {} as never,
    providerRuntimeRegistry: { get: () => ({ controllerProfile: () => ({
      kind: "codex", sessionId: () => "TEST-session", enforcement: {
        providerKind: "codex", canRestrictToolSurface: true, canDisableRawShell: true,
        canEnforceFilesystemSandbox: true, canIsolateHome: true, canIsolateTemp: true, canRestrictNetwork: true,
      },
    }) }) } as never,
  };
  try {
    await expect(projectControllerStartView({ ...f.args, stateDir: join(f.root, "first") }, deps)).rejects.toThrow("missing managed policy");
    expect(await controllerStateLocationForRelocation(f.controller)).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    admission.mockImplementation(async () => {
      expect(await controllerStateLocationForRelocation(f.controller)).toBeUndefined();
      return {} as never;
    });
    const corrected = join(f.root, "corrected");
    await expect(projectControllerStartView({ ...f.args, stateDir: corrected }, deps)).rejects.toThrow("provider boundary reached");
    expect(await controllerStateLocationForRelocation(f.controller)).toBe(corrected);
    expect(provider).toHaveBeenCalledOnce();
  } finally { launch.mockRestore(); admission.mockRestore(); provider.mockRestore(); }
});
