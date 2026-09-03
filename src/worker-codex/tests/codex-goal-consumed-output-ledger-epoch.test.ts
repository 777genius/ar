import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  type ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor,
  ProjectDebtReason,
} from "@vioxen/subscription-runtime/worker-core";
import { buildCodexProjectAdmissionSnapshot } from "../application/project-control/codex-goal-project-admission";
import { ledgerEpochQuarantineDebt } from
  "../application/project-control/codex-goal-ledger-epoch-admission-debt";
import { assertConsumedOutputLedgerEpochAdmissionTransition } from
  "../application/project-control/codex-goal-ledger-epoch-admission-transition";
import {
  applyConsumedOutputLedgerEpoch,
  buildConsumedOutputLedgerEpochPlan,
  resolveConsumedOutputLedgerEpochReceipt,
  resolveConsumedOutputMaintenanceLedgerRoot,
} from "../application/project-control/codex-goal-consumed-output-ledger-epoch";
import { LocalConsumedOutputLedgerWriter } from "../../worker-local/consumed-output-ledger-local-adapter";
import {
  acquireConsumedOutputLedgerMaintenanceLock,
  releaseConsumedOutputLedgerMaintenanceLock,
} from "../../worker-local/consumed-output-ledger-maintenance-lock";

const execFileAsync = promisify(execFile);

