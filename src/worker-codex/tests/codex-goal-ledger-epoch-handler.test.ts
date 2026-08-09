import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AccessBoundary,
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  NetworkAccessMode,
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  applyConsumedOutputLedgerEpoch,
  buildConsumedOutputLedgerEpochPlan,
} from "../application/project-control/codex-goal-consumed-output-ledger-epoch";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  LocalConsumedOutputLedgerMutationLock,
  LocalConsumedOutputLedgerWriter,
  LocalWorkspaceIntegrationLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "@vioxen/subscription-runtime/worker-local";
import {
  readCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import { projectControlLedgerEpochMigrationView } from
  "../codex-goal-mcp-project-control-ledger-epoch";
import {
  seedAuthenticD0aPreparedEpochV1,
  seedLegacyAdmissionHandlerFixture,
  prepareAuthenticD0aFixture,
} from
  "./codex-goal-ledger-epoch-legacy-admission-fixture";
import { buildLedgerEpochLegacyAdmissionAnchor } from
  "../application/project-control/codex-goal-ledger-epoch-legacy-admission";

const realHandlerUpgradeCrashBoundaries = [
  ...Array.from({ length: 205 }, (_, index) =>
    `source-orphan-${String(index).padStart(4, "0")}.json`
  ),
  "plan.json",
  "owner.json",
  "state.json",
  "receipt.json",
  "final-sidecar",
  "intent",
];

await prepareAuthenticD0aFixture();
const productionFixture = await handlerFixture(495);
const productionPreview = await projectControlLedgerEpochMigrationView(
  productionFixture.args(),
  productionFixture.deps,
);
const productionPlan = await productionFixture.seedPreparedV1();
await productionFixture.freezePreparedV1Baseline();
const sharedBoundaryFixture = await handlerFixture(495, true);
const sharedBoundaryPlan = await sharedBoundaryFixture.seedPreparedV1();
await sharedBoundaryFixture.freezePreparedV1Baseline();

describe("project control ledger epoch handler", () => {
  it("anchors the exact production-shaped 495/205/6/4 legacy envelope", async () => {
    expect(productionPreview).toMatchObject({
      legacyAdmission: {
        debtCount: 710,
        blockingDebtCount: 710,
      },
    });
  });

  it("upgrades and activates the exact-710 prepared v1 plan through the real handler", async () => {
    const fixture = productionFixture;
    const plan = productionPlan;
    await fixture.resetPreparedV1Baseline();
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).resolves.toMatchObject({
      planSha256: plan.planSha256,
      upgradeRequired: true,
    });
    const activated = await projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    );
    expect(activated).toMatchObject({
      ok: true,
      receipt: {
        planSha256: plan.planSha256,
        admissionAfter: { debtCount: 414 },
      },
    });
  });

  it("allows exact-710 post-admission output, normal jobs and replay", async () => {
    const fixture = productionFixture;
    const plan = productionPlan;
    const normalStatusPath = join(fixture.root, "normal-new-job.status");
    await writeFile(normalStatusPath, "");
    const normalDecision = {
      schemaVersion: 1 as const,
      jobId: "social-monitor-normal-new-job",
      status: "failed_no_output" as const,
      closedAt: "2026-08-08T00:00:00.000Z",
      failure: { category: "test", code: "test" },
      output: { authoredChanges: false, workspaceDirty: false },
      note: "normal post-admission terminal job",
      backup: { workspace: fixture.root, statusPath: normalStatusPath },
    };
    const writer = new LocalConsumedOutputLedgerWriter();
    await expect(writer.record({
      ledgerRoot: fixture.oldRoot,
      decision: normalDecision,
    })).rejects.toThrow("consumed_output_ledger_root_retired");
    await expect(writer.record({
      ledgerRoot: fixture.newRoot,
      decision: normalDecision,
    })).resolves.toMatchObject({ decision: { jobId: normalDecision.jobId } });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).resolves.toMatchObject({ ok: true, idempotentReplay: true });
  });

  it("allows unrelated process hash and PID-count churn with clear custody", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    fixture.setProcessInventorySequence([
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
    ]);
    fixture.setInspectedPidCountSequence([3, 4, 2, 5]);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).resolves.toMatchObject({
      ok: true,
      receipt: { planSha256: plan.planSha256, status: "active" },
    });
  });

  it("refuses a custody blocker appearing after locks without changing target bytes", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    const before = await fixture.oldScopeBytes();
    fixture.setProcessBlockerFromCapture(2);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_process_inventory_drift");
    expect(await fixture.oldScopeBytes()).toEqual(before);
  });

  it("refuses when the writer guard passes then fails without changing target bytes", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    const before = await fixture.oldScopeBytes();
    fixture.setWriterGuardFailureAt(2);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_writer_process_active");
    expect(await fixture.oldScopeBytes()).toEqual(before);
  });

  it("releases both ledger roots and every upper lock when first release detects drift", async () => {
    const fixture = await handlerFixture(495, true);
    const plan = await fixture.seedPreparedV1();
    const original = `${fixture.newRoot}-release-probe-original`;
    fixture.setCaptureMutationAt(3, async () => {
      await rename(fixture.newRoot, original);
      await cp(original, fixture.newRoot, { recursive: true });
    });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_target_root_identity_drift");

    await rm(fixture.newRoot, { recursive: true });
    await rename(original, fixture.newRoot);
    fixture.setCaptureMutationAt(3, async () => undefined);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).resolves.toMatchObject({
      ok: true,
      receipt: { planSha256: plan.planSha256, status: "active" },
    });
  });

  it("releases a mutation lock when root identity drifts after acquisition", async () => {
    const probeRoot = await mkdtemp(join(tmpdir(), "ledger-acquire-drift-"));
    const ledgerRoot = join(probeRoot, "ledger");
    const originalRoot = join(probeRoot, "ledger-original");
    await mkdir(ledgerRoot);
    const originalAcquire = LocalWorkspaceIntegrationLock.prototype.acquire;
    const acquireSpy = vi.spyOn(
      LocalWorkspaceIntegrationLock.prototype,
      "acquire",
    ).mockImplementation(async function (
      this: LocalWorkspaceIntegrationLock,
      input,
    ) {
      const lock = await originalAcquire.call(this, input);
      await rename(ledgerRoot, originalRoot);
      await cp(originalRoot, ledgerRoot, { recursive: true });
      return lock;
    });
    const mutationLocks = new LocalConsumedOutputLedgerMutationLock();
    try {
      await expect(mutationLocks.acquire({
        ledgerRoots: [ledgerRoot],
        owner: "acquire-drift-probe",
      })).rejects.toThrow("consumed_output_ledger_root_identity_drift");
      acquireSpy.mockRestore();
      await rm(ledgerRoot, { recursive: true });
      await rename(originalRoot, ledgerRoot);

      const retry = await mutationLocks.acquire({
        ledgerRoots: [ledgerRoot],
        owner: "acquire-drift-retry",
      });
      await mutationLocks.release(retry);
    } finally {
      acquireSpy.mockRestore();
      await rm(probeRoot, { recursive: true, force: true });
    }
  });

  it("refuses an exact-710 registry manifest remap before any scope bytes change", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    const oldScopeBytes = await fixture.oldScopeBytes();
    fixture.setCaptureMutation(async () => {
      await fixture.remapJobManifest("legacy-consumed-0");
    });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_debt_custody_drift");
    const after = await fixture.oldScopeBytes();
    expect(after.controller).toEqual(oldScopeBytes.controller);
    expect(after.oldRoot).toEqual(oldScopeBytes.oldRoot);
    expect(after.newRoot).toEqual(oldScopeBytes.newRoot);
    expect((await fixture.load()).scope.consumedOutputLedgerRoots).toEqual([
      fixture.oldRoot,
    ]);
  });

  it("refuses exact-710 workspace alias-map drift before any scope bytes change", async () => {
    const fixture = await handlerFixture(495);
    const alias = await fixture.aliasJobManifest("legacy-consumed-0");
    const plan = await fixture.seedPreparedV1();
    const oldScopeBytes = await fixture.oldScopeBytes();
    fixture.setCaptureMutation(async () => {
      await rm(alias.path);
      await symlink(alias.replacement, alias.path, "dir");
    });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_debt_custody_drift");
    expect(await fixture.oldScopeBytes()).toEqual(oldScopeBytes);
  });

  describe("exact-710 monotonic public-handler crash chain", () => {
    for (const [index, crashAfter] of realHandlerUpgradeCrashBoundaries.entries()) {
      it(`resumes cursor ${index} then crashes after ${crashAfter}`, async () => {
        if (index === 0) {
          await sharedBoundaryFixture.resetPreparedV1Baseline();
        }
        const request = sharedBoundaryFixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: sharedBoundaryPlan.planSha256,
        });
        sharedBoundaryFixture.setUpgradeCrashAfter(crashAfter);
        await expect(projectControlLedgerEpochMigrationView(
          request,
          { ...sharedBoundaryFixture.deps },
        ), crashAfter).rejects.toThrow(
          `ledger_epoch_simulated_upgrade_crash:${crashAfter}`,
        );
      });
    }
    it("performs one final fresh activation and replay", async () => {
      const request = sharedBoundaryFixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: sharedBoundaryPlan.planSha256,
      });
      sharedBoundaryFixture.setUpgradeCrashAfter(undefined);
      await expect(projectControlLedgerEpochMigrationView(
        request,
        { ...sharedBoundaryFixture.deps },
      )).resolves.toMatchObject({
        ok: true,
        receipt: { planSha256: sharedBoundaryPlan.planSha256, status: "active" },
      });
      await expect(projectControlLedgerEpochMigrationView(
        request,
        { ...sharedBoundaryFixture.deps },
      )).resolves.toMatchObject({ ok: true, idempotentReplay: true });
    });
  });

  it("refuses a partial exact-710 final sidecar through the real handler", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    await mkdir(join(fixture.newRoot, ".ledger-epoch-v2-sidecar"));
    await writeFile(join(
      fixture.newRoot,
      ".ledger-epoch-v2-sidecar",
      "intent.json",
    ), "{}\n");
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      { ...fixture.deps },
    )).rejects.toThrow("ledger_epoch_upgrade_sidecar_partial");
    expect((await fixture.load()).scope.consumedOutputLedgerRoots).toEqual([
      fixture.oldRoot,
    ]);
  });

  describe("conflicting exact-710 final sidecar", () => {
    it("captures the valid final-sidecar-before-intent boundary", async () => {
      await sharedBoundaryFixture.resetPreparedV1Baseline();
      sharedBoundaryFixture.setUpgradeCrashAfter("final-sidecar");
      await expect(projectControlLedgerEpochMigrationView(
        sharedBoundaryFixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: sharedBoundaryPlan.planSha256,
        }),
        { ...sharedBoundaryFixture.deps },
      )).rejects.toThrow("ledger_epoch_simulated_upgrade_crash:final-sidecar");
    });

    it("refuses conflicting bytes through a fresh real handler", async () => {
      const manifestPath = join(
        sharedBoundaryFixture.newRoot,
        ".ledger-epoch-v2-sidecar",
        "manifest.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as
        Record<string, unknown>;
      await writeFile(manifestPath, `${JSON.stringify({
        ...manifest,
        processEvidence: { inventorySha256: "f".repeat(64) },
      }, null, 2)}\n`);
      sharedBoundaryFixture.setUpgradeCrashAfter(undefined);
      await expect(projectControlLedgerEpochMigrationView(
        sharedBoundaryFixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: sharedBoundaryPlan.planSha256,
        }),
        { ...sharedBoundaryFixture.deps },
      )).rejects.toThrow("ledger_epoch_upgrade_sidecar_hash_mismatch");
      expect((await sharedBoundaryFixture.load()).scope.consumedOutputLedgerRoots)
        .toEqual([sharedBoundaryFixture.oldRoot]);
    });
  });

  it.each([
    ".ledger-epoch-intent.json",
    "ledger-epoch-plan.json",
    ".epoch-owner.json",
    "ledger-epoch-state.json",
    "ledger-epoch-receipt.json",
  ])("refuses exact-710 v1 %s mutation before switching scope", async (name) => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    fixture.setCaptureMutation(async () => {
      await writeFile(join(fixture.newRoot, name), "mutated\n");
    });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow();
    expect((await fixture.load()).scope.consumedOutputLedgerRoots).toEqual([
      fixture.oldRoot,
    ]);
  });

  it("refuses exact-710 v1 target replacement before switching scope", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    fixture.setCaptureMutation(async () => {
      const original = `${fixture.newRoot}-original`;
      await rename(fixture.newRoot, original);
      await cp(original, fixture.newRoot, { recursive: true });
    });
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: plan.planSha256,
      }),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_target_root_identity_drift");
  });

  it("refuses exact-710 v1 maintenance contention with fresh handler dependencies", async () => {
    const fixture = await handlerFixture(495);
    const plan = await fixture.seedPreparedV1();
    const competing = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: fixture.oldRoot,
      owner: "competing-ledger-epoch",
    });
    try {
      await expect(projectControlLedgerEpochMigrationView(
        fixture.args({
          confirmLedgerEpochMigration: true,
          expectedLedgerEpochPlanSha256: plan.planSha256,
        }),
        fixture.deps,
      )).rejects.toThrow("consumed_output_ledger_maintenance_locked");
    } finally {
      await releaseConsumedOutputLedgerMaintenanceLock(competing);
    }
  });

  it.each([494, 496])("refuses a %i-item legacy admission near miss", async (count) => {
    const fixture = await handlerFixture(count);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_legacy_admission_exact_count_mismatch");
  });

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

