import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it as vitestIt, vi } from "vitest";
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
import { seedAuthenticD0aPreparedEpochV1, prepareAuthenticD0aFixture } from
  "./codex-goal-ledger-epoch-legacy-admission-fixture";
import { buildLedgerEpochLegacyAdmissionAnchor } from
  "../application/project-control/codex-goal-ledger-epoch-legacy-admission";
import { assertPublicationLockAdmissionGuardrails } from
  "./codex-goal-ledger-epoch-publication-lock-fixture";
import { loadOrSeedHandlerAdmissionFixture } from
  "./codex-goal-ledger-epoch-handler-resume-fixture";
import { buildCodexProjectAdmissionSnapshot } from
  "../application/project-control/codex-goal-project-admission";
import {
  exactTreeBytes,
  sha256Json,
  stableControllerFingerprint,
} from "./codex-goal-ledger-epoch-handler-test-identity";
import { certifyLedgerEpochRecoveryFence } from "./codex-goal-ledger-epoch-recovery-fence-certification";
const fixtureModuleOnly = process.env.CODEX_LEDGER_EPOCH_HANDLER_FIXTURE_ONLY === "1";
const fixtureRoots = new Set<string>();
if (!fixtureModuleOnly) afterAll(async () => {
  await Promise.all([...fixtureRoots].map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});
const handlerShard = process.env.CODEX_LEDGER_EPOCH_HANDLER_SHARD ?? "production";
const shardTestNames: Readonly<Record<string, readonly RegExp[]>> = {
  production: [/^upgrades and activates/],
  envelope: [/^anchors the exact production-shaped/],
  nonlegacy: [/^activates non-legacy/],
  replay: [/^allows exact-710 post-admission/],
  safety: [
    /^allows unrelated process/,
    /^refuses a custody blocker/,
    /^refuses when the writer guard/,
    /^releases both ledger roots/,
    /^releases a mutation lock/,
    /^refuses an exact-710 registry/,
    /^refuses exact-710 workspace/,
    /^refuses a partial exact-710 final sidecar/,
  ],
  "mutation-artifacts": [
    /^refuses exact-710 v1 .* mutation before switching scope/,
    /^refuses exact-710 v1 target replacement/,
  ],
  "mutation-edge": [
    /^refuses exact-710 v1 maintenance contention/,
    /^refuses a %i-item legacy admission near miss/,
  ],
  recovery: [
    /^binds every preview, locked, and revalidation admission/,
    /^confirms retained info debt/,
    /^resumes the immutable stored plan/,
    /^denies a hash-valid stored plan/,
    /^denies a new-root parent symlink/,
    /^denies old and new roots/,
    /^rejects an already-switched scope/,
    /^rejects a denied subtree/,
    /^allows a reserved denied path/,
    /^fences prepared active-root recovery/,
  ],
};
const selectTestName = (name: unknown) =>
  typeof name === "string" &&
  shardTestNames[handlerShard]?.some((pattern) => pattern.test(name)) === true;
const it = new Proxy(vitestIt, {
  apply(target, thisArg, args) {
    return Reflect.apply(selectTestName(args[0]) ? target : target.skip, thisArg, args);
  },
  get(target, property, receiver) {
    if (property !== "each") return Reflect.get(target, property, receiver);
    return (...cases: unknown[]) => {
      const runEach = Reflect.apply(target.each, target, cases) as
        (...args: unknown[]) => unknown;
      const skipEach = Reflect.apply(target.skip.each, target.skip, cases) as
        (...args: unknown[]) => unknown;
      return (...args: unknown[]) =>
        (selectTestName(args[0]) ? runEach : skipEach)(...args);
    };
  },
}) as typeof vitestIt;
if (!fixtureModuleOnly) {
let productionFixture!: Awaited<ReturnType<typeof handlerFixture>>;
let productionPreview!: Awaited<ReturnType<
  typeof projectControlLedgerEpochMigrationView
>>;
let productionPlan!: ConsumedOutputLedgerEpochPlan;
if (handlerShard === "production" || handlerShard === "replay") {
  const authenticD0aFixtureReady = prepareAuthenticD0aFixture();
  productionFixture = await handlerFixture(495, true);
  await authenticD0aFixtureReady;
  productionPlan = await productionFixture.seedPreparedV1();
  await productionFixture.freezePreparedV1Baseline();
  if (handlerShard === "replay") {
    await projectControlLedgerEpochMigrationView(
      productionFixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: productionPlan.planSha256,
      }),
      productionFixture.deps,
    );
  }
} else if (handlerShard === "envelope") {
  productionFixture = await handlerFixture(495, false);
  productionPreview = await projectControlLedgerEpochMigrationView(
    productionFixture.args(),
    productionFixture.deps,
  );
}
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
    const sidecar = JSON.parse(await readFile(join(
      fixture.newRoot,
      ".ledger-epoch-v2-sidecar",
      "manifest.json",
    ), "utf8"));
    expect(sidecar.legacyAdmission).toMatchObject({
      debtCount: 710,
      blockingDebtCount: 710,
    });
  });
  it("activates non-legacy prepared v1 without a legacy admission anchor", async () => {
    const fixture = await handlerFixture(676, false, true);
    const plan = await fixture.seedPreparedV1();
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
    const sidecar = JSON.parse(await readFile(join(
      fixture.newRoot,
      ".ledger-epoch-v2-sidecar",
      "manifest.json",
    ), "utf8"));
    const receipt = JSON.parse(await readFile(join(
      fixture.newRoot,
      "ledger-epoch-receipt.json",
    ), "utf8"));
    expect(sidecar).not.toHaveProperty("legacyAdmission");
    expect(receipt).not.toHaveProperty("legacyAdmission");
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
    const before = await exactTreeBytes(fixture.root);
    await expect(projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    )).rejects.toThrow("ledger_epoch_legacy_admission_exact_count_mismatch");
    expect(await exactTreeBytes(fixture.root)).toEqual(before);
  });
  it("confirms retained info debt but rejects blocking debt under publication locks", async () => {
    const fixture = await handlerFixture();
    await assertPublicationLockAdmissionGuardrails({
      fixture,
      exactTreeBytes,
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
      }), fixture.deps);
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

  certifyLedgerEpochRecoveryFence({ test: it, fixture: handlerFixture });
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

  it("binds every preview, locked, and revalidation admission to the exact controller", async () => {
    const fixture = await handlerFixture(undefined, true, false, true);
    const preview = await projectControlLedgerEpochMigrationView(
      fixture.args(),
      fixture.deps,
    );
    await projectControlLedgerEpochMigrationView(
      fixture.args({
        confirmLedgerEpochMigration: true,
        expectedLedgerEpochPlanSha256: String(preview.planSha256),
      }),
      fixture.deps,
    );
    expect(fixture.observedAdmissionControllerJobIds.length).toBeGreaterThanOrEqual(7);
    expect(new Set(fixture.observedAdmissionControllerJobIds))
      .toEqual(new Set(["social-monitor-controller-v4"]));
  });
});
}
export async function handlerFixture(
  legacyConsumedCount?: number,
  fastOrphanBoundaries = true,
  currentSocialDebt = false,
  observeDefaultAdmission = false,
  resumeRoot?: string,
) {
  const resuming = resumeRoot !== undefined;
  const root = resuming
    ? await realpath(resumeRoot)
    : await realpath(await mkdtemp(join(tmpdir(), "ledger-epoch-handler-")));
  fixtureRoots.add(root);
  const registryRootDir = join(root, "registry");
  const controllerJobId = "social-monitor-controller-v4";
  const controllerJobRoot = join(registryRootDir, controllerJobId);
  const oldRoot = join(root, "ledgers", "v1");
  const newRoot = join(root, "ledgers", "v2");
  const persistedAdmissionPath = join(root, ".handler-admission-fixture.json");
  if (!resuming) {
    await mkdir(join(oldRoot, "items"), { recursive: true });
    await mkdir(controllerJobRoot, { recursive: true });
    await Promise.all([
      mkdir(join(root, "workspaces"), { recursive: true }),
      mkdir(join(root, "workspaces", "controller"), { recursive: true }),
      mkdir(join(root, "worktrees"), { recursive: true }),
      mkdir(join(root, "secrets"), { recursive: true }),
    ]);
  }
  const admissionSnapshot = await loadOrSeedHandlerAdmissionFixture({
    resuming,
    persistedAdmissionPath,
    root,
    oldRoot,
    ...(legacyConsumedCount === undefined ? {} : { legacyConsumedCount }),
    fastOrphanBoundaries,
    currentSocialDebt,
  });
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
  if (!resuming) {
    await writeFile(
      join(controllerJobRoot, "job.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
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
      crashAfterPhase: "scope_switched_before_retirement",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_scope_switched_before_retirement");
    return plan;
  };
  const seedPreparedV1 = async () => {
    if (!admissionSnapshot) throw new Error("legacy fixture required");
    const controller = (await load()).controller;
    const plan = await seedAuthenticD0aPreparedEpochV1({
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
    if (currentSocialDebt) {
      const path = join(newRoot, "ledger-epoch-state.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.admissionBefore = { debtCount: 1110, counts: {
        consumedDirtyWorkspaces: 676, orphanLegacyWorkspaces: 57, unreadableRoots: 377,
      } };
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
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
  let upgradeCrashBoundary: ((boundary: string) => void) | undefined;
  const observedAdmissionControllerJobIds: string[] = [];
  const admissionDeps = {
    listJobs: async () => [],
    buildOverviewItems: async () => [],
  };
  const postAdmissionCount = currentSocialDebt ? 266 : 414;
  let preparedBaselineRoot: string | undefined;
  let preparedBaselineController: Buffer | undefined;
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      if (preparedBaselineRoot) {
        await rm(preparedBaselineRoot, { recursive: true, force: true });
      }
    },
    oldRoot,
    newRoot,
    observedAdmissionControllerJobIds,
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
    setUpgradeCrashBoundary: (
      value: ((boundary: string) => void) | undefined,
    ) => {
      upgradeCrashBoundary = value;
    },
    freezePreparedV1Baseline: async () => {
      preparedBaselineRoot = await mkdtemp(join(tmpdir(), "ledger-epoch-v1-baseline-"));
      fixtureRoots.add(preparedBaselineRoot);
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
      upgradeCrashBoundary = undefined;
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
      admissionDeps,
      ...(admissionSnapshot || observeDefaultAdmission
        ? { buildAdmissionSnapshot: async (input: {
            scope: ProjectAccessScope;
            controllerJobId: string;
            allowPendingEpochOrphanQuarantine?: boolean;
            skipActiveProposedAdmissionNormalization?: boolean;
          }) => {
            observedAdmissionControllerJobIds.push(input.controllerJobId);
            if (!admissionSnapshot) {
              return await buildCodexProjectAdmissionSnapshot({
                registryRootDir,
                ...input,
                deps: admissionDeps,
              });
            }
            return input.scope.consumedOutputLedgerRoots?.[0] === newRoot
              ? {
                  ...admissionSnapshot,
                  debt: [
                    ...(currentSocialDebt ? admissionSnapshot.debt.filter((item) =>
                      item.reason === ProjectDebtReason.ConsumedDirtyWorkspace).map((item) =>
                        ({ ...item, severity: "info" as const })) : []),
                    ...Array.from({ length: postAdmissionCount }, (_, index) => ({
                    reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
                    subject: `${newRoot}/quarantine/${index}`,
                    severity: "info" as const,
                    evidence: [`anchored quarantine ${index}`],
                    })),
                  ],
                }
              : admissionSnapshot;
          } }
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
      preparedV1UpgradeCrashBoundary: (boundary: string) => {
        upgradeCrashBoundary?.(boundary);
      },
    },
  };
}