describe("consumed-output ledger epoch migration", () => {
  it("accepts exact 377+57 quarantine debt and preserves 676 consumed infos", () => {
    expect(() => assertConsumedOutputLedgerEpochAdmissionTransition({
      plan: {
        quarantinedCount: 377,
        inheritedQuarantinedCount: 0,
        orphanWorkspaceBindings: Array.from({ length: 57 }, (_, index) => ({
          declaredPath: `/workspace/orphan-${index}`,
          state: "quarantined" as const,
        })),
      } as never,
      before: {
        debtCount: 1_110,
        counts: { consumedDirtyWorkspaces: 676 },
      },
      proposed: {
        debtCount: 1_110,
        counts: {
          consumedDirtyWorkspaces: 676,
          legacyOutputQuarantineRequired: 434,
          orphanLegacyWorkspaces: 0,
          incompleteConsumedOutputRecords: 0,
          retentionEvidenceMissing: 0,
        },
      },
    })).not.toThrow();
  });

  it("builds a deterministic hash-bound plan without exposing record contents", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    expect(plan.evidenceBindings.some((binding) =>
      binding.declaredPath === fixture.statusPath && binding.state === "file"
    )).toBe(true);
    expect(plan.evidenceBindings).toContainEqual(expect.objectContaining({
      declaredPath: fixture.archivePath,
      state: "directory",
    }));
    expect(plan).toMatchObject({
      schemaVersion: 1,
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      migratedCount: 1,
      quarantinedCount: 1,
    });
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(plan)).not.toContain("never-print-this-secret");
    expect((await fixture.buildPlan()).planSha256).toBe(plan.planSha256);
  });
  it("commits exact legacy-attempt quarantine provenance into plan and receipt", async () => {
    const fixture = await ledgerFixture();
    const legacyAttemptQuarantine = {
      schemaVersion: 1 as const,
      planSha256: "3".repeat(64),
      quarantineRootSha256: "4".repeat(64),
      receiptSha256: "5".repeat(64),
      attemptCount: 17,
      reconciliationEvidenceBoundCount: 2,
      unresolvedEvidenceQuarantineCount: 15,
    };
    const plan = await fixture.buildPlan(legacyAttemptQuarantine);
    expect(plan.legacyAttemptQuarantine).toEqual(legacyAttemptQuarantine);
    const applied = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    expect(applied.receipt.legacyAttemptQuarantine).toEqual(
      legacyAttemptQuarantine,
    );
    expect((await resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .legacyAttemptQuarantine).toEqual(legacyAttemptQuarantine);
  });
  it("quarantines a current record whose donor evidence is missing", async () => {
    const fixture = await ledgerFixture({ missingDonor: true });
    const plan = await fixture.buildPlan();
    expect(plan.files.find((file) => file.relativePath === "items/current-v4.json"))
      .toMatchObject({ disposition: "quarantine", quarantineReason: "invalid_or_missing_evidence" });
  });
  it("never trusts terminal evidence below a denied root", async () => {
    const fixture = await ledgerFixture();
    const plan = await buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.oldRoot,
      newRoot: fixture.newRoot,
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      deniedRoots: [dirname(fixture.statusPath)],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    });
    expect(plan.files).toContainEqual(expect.objectContaining({
      relativePath: "items/current-v4.json",
      disposition: "quarantine",
      quarantineReason: "invalid_or_missing_evidence",
    }));
    expect(plan.evidenceBindings).toContainEqual({
      declaredPath: fixture.statusPath,
      state: "denied",
    });
    const applied = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      buildCurrentPlan: async () => await buildConsumedOutputLedgerEpochPlan({
        controllerJobId: "controller-v4",
        projectId: "social-monitor",
        oldRoot: fixture.oldRoot,
        newRoot: fixture.newRoot,
        cutoff: "2026-08-01T00:00:00.000Z",
        currentJobIds: new Set(["current-v4"]),
        evidenceRoots: [fixture.root],
        deniedRoots: [dirname(fixture.statusPath)],
        controllerManifestSha256: "1".repeat(64),
        controllerStableScopeSha256: "2".repeat(64),
      }),
      expectedPlanSha256: plan.planSha256,
    });
    expect(applied.receipt.status).toBe("active");
  });
  it("rejects an invalid expected plan hash before writing", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();

    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: "0".repeat(64),
    })).rejects.toThrow("ledger_epoch_plan_hash_mismatch");
    await expect(stat(fixture.newRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("fails closed when the old root drifts after preview", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await writeFile(join(fixture.oldRoot, "items", "drift.json"), "{}\n");

    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    })).rejects.toThrow("ledger_epoch_plan_drift");
  });
  it("binds orphan dirty workspace quarantine and blocks later drift", async () => {
    const fixture = await ledgerFixture({ orphanWorkspace: true });
    const plan = await fixture.buildPlan();
    expect(plan.orphanWorkspaceBindings).toHaveLength(1);
    expect(plan.orphanWorkspaceBindings[0]).toMatchObject({
      state: "quarantined",
      declaredPath: fixture.orphanWorkspace,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await writeFile(join(fixture.orphanWorkspace!, "dirty.txt"), "drifted\n");
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    })).rejects.toThrow("ledger_epoch_plan_drift");
  });
  it("quarantines a record whose filename does not match its payload", async () => {
    const fixture = await ledgerFixture();
    const source = await readFile(
      join(fixture.oldRoot, "items", "current-v4.json"),
      "utf8",
    );
    await writeFile(join(fixture.oldRoot, "items", "wrong-name.json"), source);

    const plan = await fixture.buildPlan();
    expect(plan.files.find((file) =>
      file.relativePath === join("items", "wrong-name.json")
    )).toMatchObject({
      disposition: "quarantine",
      quarantineReason: "invalid_or_missing_evidence",
    });
  });
  it("keeps an owned prepared root for fail-forward retry when scope switch fails", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    const deps = fixture.applyDeps(plan);

    await expect(applyConsumedOutputLedgerEpoch({
      ...deps,
      expectedPlanSha256: plan.planSha256,
      switchScope: async () => {
        throw new Error("simulated_scope_write_failure");
      },
    })).rejects.toThrow("simulated_scope_write_failure");
    expect((await stat(fixture.newRoot)).isDirectory()).toBe(true);
    expect(fixture.activeRoot()).toBe(fixture.oldRoot);
    await expect(stat(join(
      fixture.oldRoot,
      CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await applyConsumedOutputLedgerEpoch({
      ...deps,
      expectedPlanSha256: plan.planSha256,
    });
    expect(resumed.receipt.status).toBe("active");
  });
  it("rejects source drift before resuming a prepared transaction", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
      crashAfterPhase: "prepared",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_prepared");
    const appended = JSON.parse(await readFile(
      join(fixture.oldRoot, "items", "current-v4.json"),
      "utf8",
    ));
    await writeFile(join(fixture.oldRoot, "items", "appended-v4.json"),
      `${JSON.stringify({ ...appended, jobId: "appended-v4" })}\n`);
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    })).rejects.toThrow("ledger_epoch_plan_drift");
    expect(fixture.activeRoot()).toBe(fixture.oldRoot);
  });
  it("resumes after crashes at both durable transaction phases", async () => {
    for (const crashAfterPhase of [
      "prepared",
      "scope_switched_before_retirement",
      "scope_switched",
      "receipt_published",
    ] as const) {
      const fixture = await ledgerFixture();
      const plan = await fixture.buildPlan();
      await expect(applyConsumedOutputLedgerEpoch({
        ...fixture.applyDeps(plan),
        expectedPlanSha256: plan.planSha256,
        crashAfterPhase,
      })).rejects.toThrow(`ledger_epoch_simulated_crash_after_${crashAfterPhase}`);
      if (crashAfterPhase === "scope_switched_before_retirement") {
        expect(fixture.activeRoot()).toBe(fixture.newRoot);
        await expect(stat(join(
          fixture.oldRoot,
          CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
        ))).rejects.toMatchObject({ code: "ENOENT" });
      }
      const resumed = await applyConsumedOutputLedgerEpoch({
        ...fixture.applyDeps(plan),
        expectedPlanSha256: plan.planSha256,
      });
      expect(resumed.receipt.status).toBe("active");
      expect(fixture.activeRoot()).toBe(fixture.newRoot);
      expect((await stat(join(
        fixture.oldRoot,
        CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
      ))).isFile()).toBe(true);
    }
  });
  it("seeds byte-identical preservation, activates once and replays idempotently", async () => {
    const fixture = await ledgerFixture();
    await writeFile(join(fixture.oldRoot, ".maintenance.lock"), "legacy-lock-byte\n");
    const plan = await fixture.buildPlan();
    const first = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });

    expect(first.idempotentReplay).toBe(false);
    expect(fixture.activeRoot()).toBe(fixture.newRoot);
    expect(await readFile(
      join(fixture.newRoot, "legacy-preservation", "items", "current-v4.json"),
      "utf8",
    )).toBe(await readFile(join(fixture.oldRoot, "items", "current-v4.json"), "utf8"));
    expect(await readFile(join(
      fixture.newRoot,
      "legacy-preservation",
      ".maintenance.lock",
    ), "utf8")).toBe("legacy-lock-byte\n");
    const second = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    expect(second.idempotentReplay).toBe(true);
  });
  it("preserves the original pre-switch admission summary across recovery", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      admissionBefore: { debtCount: 377 },
      expectedPlanSha256: plan.planSha256,
      crashAfterPhase: "scope_switched",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_scope_switched");
    const resumed = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      admissionBefore: { debtCount: 999 },
      expectedPlanSha256: plan.planSha256,
    });
    expect(resumed.receipt.admissionBefore).toEqual({ debtCount: 377 });
  });
  it("selects the controller active root and verifies its epoch receipt", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });

    const selected = await resolveConsumedOutputMaintenanceLedgerRoot({
      projectId: "social-monitor",
      consumedOutputLedgerRoots: [fixture.newRoot],
    });
    expect(selected.ledgerRoot).toBe(fixture.newRoot);
    expect(selected.epochReceipt?.planSha256).toBe(plan.planSha256);
  });
  it("fails closed when an active epoch is missing its state", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    await rm(join(fixture.newRoot, "ledger-epoch-state.json"));
    await expect(resolveConsumedOutputMaintenanceLedgerRoot({
      projectId: "social-monitor",
      consumedOutputLedgerRoots: [fixture.newRoot],
    })).rejects.toThrow("ledger_epoch_partial_artifacts");
    await expect(buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.newRoot,
      newRoot: join(fixture.root, "ledger-v3"),
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    })).rejects.toThrow("ledger_epoch_partial_artifacts");
  });
  it("requires the retirement marker and restores it during locked recovery", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    await rm(join(fixture.oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER));
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    })).resolves.toMatchObject({ idempotentReplay: true });
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .resolves.toMatchObject({ planSha256: plan.planSha256 });
    const markerPath = join(fixture.oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, `${JSON.stringify({ ...marker, extra: true }, null, 2)}\n`);
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .rejects.toThrow("ledger_epoch_retired_marker_conflict");
  });
  it("rejects missing or mutated quarantine artifacts during replay", async () => {
    for (const mutation of ["missing", "mutated"] as const) {
      const fixture = await ledgerFixture();
      const plan = await fixture.buildPlan();
      await applyConsumedOutputLedgerEpoch({
        ...fixture.applyDeps(plan),
        expectedPlanSha256: plan.planSha256,
      });
      const quarantineRoot = join(fixture.newRoot, "quarantine");
      const [artifact] = await readdir(quarantineRoot);
      if (mutation === "missing") {
        await rm(join(quarantineRoot, artifact!));
      } else {
        await writeFile(join(quarantineRoot, artifact!), "{}\n");
      }
      await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
        .rejects.toThrow(mutation === "missing"
          ? /ENOENT/
          : "ledger_epoch_quarantine_artifact_mismatch");
    }
  });

  it("rejects a canonically formatted receipt that hides quarantine debt", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    const path = join(fixture.newRoot, "ledger-epoch-receipt.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({
      ...receipt,
      quarantinedCount: 0,
    }, null, 2)}\n`);
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .rejects.toThrow("ledger_epoch_receipt_plan_mismatch");
  });

  it("rejects a receipt whose admission result no longer matches durable state", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    const path = join(fixture.newRoot, "ledger-epoch-receipt.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({
      ...receipt,
      admissionAfter: { debtCount: 1 },
    }, null, 2)}\n`);
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .rejects.toThrow("ledger_epoch_receipt_state_mismatch");
  });

  it("records the exact immediately observed admission summary", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    const observe = async () => {
      const snapshot = await buildCodexProjectAdmissionSnapshot({
        registryRootDir: join(fixture.root, "registry"),
        scope: {
          projectId: "social-monitor",
          consumedOutputLedgerRoots: [fixture.newRoot],
        },
        deps: { listJobs: async () => [], buildOverviewItems: async () => [] },
      });
      return {
        debtCount: snapshot.debt.length,
        ...(snapshot.counts ? { counts: snapshot.counts } : {}),
      };
    };
    const result = await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      admissionForNewRoot: observe,
      expectedPlanSha256: plan.planSha256,
    });
    expect(result.receipt.admissionAfter).toEqual(await observe());
  });

  it("reports every quarantined legacy record as honest non-blocking debt", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    const snapshot = await buildCodexProjectAdmissionSnapshot({
      registryRootDir: join(fixture.root, "registry"),
      scope: {
        projectId: "social-monitor",
        consumedOutputLedgerRoots: [fixture.newRoot],
      },
      deps: {
        listJobs: async () => [],
        buildOverviewItems: async () => [],
      },
    });
    const quarantine = snapshot.debt.filter((item) =>
      item.reason === ProjectDebtReason.LegacyOutputQuarantineRequired &&
      item.evidence.includes(`plan sha256 ${plan.planSha256}`)
    );
    expect(quarantine).toHaveLength(plan.quarantinedCount);
    expect(quarantine.every((item) => item.severity === "info")).toBe(true);
  });

  it("downgrades only an exact active orphan binding and blocks later drift", async () => {
    const fixture = await ledgerFixture({ orphanWorkspace: true });
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    const snapshot = async () => await buildCodexProjectAdmissionSnapshot({
      registryRootDir: join(fixture.root, "registry"),
      scope: {
        projectId: "social-monitor",
        consumedOutputLedgerRoots: [fixture.newRoot],
        observedWorkspaceRoots: [join(fixture.root, "worktrees")],
        jobIdPrefixes: ["social-monitor-"],
      },
      deps: { listJobs: async () => [], buildOverviewItems: async () => [] },
    });
    expect((await snapshot()).debt).toContainEqual(expect.objectContaining({
      reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
      subject: fixture.orphanWorkspace,
      severity: "info",
    }));
    await writeFile(join(fixture.orphanWorkspace!, "new-drift.txt"), "drift\n");
    expect((await snapshot()).debt).toContainEqual(expect.objectContaining({
      reason: ProjectDebtReason.OrphanLegacyWorkspace,
      subject: fixture.orphanWorkspace,
      severity: "blocking",
    }));
  });

  it("denies overlapping roots", async () => {
    const fixture = await ledgerFixture();
    await expect(buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.oldRoot,
      newRoot: join(fixture.oldRoot, "nested"),
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    })).rejects.toThrow("ledger_epoch_roots_must_not_overlap");
  });

  it("fails closed when bound evidence changes after the scope switch", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
      crashAfterPhase: "scope_switched",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_scope_switched");
    await writeFile(fixture.statusPath, "changed after switch\n");
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    })).rejects.toThrow("ledger_epoch_evidence_binding_drift");
  });

  it("denies symlinks in the old ledger tree", async () => {
    const fixture = await ledgerFixture();
    await symlink(fixture.statusPath, join(fixture.oldRoot, "items", "linked.json"));
    await expect(fixture.buildPlan()).rejects.toThrow("ledger_epoch_symlink_denied");
  });

  it("quarantines evidence that escapes through a symlinked ancestor", async () => {
    const fixture = await ledgerFixture();
    const outside = await mkdtemp(join(tmpdir(), "ledger-epoch-outside-"));
    await writeFile(join(outside, "status.txt"), "outside\n");
    const linked = join(fixture.root, "linked-evidence");
    await symlink(outside, linked);
    await writeFile(join(fixture.oldRoot, "items", "escaped-v4.json"), `${JSON.stringify({
      schemaVersion: 1,
      jobId: "escaped-v4",
      status: "rejected",
      closedAt: "2026-08-02T00:00:00.000Z",
      backup: {
        workspace: fixture.root,
        statusPath: join(linked, "status.txt"),
      },
    })}\n`);
    const plan = await fixture.buildPlan();
    expect(plan.files).toContainEqual(expect.objectContaining({
      relativePath: "items/escaped-v4.json",
      disposition: "quarantine",
      quarantineReason: "invalid_or_missing_evidence",
    }));
    expect(plan.evidenceBindings).toContainEqual(expect.objectContaining({
      declaredPath: join(linked, "status.txt"),
      state: "denied",
    }));
  });

  it("keeps same-basename quarantine records collision-free", async () => {
    const fixture = await ledgerFixture();
    await mkdir(join(fixture.oldRoot, "items", "nested"), { recursive: true });
    await writeFile(join(fixture.oldRoot, "items", "nested", "legacy-invalid.json"),
      await readFile(join(fixture.oldRoot, "items", "legacy-invalid.json")));
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    expect((await readdir(join(fixture.newRoot, "quarantine"))).length).toBe(2);
  });

  it("allows new terminal items without weakening immutable seed checks", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    await new LocalConsumedOutputLedgerWriter().record({
      ledgerRoot: fixture.newRoot,
      decision: terminalDecision(fixture, "post-activation-v4"),
    });
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .resolves.toMatchObject({ planSha256: plan.planSha256 });
    await writeFile(join(fixture.newRoot, "items", "current-v4.json"), "{}\n");
    await expect(resolveConsumedOutputLedgerEpochReceipt(fixture.newRoot))
      .rejects.toThrow("ledger_epoch_seed_hash_mismatch");
  });

  it("rejects a stale writer targeting the retired root after activation", async () => {
    const fixture = await ledgerFixture();
    const plan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(plan),
      expectedPlanSha256: plan.planSha256,
    });
    await expect(new LocalConsumedOutputLedgerWriter().record({
      ledgerRoot: fixture.oldRoot,
      decision: terminalDecision(fixture, "stale-v4"),
    })).rejects.toThrow("consumed_output_ledger_root_retired");
  });

  it("carries prior quarantine debt across later epochs", async () => {
    const fixture = await ledgerFixture();
    const firstPlan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(firstPlan),
      expectedPlanSha256: firstPlan.planSha256,
    });
    const thirdRoot = join(fixture.root, "ledger-v3");
    let activeRoot = fixture.newRoot;
    const buildSecondPlan = async () => await buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.newRoot,
      newRoot: thirdRoot,
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    });
    const secondPlan = await buildSecondPlan();
    expect(secondPlan).toMatchObject({
      epochNumber: 2,
      inheritedQuarantinedCount: firstPlan.quarantinedCount,
      quarantinedCount: 0,
    });
    const second = await applyConsumedOutputLedgerEpoch({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      buildCurrentPlan: buildSecondPlan,
      admissionBefore: { debtCount: 1, counts: { consumedDirtyWorkspaces: 0 } },
      validateProposedAdmission: async () => ({
        debtCount: 1,
        counts: {
          consumedDirtyWorkspaces: 0,
          legacyOutputQuarantineRequired: 1,
        },
      }),
      admissionForNewRoot: async () => ({ debtCount: 0 }),
      switchScope: async () => { activeRoot = thirdRoot; },
      readActiveRoot: async () => activeRoot,
      revalidatePostSwitchBindings: async () => undefined,
    });
    expect(ledgerEpochQuarantineDebt(second.receipt)).toHaveLength(
      firstPlan.quarantinedCount,
    );
  });

  it("carries and revalidates an unchanged dirty orphan across two epochs", async () => {
    const fixture = await ledgerFixture({ orphanWorkspace: true });
    const firstPlan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(firstPlan),
      expectedPlanSha256: firstPlan.planSha256,
    });
    const thirdRoot = join(fixture.root, "ledger-v3-orphan");
    let activeRoot = fixture.newRoot;
    const buildSecondPlan = async () => await buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.newRoot,
      newRoot: thirdRoot,
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    });
    const secondPlan = await buildSecondPlan();
    expect(secondPlan.orphanWorkspaceBindings).toEqual(
      firstPlan.orphanWorkspaceBindings,
    );
    const second = await applyConsumedOutputLedgerEpoch({
      plan: secondPlan,
      expectedPlanSha256: secondPlan.planSha256,
      buildCurrentPlan: buildSecondPlan,
      admissionBefore: { debtCount: 2, counts: { consumedDirtyWorkspaces: 0 } },
      validateProposedAdmission: async () => ({
        debtCount: 2,
        counts: {
          consumedDirtyWorkspaces: 0,
          legacyOutputQuarantineRequired: 2,
        },
      }),
      admissionForNewRoot: async () => ({ debtCount: 2 }),
      switchScope: async () => { activeRoot = thirdRoot; },
      readActiveRoot: async () => activeRoot,
      revalidatePostSwitchBindings: async () => undefined,
    });
    expect(second.receipt.orphanWorkspaceBindings).toEqual(
      firstPlan.orphanWorkspaceBindings,
    );
  });

  it("blocks a later epoch while the previous epoch is incomplete", async () => {
    const fixture = await ledgerFixture();
    const firstPlan = await fixture.buildPlan();
    await expect(applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(firstPlan),
      expectedPlanSha256: firstPlan.planSha256,
      crashAfterPhase: "scope_switched",
    })).rejects.toThrow("ledger_epoch_simulated_crash_after_scope_switched");
    await expect(buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.newRoot,
      newRoot: join(fixture.root, "ledger-v3"),
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    })).rejects.toThrow("ledger_epoch_previous_epoch_incomplete");
  });

  it("blocks a later epoch when the previous active receipt is missing", async () => {
    const fixture = await ledgerFixture();
    const firstPlan = await fixture.buildPlan();
    await applyConsumedOutputLedgerEpoch({
      ...fixture.applyDeps(firstPlan),
      expectedPlanSha256: firstPlan.planSha256,
    });
    await rm(join(fixture.newRoot, "ledger-epoch-receipt.json"));
    await expect(buildConsumedOutputLedgerEpochPlan({
      controllerJobId: "controller-v4",
      projectId: "social-monitor",
      oldRoot: fixture.newRoot,
      newRoot: join(fixture.root, "ledger-v3"),
      cutoff: "2026-08-01T00:00:00.000Z",
      currentJobIds: new Set(["current-v4"]),
      evidenceRoots: [fixture.root],
      controllerManifestSha256: "1".repeat(64),
      controllerStableScopeSha256: "2".repeat(64),
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks terminal publication while migration owns the ledger lock", async () => {
    const fixture = await ledgerFixture();
    const lease = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: fixture.oldRoot,
      owner: "epoch-test",
    });
    try {
      await expect(new LocalConsumedOutputLedgerWriter().record({
        ledgerRoot: fixture.oldRoot,
        decision: {
          schemaVersion: 1,
          jobId: "concurrent-v4",
          status: "failed_no_output",
          closedAt: "2026-08-08T00:00:00.000Z",
          failure: { category: "test", code: "test" },
          output: { authoredChanges: false, workspaceDirty: false },
          note: "test",
          backup: { workspace: fixture.root, statusPath: fixture.statusPath },
        },
      })).rejects.toThrow("consumed_output_ledger_maintenance_locked");
    } finally {
      await releaseConsumedOutputLedgerMaintenanceLock(lease);
    }
  });

  it("shares the maintenance lock across old and prospective new roots", async () => {
    const fixture = await ledgerFixture();
    const lease = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: fixture.oldRoot,
      owner: "epoch-test",
    });
    try {
      await expect(new LocalConsumedOutputLedgerWriter().record({
        ledgerRoot: fixture.newRoot,
        decision: {
          schemaVersion: 1,
          jobId: "concurrent-v4",
          status: "failed_no_output",
          closedAt: "2026-08-08T00:00:00.000Z",
          failure: { category: "test", code: "test" },
          output: { authoredChanges: false, workspaceDirty: false },
          note: "test",
          backup: { workspace: fixture.root, statusPath: fixture.statusPath },
        },
      })).rejects.toThrow("consumed_output_ledger_maintenance_locked");
      await expect(stat(fixture.newRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await releaseConsumedOutputLedgerMaintenanceLock(lease);
    }
  });

  it("shares the maintenance lock across lexical and canonical root aliases", async () => {
    const fixture = await ledgerFixture();
    const aliasRoot = `${fixture.root}-alias`;
    await symlink(fixture.root, aliasRoot, "dir");
    const lease = await acquireConsumedOutputLedgerMaintenanceLock({
      ledgerRoot: fixture.oldRoot,
      owner: "epoch-test",
    });
    try {
      await expect(new LocalConsumedOutputLedgerWriter().record({
        ledgerRoot: join(aliasRoot, "ledger-v1"),
        decision: {
          schemaVersion: 1,
          jobId: "alias-v4",
          status: "failed_no_output",
          closedAt: "2026-08-08T00:00:00.000Z",
          failure: { category: "test", code: "test" },
          output: { authoredChanges: false, workspaceDirty: false },
          note: "test",
          backup: { workspace: fixture.root, statusPath: fixture.statusPath },
        },
      })).rejects.toThrow("consumed_output_ledger_maintenance_locked");
    } finally {
      await releaseConsumedOutputLedgerMaintenanceLock(lease);
      await rm(aliasRoot, { force: true });
    }
  });
});