async function handlerFixture(
  legacyConsumedCount?: number,
  fastOrphanBoundaries = false,
) {
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
    mkdir(join(root, "workspaces", "controller"), { recursive: true }),
    mkdir(join(root, "worktrees"), { recursive: true }),
    mkdir(join(root, "secrets"), { recursive: true }),
  ]);
  const admissionSnapshot = legacyConsumedCount === undefined
    ? undefined
    : await seedLegacyAdmissionHandlerFixture({
        root,
        oldRoot,
        consumedCount: legacyConsumedCount,
        fastOrphanBoundaries,
      });
  if (!admissionSnapshot) {
    await writeFile(join(oldRoot, "items", "legacy.json"), "not-json\n");
  }
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
  const seedPreparedV1 = async () => {
    if (!admissionSnapshot) throw new Error("legacy fixture required");
    const controller = (await load()).controller;
    return await seedAuthenticD0aPreparedEpochV1({
      root,
      oldRoot,
      newRoot,
      controllerJobId,
      cutoff,
      orphanWorkspacePaths: admissionSnapshot.debt
        .filter((item) => item.reason === ProjectDebtReason.OrphanLegacyWorkspace)
        .map((item) => item.subject),
      controllerManifestSha256: sha256Json(controller),
      controllerStableScopeSha256: stableControllerFingerprint(controller),
    }) as unknown as ConsumedOutputLedgerEpochPlan;
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
  let processInventorySha = "a".repeat(64);
  let processInventorySequence: string[] = [];
  let inspectedPidCountSequence: number[] = [];
  let processBlockerFromCapture = Number.POSITIVE_INFINITY;
  let writerGuardCount = 0;
  let writerGuardFailureAt = Number.POSITIVE_INFINITY;
  let captureCount = 0;
  let captureMutationAt = 2;
  let captureMutation: (() => Promise<void>) | undefined;
  let upgradeCrashAfter: string | undefined;
  const postAdmissionCount = fastOrphanBoundaries ? 209 : 414;
  let preparedBaselineRoot: string | undefined;
  let preparedBaselineController: Buffer | undefined;
  return {
    root,
    oldRoot,
    newRoot,
    oldScopeBytes: async () => ({
      controller: await exactTreeBytes(controllerJobRoot),
      oldRoot: await exactTreeBytes(oldRoot),
      newRoot: await exactTreeBytes(newRoot),
    }),
    remapJobManifest: async (jobId: string) => {
      const path = join(registryRootDir, jobId, "job.json");
      const current = JSON.parse(await readFile(path, "utf8")) as
        Record<string, unknown>;
      const remapped = join(root, "workspaces", `${jobId}-remapped`);
      await mkdir(remapped, { recursive: true });
      await writeFile(path, `${JSON.stringify({
        ...current,
        workspacePath: remapped,
      }, null, 2)}\n`);
    },
    aliasJobManifest: async (jobId: string) => {
      const manifestPath = join(registryRootDir, jobId, "job.json");
      const current = JSON.parse(await readFile(manifestPath, "utf8")) as
        Record<string, unknown>;
      const original = String(current.workspacePath);
      const replacement = join(root, "workspaces", `${jobId}-alias-replacement`);
      const path = join(root, "workspaces", `${jobId}-alias`);
      await mkdir(replacement, { recursive: true });
      await symlink(original, path, "dir");
      await writeFile(manifestPath, `${JSON.stringify({
        ...current,
        workspacePath: path,
      }, null, 2)}\n`);
      return { path, replacement };
    },
    seedScopeSwitched,
    seedPreparedV1,
    activateWithoutState,
    setDeniedRoots,
    setProcessInventorySha: (value: string) => {
      processInventorySha = value;
    },
    load,
    setProcessInventorySequence: (value: readonly string[]) => {
      processInventorySequence = [...value];
    },
    setInspectedPidCountSequence: (value: readonly number[]) => {
      inspectedPidCountSequence = [...value];
    },
    setProcessBlockerFromCapture: (value: number) => {
      processBlockerFromCapture = value;
    },
    setWriterGuardFailureAt: (value: number) => {
      writerGuardFailureAt = value;
      writerGuardCount = 0;
    },
    setCaptureMutation: (value: () => Promise<void>) => {
      captureMutation = value;
      captureMutationAt = 2;
      captureCount = 0;
    },
    setCaptureMutationAt: (count: number, value: () => Promise<void>) => {
      captureMutation = value;
      captureMutationAt = count;
      captureCount = 0;
    },
    setUpgradeCrashAfter: (value: string | undefined) => {
      upgradeCrashAfter = value;
    },
    freezePreparedV1Baseline: async () => {
      preparedBaselineRoot = await mkdtemp(join(tmpdir(), "ledger-epoch-v1-baseline-"));
      await cp(newRoot, join(preparedBaselineRoot, "root"), { recursive: true });
      preparedBaselineController = await readFile(join(controllerJobRoot, "job.json"));
    },
    resetPreparedV1Baseline: async () => {
      if (!preparedBaselineRoot || !preparedBaselineController) {
        throw new Error("prepared v1 baseline not frozen");
      }
      await rm(newRoot, { recursive: true, force: true });
      await cp(join(preparedBaselineRoot, "root"), newRoot, { recursive: true });
      await writeFile(join(controllerJobRoot, "job.json"), preparedBaselineController);
      await rm(join(oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER), { force: true });
      captureCount = 0;
      captureMutationAt = 2;
      captureMutation = undefined;
      processInventorySequence = [];
      inspectedPidCountSequence = [];
      processBlockerFromCapture = Number.POSITIVE_INFINITY;
      writerGuardCount = 0;
      writerGuardFailureAt = Number.POSITIVE_INFINITY;
      processInventorySha = "a".repeat(64);
      upgradeCrashAfter = undefined;
    },
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
      ...(admissionSnapshot
        ? { buildAdmissionSnapshot: async (input: { scope: ProjectAccessScope }) =>
            input.scope.consumedOutputLedgerRoots?.[0] === newRoot
              ? {
                  ...admissionSnapshot,
                  debt: Array.from({ length: postAdmissionCount }, (_, index) => ({
                    reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
                    subject: `${newRoot}/quarantine/${index}`,
                    severity: "info" as const,
                    evidence: [`anchored quarantine ${index}`],
                  })),
                }
              : admissionSnapshot }
        : {}),
      assertNoLegacyWriterProcesses: async () => {
        writerGuardCount += 1;
        if (writerGuardCount === writerGuardFailureAt) {
          throw new Error("ledger_epoch_writer_process_active");
        }
      },
      captureProcessEvidence: async (custodyPaths: readonly string[]) => {
        captureCount += 1;
        if (captureCount === captureMutationAt) await captureMutation?.();
        return {
          schemaVersion: 1 as const,
          observedAt: "2026-08-08T00:00:00.000Z",
          inspectedPidCount: inspectedPidCountSequence.shift() ?? 3,
          inventorySha256: processInventorySequence.shift() ?? processInventorySha,
          custodyPaths,
          blockers: captureCount >= processBlockerFromCapture
            ? [{
                pid: 4242,
                startTime: "12345",
                argvSha256: "e".repeat(64),
                cwd: custodyPaths[0]!,
              }]
            : [],
        };
      },
      preparedV1UpgradeCrashAfter: () => upgradeCrashAfter,
    },
  };
}

async function exactTreeBytes(root: string): Promise<readonly string[]> {
  const values: string[] = [];
  const visit = async (path: string, relativePath: string): Promise<void> => {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      values.push(`d\0${relativePath}\0${metadata.mode}`);
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    const bytes = await readFile(path);
    values.push(`f\0${relativePath}\0${bytes.length}\0${createHash("sha256")
      .update(bytes).digest("hex")}`);
  };
  await visit(root, "");
  return values;
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
