import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  applyConsumedOutputLedgerEpoch,
  buildConsumedOutputLedgerEpochPlan,
} from "../application/project-control/codex-goal-consumed-output-ledger-epoch";
import {
  readCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import { projectControlLedgerEpochMigrationView } from
  "../codex-goal-mcp-project-control-ledger-epoch";

describe("project control ledger epoch handler", () => {
  it("confirms a fresh preview under the actual publication locks", async () => {
    const fixture = await handlerFixture();
    const preview = await projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    );
    const planSha256 = String(preview.planSha256);

    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: planSha256,
      }),
      fixture.deps,
    )).resolves.toMatchObject({
      ok: true,
      receipt: { planSha256, status: "active" },
    });
  });

  it("resumes the immutable stored plan after the scope switch", async () => {
    const fixture = await handlerFixture();
    const plan = await fixture.seedScopeSwitched();

    const preview = await projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    );
    expect(preview).toMatchObject({
      ok: false,
      reason: "confirm_ledger_epoch_migration_required",
      planSha256: plan.planSha256,
    });

    const completed = await projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    );
    expect(completed).toMatchObject({
      ok: true,
      idempotentReplay: false,
      receipt: { planSha256: plan.planSha256, status: "active" },
    });
    await rm(join(fixture.oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER));
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).resolves.toMatchObject({ planSha256: plan.planSha256 });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).resolves.toMatchObject({ ok: true, idempotentReplay: true });
    await expect(stat(join(
      fixture.oldRoot,
      CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
    ))).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("denies a hash-valid stored plan owned by a stale controller scope", async () => {
    const fixture = await handlerFixture();
    const plan = await fixture.seedScopeSwitched();
    const { planSha256: _ignored, ...unsigned } = plan;
    const staleUnsigned = {
      ...unsigned,
      controllerStableScopeSha256: "f".repeat(64),
    };
    const stalePlan = { ...staleUnsigned, planSha256: sha256Json(staleUnsigned) };
    await writeFile(
      join(fixture.newRoot, "ledger-epoch-plan.json"),
      `${JSON.stringify(stalePlan, null, 2)}\n`,
    );
    for (const file of ["ledger-epoch-state.json", ".epoch-owner.json"]) {
      const path = join(fixture.newRoot, file);
      const value = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify({
        ...value,
        planSha256: stalePlan.planSha256,
      }, null, 2)}\n`);
    }

    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_persisted_plan_ownership_mismatch");
  });

  it("denies a new-root parent symlink that escapes canonical scope", async () => {
    const fixture = await handlerFixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ledger-epoch-outside-")));
    const alias = join(fixture.root, "outside-alias");
    await symlink(outside, alias);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({ newLedgerRoot: join(alias, "v2") }),
      fixture.deps,
    )).rejects.toThrow("project_control_consumed_output_ledger_root_outside_scope");
  });

  it("denies old and new roots that resolve to the same directory", async () => {
    const fixture = await handlerFixture();
    const alias = join(fixture.root, "old-root-alias");
    await symlink(fixture.oldRoot, alias);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({ newLedgerRoot: alias }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_symlink_denied");
  });

  it("rejects an already-switched scope without a prepared transaction", async () => {
    const fixture = await handlerFixture();
    await fixture.activateWithoutState();
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_prepared_state_required");
  });

  it("rejects a denied subtree nested inside the old ledger", async () => {
    const fixture = await handlerFixture();
    const denied = join(fixture.oldRoot, "private");
    await mkdir(denied, { recursive: true });
    await writeFile(join(denied, "secret.txt"), "must-not-copy\n");
    await fixture.setDeniedRoots([denied]);

    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_root_outside_canonical_scope");
  });

  it("allows a reserved denied path whose ancestors do not exist", async () => {
    const fixture = await handlerFixture();
    await fixture.setDeniedRoots([join(fixture.root, "future", "reserved")]);

    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).resolves.toMatchObject({
      ok: false,
      reason: "confirm_ledger_epoch_migration_required",
    });
  });
});

async function handlerFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ledger-epoch-handler-")));
  const registryRootDir = join(root, "registry");
  const controllerJobId = "social-monitor-controller-v4";
  const controllerJobRoot = join(registryRootDir, controllerJobId);
  const oldRoot = join(root, "ledgers", "v1");
  const newRoot = join(root, "ledgers", "v2");
  await mkdir(join(oldRoot, "items"), { recursive: true });
  await mkdir(controllerJobRoot, { recursive: true });
  await Promise.all([
    mkdir(join(root, "workspaces"), { recursive: true }),
    mkdir(join(root, "worktrees"), { recursive: true }),
    mkdir(join(root, "secrets"), { recursive: true }),
  ]);
  await writeFile(join(oldRoot, "items", "legacy.json"), "not-json\n");
  const scope: ProjectAccessScope = {
    projectId: "social-monitor",
    readRoots: [root],
    workspaceRoots: [join(root, "workspaces")],
    worktreeRoots: [join(root, "worktrees")],
    registryRoot: registryRootDir,
    deniedRoots: [join(root, "secrets")],
    jobIdPrefixes: ["social-monitor-"],
    tmuxSessionPrefixes: ["social-monitor-"],
    allowedAccountIds: ["account-a"],
    consumedOutputLedgerRoots: [oldRoot],
  };
  const manifest: CodexGoalJobManifest = {
    schemaVersion: 1,
    jobId: controllerJobId,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    jobRootDir: controllerJobRoot,
    workspacePath: join(root, "workspaces", "controller"),
    promptPath: join(controllerJobRoot, "prompt.md"),
    taskId: controllerJobId,
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: scope,
  };
  await writeFile(join(controllerJobRoot, "job.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const load = async () => {
    const controller = await readCodexGoalJob({ registryRootDir, jobId: controllerJobId });
    return { registryRootDir, controller, scope: controller.projectAccessScope! };
  };
  const cutoff = "2026-08-01T00:00:00.000Z";
  const seedScopeSwitched = async () => {
    const controller = (await load()).controller;
    const plan = await buildConsumedOutputLedgerEpochPlan({
      controllerJobId,
      projectId: "social-monitor",
      oldRoot,
      newRoot,
      cutoff,
      currentJobIds: new Set([controllerJobId]),
      evidenceRoots: [root, oldRoot],
      controllerManifestSha256: sha256Json(controller),
      controllerStableScopeSha256: stableControllerFingerprint(controller),
    });
    let activeRoot = oldRoot;
    await expect(applyConsumedOutputLedgerEpoch({
      plan,
      expectedPlanSha256: plan.planSha256,
      buildCurrentPlan: async () => plan,
      admissionBefore: { debtCount: 1, counts: { consumedDirtyWorkspaces: 0 } },
      validateProposedAdmission: async () => ({
        debtCount: 1,
        counts: {
          consumedDirtyWorkspaces: 0,
          legacyOutputQuarantineRequired: 1,
        },
      }),
      admissionForNewRoot: async () => ({ debtCount: 1 }),
      switchScope: async () => {
        activeRoot = newRoot;
        await updateCodexGoalJob({
          registryRootDir,
          jobId: controllerJobId,
          patch: { projectAccessScope: { ...scope, consumedOutputLedgerRoots: [newRoot] } },
        });
      },
      readActiveRoot: async () => activeRoot,
      revalidatePostSwitchBindings: async () => undefined,
      crashAfterPhase: "scope_switched",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_scope_switched");
    return plan;
  };
  const activateWithoutState = async () => {
    await mkdir(newRoot, { recursive: true });
    await updateCodexGoalJob({
      registryRootDir,
      jobId: controllerJobId,
      patch: { projectAccessScope: { ...scope, consumedOutputLedgerRoots: [newRoot] } },
    });
  };
  const setDeniedRoots = async (deniedRoots: readonly string[]) => {
    const current = await load();
    await updateCodexGoalJob({
      registryRootDir,
      jobId: controllerJobId,
      patch: {
        projectAccessScope: {
          ...current.scope,
          deniedRoots,
        },
      },
    });
  };
  return {
    root,
    oldRoot,
    newRoot,
    seedScopeSwitched,
    activateWithoutState,
    setDeniedRoots,
    args: (extra: Record<string, unknown> = {}) => ({
      registryRootDir,
      controllerJobId,
      oldLedgerRoot: oldRoot,
      newLedgerRoot: newRoot,
      ledgerEpochCutoff: cutoff,
      ...extra,
    }),
    deps: {
      loadProjectControlController: async () => await load(),
      admissionDeps: { listJobs: async () => [], buildOverviewItems: async () => [] },
      assertNoLegacyWriterProcesses: async () => undefined,
    },
  };
}

function stableControllerFingerprint(manifest: CodexGoalJobManifest): string {
  const projectAccessScope = manifest.projectAccessScope
    ? { ...manifest.projectAccessScope, consumedOutputLedgerRoots: undefined }
    : undefined;
  return sha256Json({ ...manifest, updatedAt: undefined, projectAccessScope });
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