function terminalDecision(
  fixture: Awaited<ReturnType<typeof ledgerFixture>>,
  jobId: string,
) {
  return {
    schemaVersion: 1 as const,
    jobId,
    status: "failed_no_output" as const,
    closedAt: "2026-08-08T00:00:00.000Z",
    failure: { category: "test", code: "test" },
    output: { authoredChanges: false, workspaceDirty: false },
    note: "test",
    backup: { workspace: fixture.root, statusPath: fixture.statusPath },
  };
}

export async function ledgerFixture(options: {
  readonly missingDonor?: boolean;
  readonly orphanWorkspace?: boolean;
} = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "subscription-runtime-ledger-epoch-")),
  );
  const oldRoot = join(root, "ledger-v1");
  const newRoot = join(root, "ledger-v2");
  const items = join(oldRoot, "items");
  const backup = join(root, "backups", "current-v4");
  const workspace = join(root, "worktrees", "current-v4");
  const orphanWorkspace = options.orphanWorkspace
    ? join(root, "worktrees", "social-monitor-orphan-v2")
    : undefined;
  await mkdir(items, { recursive: true });
  await mkdir(backup, { recursive: true });
  await mkdir(workspace, { recursive: true });
  if (orphanWorkspace) {
    await mkdir(orphanWorkspace, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: orphanWorkspace });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: orphanWorkspace,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: orphanWorkspace,
    });
    await writeFile(join(orphanWorkspace, "tracked.txt"), "base\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: orphanWorkspace });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: orphanWorkspace });
    await writeFile(join(orphanWorkspace, "tracked.txt"), "dirty\n");
  }
  const statusPath = join(backup, "status.txt");
  const patchPath = join(backup, "tracked.patch");
  const numstatPath = join(backup, "numstat.txt");
  if (!options.missingDonor) {
    await writeFile(statusPath, " M src/index.ts\n");
    await writeFile(patchPath, "diff --git a/src/index.ts b/src/index.ts\n");
    await writeFile(numstatPath, "1\t1\tsrc/index.ts\n");
  }
  await writeFile(join(items, "current-v4.json"), `${JSON.stringify({
    schemaVersion: 1,
    note: "never-print-this-secret",
    jobId: "current-v4",
    status: "rejected",
    closedAt: "2026-08-02T00:00:00.000Z",
    archivePath: backup,
    backup: { workspace, statusPath, patchPath, numstatPath },
  })}\n`);
  await writeFile(join(items, "legacy-invalid.json"), `${JSON.stringify({
    schemaVersion: 1,
    note: "legacy",
    jobId: "legacy-v2",
    status: "rejected",
    closedAt: "2026-07-01T00:00:00.000Z",
    backup: {
      workspace: join(root, "missing-workspace"),
      statusPath: join(root, "missing", "status.txt"),
      patchPath: join(root, "missing", "patch.diff"),
    },
  })}\n`);
  let activeRoot = oldRoot;
  const buildPlan = async (
    legacyAttemptQuarantine?: ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor,
    deniedRoots: readonly string[] = [],
  ) => await buildConsumedOutputLedgerEpochPlan({
    controllerJobId: "controller-v4",
    projectId: "social-monitor",
    oldRoot,
    newRoot,
    cutoff: "2026-08-01T00:00:00.000Z",
    currentJobIds: new Set(["current-v4"]),
    evidenceRoots: [root],
    deniedRoots,
    orphanWorkspacePaths: orphanWorkspace ? [orphanWorkspace] : [],
    controllerManifestSha256: "1".repeat(64),
    controllerStableScopeSha256: "2".repeat(64),
    ...(legacyAttemptQuarantine ? { legacyAttemptQuarantine } : {}),
  });
  const applyDeps = (plan: Awaited<ReturnType<typeof buildPlan>>) => ({
    plan,
    buildCurrentPlan: async () => await buildPlan(plan.legacyAttemptQuarantine),
    admissionBefore: { debtCount: 377, counts: { consumedDirtyWorkspaces: 0 } },
    validateProposedAdmission: async () => ({
      debtCount: plan.inheritedQuarantinedCount + plan.quarantinedCount +
        plan.orphanWorkspaceBindings.filter((binding) =>
          binding.state === "quarantined"
        ).length,
      counts: {
        consumedDirtyWorkspaces: 0,
        legacyOutputQuarantineRequired:
          plan.inheritedQuarantinedCount + plan.quarantinedCount +
          plan.orphanWorkspaceBindings.filter((binding) =>
            binding.state === "quarantined"
          ).length,
      },
    }),
    admissionForNewRoot: async () => ({ debtCount: 0 }),
    switchScope: async (next: string) => {
      activeRoot = next;
    },
    readActiveRoot: async () => activeRoot,
    revalidatePostSwitchBindings: async () => undefined,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
  });
  return {
    root,
    oldRoot,
    newRoot,
    statusPath,
    archivePath: backup,
    orphanWorkspace,
    buildPlan,
    applyDeps,
    activeRoot: () => activeRoot,
  };
}
