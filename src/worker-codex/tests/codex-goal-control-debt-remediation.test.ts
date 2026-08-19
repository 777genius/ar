import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectAccessScope, ProjectControlEvidenceCustodyPort } from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerWriter } from
  "@vioxen/subscription-runtime/worker-local";
import {
  localProjectControlEvidenceCustodySupported,
  LocalProjectControlEvidenceCustody,
} from
  "../../worker-local/project-control-evidence-custody-local-adapter";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  buildLegacyJobSummaryRetirementPlan,
  legacyJobSummaryRetirementPlanSha256,
  projectRetirementProjection,
  publishLegacyJobSummaryRetirement,
} from "../application/project-control/codex-goal-legacy-job-summary-retirement";
import {
  buildFrozenOutputImportPlan,
  frozenOutputImportPlanSha256,
  frozenOutputSupersessionProjection,
  publishFrozenOutputImport,
} from "../application/project-control/codex-goal-frozen-output-import";
import { certifyFrozenOutputPhaseA, observingCustody } from
  "./codex-goal-frozen-output-phase-a-certification";
import { certifyControlDebtPhaseB } from
  "./codex-goal-control-debt-phase-b-certification";
import { certifyR25HighFrozenOutput } from "./codex-goal-r25-high-frozen-output-certification";
import {
  createFrozenFixture,
  createRetirementFixture,
  manifestFor,
  sha,
  summaryFor,
  writeManifest,
} from
  "./codex-goal-control-debt-remediation-fixtures";
import { readCodexGoalConsumedOutputLedgers } from
  "../application/project-control/codex-goal-consumed-output-ledger-io";
import { assertCanonicalLedgerRootsAllowed } from
  "../application/project-control/codex-goal-ledger-epoch-handler-admission";
import { assertProjectControlDebtControllerCas } from
  "../codex-goal-mcp-project-control-debt-remediation";
import { createCodexProjectControlBroker } from
  "../codex-goal-mcp-project-broker";

const remediationRoots = new Set<string>();
afterAll(async () => await Promise.all([...remediationRoots].map((root) =>
  rm(root, { recursive: true, force: true })
)));
describe("consumed output evidence scope", () => {
  it("allows ledger epoch roots beneath the configured canonical registry root", async () => {
    const root = await realpath(await mkdtemp(
      join(tmpdir(), "ledger-registry-scope-"),
    ));
    remediationRoots.add(root);
    const registryRoot = join(root, "registry");
    const oldRoot = join(registryRoot, "controller", "ledger-v1");
    const newRoot = join(registryRoot, "controller", "ledger-v2");
    await Promise.all([oldRoot, newRoot].map((path) =>
      mkdir(path, { recursive: true })
    ));
    await expect(assertCanonicalLedgerRootsAllowed(
      { projectId: "p0", registryRoot },
      oldRoot,
      newRoot,
    )).resolves.toBeUndefined();
  });

  it("reads hosted sibling archives only through the explicit narrow evidence root", async () => {
    const root = await realpath(await mkdtemp(
      join(tmpdir(), "hosted-evidence-root-"),
    ));
    remediationRoots.add(root);
    const ledgerRoot = join(root, "codex-goal-jobs", "controller", "consumed-output-ledger");
    const evidenceRoot = join(root, "controller", "archives");
    const archivePath = join(evidenceRoot, "producer-rejected");
    await Promise.all([ledgerRoot, archivePath].map((path) =>
      mkdir(path, { recursive: true })
    ));
    const statusPath = join(archivePath, "status.txt");
    const patchPath = join(archivePath, "workspace.patch");
    const numstatPath = join(archivePath, "numstat.txt");
    await Promise.all([
      writeFile(statusPath, " M a.ts\n"),
      writeFile(patchPath, "diff --git a/a.ts b/a.ts\n+x\n"),
      writeFile(numstatPath, "1\t0\ta.ts\n"),
    ]);
    await new LocalConsumedOutputLedgerWriter(
      undefined,
      root,
      [evidenceRoot],
    ).record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: "producer",
        attemptId: "review-1",
        status: "rejected",
        closedAt: "2026-08-15T00:00:00.000Z",
        archivePath,
        note: "rejected output retained",
        backup: {
          workspace: join(root, "workspace"),
          statusPath,
          patchPath,
          numstatPath,
        },
      },
    });
    const ledger = await readCodexGoalConsumedOutputLedgers({
      roots: [ledgerRoot],
      evidenceRoots: [evidenceRoot],
    });
    expect(ledger.byJobId.get("producer")?.valid).toBe(true);
    expect(ledger.debt).toEqual([]);
  });

  it("rejects a symlink-swapped evidence leaf before publishing the ledger", async () => {
    const root = await realpath(await mkdtemp(
      join(tmpdir(), "evidence-preflight-"),
    ));
    remediationRoots.add(root);
    const ledgerRoot = join(root, "ledger");
    const evidenceRoot = join(root, "archives");
    const outside = join(root, "outside.txt");
    await Promise.all([ledgerRoot, evidenceRoot].map((path) =>
      mkdir(path, { recursive: true })
    ));
    await writeFile(outside, "dirty\n");
    const statusPath = join(evidenceRoot, "status.txt");
    await symlink(outside, statusPath);
    await expect(new LocalConsumedOutputLedgerWriter(
      undefined,
      root,
      [evidenceRoot],
    ).record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: "unsafe",
        status: "rejected",
        closedAt: "2026-08-15T00:00:00.000Z",
        note: "must not publish",
        backup: { workspace: join(root, "workspace"), statusPath },
      },
    })).rejects.toThrow("outside_root");
    await expect(readFile(join(ledgerRoot, "items", "unsafe.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

const evidenceCustody = new LocalProjectControlEvidenceCustody();

describe.runIf(localProjectControlEvidenceCustodySupported)(
  "immutable evidence publication recovery", () => {
  for (const crashPoint of [
    "after_temp_write",
    "after_temp_fsync",
    "after_publish_before_directory_fsync",
    "after_directory_fsync",
  ] as const) {
    it(`recovers an interrupted ${crashPoint} publication without mutable overwrite`, async () => {
      const root = await mkdtemp(join(tmpdir(), "evidence-publication-crash-"));
      remediationRoots.add(root);
      const bytes = Buffer.from("durable immutable evidence\n");
      const expectedSha256 = sha(bytes);
      let injected = false;
      const crashing = new LocalProjectControlEvidenceCustody((point) => {
        if (!injected && point === crashPoint) {
          injected = true;
          throw new Error(`simulated_crash:${point}`);
        }
      });
      await expect(crashing.publishImmutableBytes({
        root,
        directories: ["receipts"],
        fileName: "receipt.json",
        bytes,
        expectedSha256,
      })).rejects.toThrow(`simulated_crash:${crashPoint}`);

      const replay = await evidenceCustody.publishImmutableBytes({
        root,
        directories: ["receipts"],
        fileName: "receipt.json",
        bytes,
        expectedSha256,
      });
      expect(replay.created).toBe(
        crashPoint === "after_temp_write" || crashPoint === "after_temp_fsync",
      );
      expect(await readFile(replay.path)).toEqual(bytes);
      expect((await readdir(join(root, "receipts"))).filter((name) =>
        name.startsWith(".custody-publish-")
      )).toEqual([]);

      const conflictingBytes = Buffer.alloc(bytes.length, 0x78);
      await expect(evidenceCustody.publishImmutableBytes({
        root,
        directories: ["receipts"],
        fileName: "receipt.json",
        bytes: conflictingBytes,
        expectedSha256: sha(conflictingBytes),
      })).rejects.toThrow("immutable_conflict");
    });
  }

  it("removes a stale unpublished temporary before safely publishing", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-publication-stale-"));
    remediationRoots.add(root);
    const firstBytes = Buffer.from("abandoned evidence\n");
    const crashing = new LocalProjectControlEvidenceCustody((point) => {
      if (point === "after_temp_write") throw new Error("simulated_crash");
    });
    await expect(crashing.publishImmutableBytes({
      root,
      directories: ["receipts"],
      fileName: "receipt.json",
      bytes: firstBytes,
      expectedSha256: sha(firstBytes),
    })).rejects.toThrow("simulated_crash");
    const receiptRoot = join(root, "receipts");
    const [temporaryName] = (await readdir(receiptRoot)).filter((name) =>
      name.startsWith(".custody-publish-")
    );
    if (!temporaryName) throw new Error("expected abandoned publication temp");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(receiptRoot, temporaryName), old, old);

    const replacement = Buffer.from("replacement evidence\n");
    await evidenceCustody.publishImmutableBytes({
      root,
      directories: ["receipts"],
      fileName: "receipt.json",
      bytes: replacement,
      expectedSha256: sha(replacement),
    });
    expect(await readFile(join(receiptRoot, "receipt.json"))).toEqual(
      replacement,
    );
    expect((await readdir(receiptRoot)).filter((name) =>
      name.startsWith(".custody-publish-")
    )).toEqual([]);
  });
  });

describe("project-control debt confirmation controller CAS", () => {
  it("rejects a controller or scope reloaded with any drift under the lock", () => {
    const controller = manifestFor("controller", "/workspace", "/registry/controller");
    const loaded = {
      registryRootDir: "/registry",
      controller,
      scope: controller.projectAccessScope!,
    };
    expect(() => assertProjectControlDebtControllerCas(loaded, loaded)).not.toThrow();
    const driftedController = {
      ...controller,
      projectAccessScope: {
        ...controller.projectAccessScope!,
        consumedOutputEvidenceRoots: ["/changed/archives"],
      },
    };
    expect(() => assertProjectControlDebtControllerCas(loaded, {
      ...loaded,
      controller: driftedController,
      scope: driftedController.projectAccessScope,
    })).toThrow("controller_scope_cas_mismatch");
  });
});

describe.runIf(localProjectControlEvidenceCustodySupported)(
  "legacy job summary retirement", () => {
  it("publishes an immutable idempotent receipt and suppresses only the exact manifest", async () => {
    const fixture = await retirementFixture();
    const plan = await fixture.plan();
    const planSha256 = legacyJobSummaryRetirementPlanSha256(plan);
    const first = await publishLegacyJobSummaryRetirement({
      custody: evidenceCustody,
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: planSha256,
      rebuildCurrentPlan: async () => plan,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const replay = await publishLegacyJobSummaryRetirement({
      custody: evidenceCustody,
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: planSha256,
      rebuildCurrentPlan: async () => plan,
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(await readFile(first.receiptPath, "utf8")).toContain("workspace_enoent");

    const projected = await projectRetirementProjection({
      custody: evidenceCustody,
      registryRootDir: fixture.registry,
      projectId: "p0",
      controllerJobId: "controller",
      jobIdPrefixes: ["legacy", "retained"],
      summaries: [fixture.summary],
      observeRuntime: async () => ({ workerAlive: false }),
    });
    expect(projected.active).toEqual([]);
    expect(projected.retired).toHaveLength(1);
    const staleController = await projectRetirementProjection({
      custody: evidenceCustody,
      registryRootDir: fixture.registry,
      projectId: "p0",
      controllerJobId: "successor-controller",
      jobIdPrefixes: ["legacy", "retained"],
      summaries: [fixture.summary],
      observeRuntime: async () => ({ workerAlive: false }),
    });
    expect(staleController.active).toEqual([fixture.summary]);

    const admissionDeps = {
      evidenceCustody,
      listJobs: async () => [fixture.summary],
      observeManifestRuntime: async () => ({ workspaceDirty: true, workerAlive: false, resultExists: false }),
      buildOverviewItems: async (inputs: readonly { jobId: string }[]) =>
        inputs.map(({ jobId }) => ({
          ok: true,
          jobId,
          workspacePath: fixture.workspace,
          workspaceDirty: true,
          workerAlive: false,
          resultExists: false,
          activeWriterRisk: "dirty_workspace_without_worker",
          activeWriterRiskReasons: ["dirty_workspace_without_worker"],
        })),
    };
    const admissionEvidenceRoot = join(
      fixture.registry,
      "controller",
      "archives",
    );
    await mkdir(admissionEvidenceRoot, { recursive: true });
    const scope: ProjectAccessScope = {
      projectId: "p0",
      registryRoot: fixture.registry,
      workspaceRoots: [fixture.root],
      consumedOutputEvidenceRoots: [admissionEvidenceRoot],
      jobIdPrefixes: ["legacy", "retained", "new-"],
      allowedAccountIds: ["account-a"],
    };
    const successor = createCodexProjectControlBroker({
      registryRootDir: fixture.registry,
      controller: manifestFor(
        "successor-controller",
        fixture.root,
        join(fixture.registry, "successor-controller"),
      ),
      scope,
      admissionDeps,
    });
    await expect(successor.createJob({
      jobId: "new-child",
      registryRoot: fixture.registry,
      workspacePath: join(fixture.root, "new-child"),
      accounts: ["account-a"],
    })).rejects.toThrow("project_control_admission_denied");

    const current = createCodexProjectControlBroker({
      registryRootDir: fixture.registry,
      controller: manifestFor(
        "controller",
        fixture.root,
        join(fixture.registry, "controller"),
      ),
      scope,
      admissionDeps,
      createManifest: manifestFor(
        "new-child",
        join(fixture.root, "new-child"),
        join(fixture.registry, "new-child"),
      ),
    });
    await expect(current.createJob({
      jobId: "new-child",
      registryRoot: fixture.registry,
      workspacePath: join(fixture.root, "new-child"),
      accounts: ["account-a"],
    })).resolves.toMatchObject({ status: "applied" });

    await writeFile(fixture.manifestPath, `${JSON.stringify({
      ...fixture.manifest,
      description: "later legitimate manifest",
    }, null, 2)}\n`);
    const changed = await projectRetirementProjection({
      custody: evidenceCustody,
      registryRootDir: fixture.registry,
      projectId: "p0",
      jobIdPrefixes: ["legacy", "retained"],
      summaries: [fixture.summary],
      observeRuntime: async () => ({ workerAlive: false }),
    });
    expect(changed.active).toHaveLength(1);
  });

  it("refuses CAS drift, existing workspace, live workers, artifacts, and symlink manifests", async () => {
    const cas = await retirementFixture();
    await expect(cas.plan({ expectedManifestSha256: "0".repeat(64) }))
      .rejects.toThrow("manifest_sha256_cas_mismatch");

    const existing = await retirementFixture();
    await mkdir(existing.workspace, { recursive: true });
    await expect(existing.plan()).rejects.toThrow("workspace_still_exists");

    const live = await retirementFixture();
    await expect(live.plan({ workerAlive: true })).rejects.toThrow("worker_live");

    const artifact = await retirementFixture();
    await writeFile(join(artifact.manifest.jobRootDir, "result.json"), "{}\n");
    await expect(artifact.plan()).rejects.toThrow("runtime_artifact_present");

    for (const suffix of [
      "latest-result.json",
      "progress.json",
      "log",
      "events.jsonl",
    ]) {
      const derived = await retirementFixture();
      await writeFile(join(
        derived.manifest.jobRootDir,
        `${derived.manifest.taskId}.${suffix}`,
      ), "runtime evidence\n");
      await expect(derived.plan()).rejects.toThrow("runtime_artifact_present");
    }

    const stateFixtureRoot = await mkdtemp(join(tmpdir(), "retirement-state-root-"));
    const configuredStateRoot = join(stateFixtureRoot, "configured-state");
    remediationRoots.add(stateFixtureRoot);
    const stateBearing = await retirementFixture("p0", {
      stateRootDir: configuredStateRoot,
    });
    await mkdir(configuredStateRoot, { recursive: true });
    await expect(stateBearing.plan()).rejects.toThrow("runtime_state_present");

    const defaultStateBearing = await retirementFixture();
    await mkdir(join(defaultStateBearing.manifest.jobRootDir, "state"));
    await expect(defaultStateBearing.plan()).rejects.toThrow(
      "runtime_state_present",
    );

    const linked = await retirementFixture();
    const original = join(linked.root, "original.json");
    await writeFile(original, await readFile(linked.manifestPath));
    await writeFile(linked.manifestPath, "replacement");
    const linkPath = join(linked.root, "linked-job.json");
    await symlink(original, linkPath);
    await expect(linked.plan({ expectedManifestPath: linkPath }))
      .rejects.toThrow();

    const foreign = await retirementFixture("foreign");
    await expect(foreign.plan()).rejects.toThrow("project_mismatch");
  });
  });

describe.runIf(localProjectControlEvidenceCustodySupported)(
  "frozen output import and summary supersession", () => {
  it("copies hash-bound bytes, fsyncs an append-only receipt, replays idempotently, and projects exact summaries", async () => {
    const fixture = await frozenFixture();
    const authoredPath = join(fixture.workspace, "authored.txt");
    await writeFile(authoredPath, "authored bytes stay untouched\n");
    const authoredBefore = await readFile(authoredPath);
    const plan = await fixture.plan();
    const planSha256 = frozenOutputImportPlanSha256(plan);
    const first = await publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: planSha256,
      rebuildCurrentPlan: async () => plan,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const replay = await publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: planSha256,
      rebuildCurrentPlan: async () => plan,
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(sha(await readFile(first.receipt.custodyOutputPath)))
      .toBe(fixture.sourceSha256);
    expect(await readFile(authoredPath)).toEqual(authoredBefore);

    // Projection relies on custody copies, not mutable producer registration.
    await writeFile(fixture.retainedOutputPath, "mutated after custody\n");

    const projection = await frozenOutputSupersessionProjection({
      custody: evidenceCustody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      projectId: "p0",
      controllerJobId: "controller",
      summaries: [fixture.summary],
      observeRuntime: async () => ({
        workspaceDirty: true, workerAlive: false, resultExists: false,
      }),
    });
    expect(projection.active).toEqual([]);
    expect(projection.supersessions).toHaveLength(1);
    const foreignController = await frozenOutputSupersessionProjection({
      custody: evidenceCustody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      projectId: "p0",
      controllerJobId: "foreign-controller",
      summaries: [fixture.summary],
      observeRuntime: async () => ({
        workspaceDirty: true, workerAlive: false, resultExists: false,
      }),
    });
    expect(foreignController.active).toEqual([fixture.summary]);
    expect(foreignController.supersessions).toEqual([]);

    await writeFile(fixture.legacyManifestPath, `${JSON.stringify({
      ...fixture.legacyManifest,
      description: "new registration",
    }, null, 2)}\n`);
    const changed = await frozenOutputSupersessionProjection({
      custody: evidenceCustody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      summaries: [fixture.summary],
      observeRuntime: async () => ({
        workspaceDirty: true, workerAlive: false, resultExists: false,
      }),
    });
    expect(changed.active).toHaveLength(1);
  });

  it("refuses traversal, symlinks, CAS/TOCTOU drift, clean, live, missing, and output-bearing summaries", async () => {
    const unauthorizedSource = await frozenFixture();
    const outsideSourceRoot = await mkdtemp(join(tmpdir(), "foreign-frozen-source-"));
    remediationRoots.add(outsideSourceRoot);
    const outsideSource = join(outsideSourceRoot, "output.patch");
    await writeFile(outsideSource, "untrusted patch\n");
    let outsideSourceInspections = 0;
    const sourceCustody = observingCustody(evidenceCustody, (method, path) => {
      if (method === "inspectImmutablePatch" && path === outsideSource) {
        outsideSourceInspections += 1;
      }
    });
    await expect(unauthorizedSource.plan({
      sourcePath: outsideSource,
      custody: sourceCustody,
    })).rejects.toThrow("source_outside_project_read_scope");
    expect(outsideSourceInspections).toBe(0);

    const unauthorizedManifest = await frozenFixture();
    const outsideManifest = join(outsideSourceRoot, "source-manifest.json");
    await writeFile(outsideManifest, "{}\n");
    let outsideManifestReads = 0;
    const manifestCustody = observingCustody(evidenceCustody, (method, path) => {
      if (method === "readImmutableFile" && path === outsideManifest) {
        outsideManifestReads += 1;
      }
    });
    await expect(unauthorizedManifest.plan({
      sourceManifestPath: outsideManifest,
      custody: manifestCustody,
    })).rejects.toThrow("manifest_outside_project_read_scope");
    expect(outsideManifestReads).toBe(0);

    const unauthorizedRegistry = await frozenFixture();
    let registryCustodyCalls = 0;
    const registryCustody = observingCustody(evidenceCustody, () => {
      registryCustodyCalls += 1;
    });
    await expect(unauthorizedRegistry.plan({
      custody: registryCustody,
      scope: {
        projectId: "p0",
        readRoots: [unauthorizedRegistry.sourceRoot],
        consumedOutputEvidenceRoots: [unauthorizedRegistry.evidenceRoot],
        ...(unauthorizedRegistry.scope.consumedOutputLedgerRoots
          ? {
              consumedOutputLedgerRoots:
                unauthorizedRegistry.scope.consumedOutputLedgerRoots,
            }
          : {}),
      },
    })).rejects.toThrow("registry_outside_project_scope");
    expect(registryCustodyCalls).toBe(0);

    const traversal = await frozenFixture();
    await expect(traversal.plan({ changedPaths: ["../escape"] }))
      .rejects.toThrow("changed_paths_invalid");

    const linked = await frozenFixture();
    const link = join(linked.sourceRoot, "linked.patch");
    await symlink(linked.sourcePath, link);
    await expect(linked.plan({ sourcePath: link })).rejects.toThrow("noncanonical");

    const cas = await frozenFixture();
    await expect(cas.plan({ expectedSourceSha256: "0".repeat(64) }))
      .rejects.toThrow("source_cas_mismatch");

    const drift = await frozenFixture();
    const plan = await drift.plan();
    await writeFile(drift.sourcePath, "changed after preview\n");
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: drift.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    })).rejects.toThrow("source_drift");

    const clean = await frozenFixture();
    await expect(clean.plan({ workspaceDirty: false }))
      .rejects.toThrow("dirty_workspace_required");

    const live = await frozenFixture();
    await expect(live.plan({ workerAlive: true })).rejects.toThrow("worker_live");

    const missing = await frozenFixture();
    const missingWorkspace = join(missing.root, "missing-workspace");
    await expect(missing.plan({ workspacePath: missingWorkspace }))
      .rejects.toThrow();

    const outputBearing = await frozenFixture();
    const legacyOutput = join(outputBearing.root, "legacy-result.json");
    await writeFile(legacyOutput, "{}\n");
    await expect(outputBearing.plan({ legacyOutputPath: legacyOutput }))
      .rejects.toThrow("output_bearing_refused");

    const unauthorizedResult = await frozenFixture();
    const externalResultRoot = await mkdtemp(join(tmpdir(), "foreign-result-"));
    remediationRoots.add(externalResultRoot);
    const externalResult = join(externalResultRoot, "result.json");
    let externalResultKinds = 0;
    const resultCustody = observingCustody(evidenceCustody, (method, path) => {
      if (method === "pathKind" && path === externalResult) {
        externalResultKinds += 1;
      }
    });
    await expect(unauthorizedResult.plan({
      legacyOutputPath: externalResult,
      custody: resultCustody,
    })).rejects.toThrow("path_outside_project_scope");
    expect(externalResultKinds).toBe(0);

    const defaultOutputBearing = await frozenFixture();
    await writeFile(join(
      defaultOutputBearing.legacyManifest.jobRootDir,
      `${defaultOutputBearing.legacyManifest.taskId}.latest-result.json`,
    ), "{}\n");
    await expect(defaultOutputBearing.plan())
      .rejects.toThrow("output_bearing_refused");

    const freshlyObservedOutput = await frozenFixture();
    await expect(freshlyObservedOutput.plan({ observedResultExists: true }))
      .rejects.toThrow("output_bearing_refused");

    const handoffBearing = await frozenFixture();
    await writeFile(join(
      handoffBearing.legacyManifest.jobRootDir,
      `${handoffBearing.legacyManifest.taskId}.handoff.patch`,
    ), "authored handoff\n");
    await expect(handoffBearing.plan())
      .rejects.toThrow("handoff_bearing_refused");

    const manifestMismatch = await frozenFixture();
    const sourceManifest = JSON.parse(await readFile(
      manifestMismatch.sourceManifestPath, "utf8",
    ));
    sourceManifest.projectId = "foreign";
    await writeFile(manifestMismatch.sourceManifestPath,
      `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await expect(manifestMismatch.plan()).rejects.toThrow("binding_mismatch");

    const retainedDrift = await frozenFixture();
    const retainedPlan = await retainedDrift.plan();
    await writeFile(retainedDrift.retainedOutputPath, "drifted retained output\n");
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: retainedDrift.scope,
      plan: retainedPlan,
      expectedPlanSha256: frozenOutputImportPlanSha256(retainedPlan),
      rebuildCurrentPlan: async () => retainedPlan,
    })).rejects.toThrow("source_drift");

    const supersededOutputRace = await frozenFixture();
    const supersededPlan = await supersededOutputRace.plan();
    await writeFile(join(
      supersededOutputRace.legacyManifest.jobRootDir,
      `${supersededOutputRace.legacyManifest.taskId}.latest-result.json`,
    ), "late result\n");
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: supersededOutputRace.scope,
      plan: supersededPlan,
      expectedPlanSha256: frozenOutputImportPlanSha256(supersededPlan),
      rebuildCurrentPlan: async () => supersededPlan,
    })).rejects.toThrow("output_bearing_refused");

    const supersededManifestRace = await frozenFixture();
    const supersededManifestPlan = await supersededManifestRace.plan();
    await writeFile(
      supersededManifestRace.legacyManifestPath,
      `${JSON.stringify({
        ...supersededManifestRace.legacyManifest,
        description: "replacement registration",
      }, null, 2)}\n`,
    );
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: supersededManifestRace.scope,
      plan: supersededManifestPlan,
      expectedPlanSha256: frozenOutputImportPlanSha256(
        supersededManifestPlan,
      ),
      rebuildCurrentPlan: async () => supersededManifestPlan,
    })).rejects.toThrow("superseded_manifest_drift");

    const externalRetained = await frozenFixture();
    const externalRoot = await mkdtemp(join(tmpdir(), "foreign-retained-output-"));
    remediationRoots.add(externalRoot);
    const externalOutput = join(externalRoot, "result.json");
    await writeFile(externalOutput, "foreign output\n");
    await writeFile(externalRetained.retainedManifestPath, `${JSON.stringify({
      ...externalRetained.retainedManifest,
      outputPath: externalOutput,
    }, null, 2)}\n`);
    let externalOutputReads = 0;
    const externalCustody = observingCustody(evidenceCustody,
      (method, path) => {
        if (method === "readImmutableFile" && path === externalOutput) {
          externalOutputReads += 1;
        }
      });
    await expect(externalRetained.plan({ custody: externalCustody }))
      .rejects.toThrow("retained_output_outside_project_scope");
    expect(externalOutputReads).toBe(0);

    const deniedRetained = await frozenFixture();
    const deniedRoot = join(deniedRetained.root, "denied-output");
    const deniedOutput = join(deniedRoot, "result.json");
    await mkdir(deniedRoot);
    await writeFile(deniedOutput, "denied output\n");
    await writeFile(deniedRetained.retainedManifestPath, `${JSON.stringify({
      ...deniedRetained.retainedManifest,
      outputPath: deniedOutput,
    }, null, 2)}\n`);
    await expect(deniedRetained.plan({
      scope: {
        projectId: "p0",
        readRoots: [deniedRetained.root],
        deniedRoots: [deniedRoot],
        consumedOutputEvidenceRoots: [deniedRetained.evidenceRoot],
        consumedOutputLedgerRoots: [join(
          deniedRetained.registry,
          "controller",
          "consumed-output-ledger",
        )],
      },
    })).rejects.toThrow("retained_output_outside_project_scope");

    const registryIdentity = await frozenFixture();
    const selfAuthorizedRoot = join(outsideSourceRoot, "manifest-job-root");
    await writeFile(registryIdentity.legacyManifestPath, `${JSON.stringify({
      ...registryIdentity.legacyManifest,
      jobRootDir: selfAuthorizedRoot,
    }, null, 2)}\n`);
    let selfAuthorizedRootCalls = 0;
    const identityCustody = observingCustody(evidenceCustody, (_method, path) => {
      if (path === selfAuthorizedRoot) selfAuthorizedRootCalls += 1;
    });
    await expect(registryIdentity.plan({ custody: identityCustody }))
      .rejects.toThrow("registry_identity_mismatch");
    expect(selfAuthorizedRootCalls).toBe(0);
  });

  it("restores a superseded registration when a default result appears later", async () => {
    const fixture = await frozenFixture();
    const plan = await fixture.plan();
    await publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    });
    await writeFile(join(
      fixture.legacyManifest.jobRootDir,
      `${fixture.legacyManifest.taskId}.latest-result.json`,
    ), "late authored result\n");
    const projection = await frozenOutputSupersessionProjection({
      custody: evidenceCustody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      projectId: "p0",
      controllerJobId: "controller",
      summaries: [fixture.summary],
      observeRuntime: async () => ({
        workspaceDirty: true, workerAlive: false, resultExists: false,
      }),
    });
    expect(projection.active).toEqual([fixture.summary]);
  });

  certifyFrozenOutputPhaseA({ custody: evidenceCustody, fixture: frozenFixture });
  certifyR25HighFrozenOutput({ custody: evidenceCustody, fixture: frozenFixture });

  it("rejects intermediate symlink and root-swap publication without external writes", async () => {
    const linked = await frozenFixture();
    const plan = await linked.plan();
    const outside = join(linked.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(linked.evidenceRoot, "frozen-output-imports"), "dir");
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: linked.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    })).rejects.toThrow("ancestor_unsafe");
    expect(await readdir(outside)).toEqual([]);

    const swapped = await frozenFixture();
    const swappedPlan = await swapped.plan();
    const original = `${swapped.evidenceRoot}-original`;
    const outsideRoot = join(swapped.root, "outside-root");
    await mkdir(outsideRoot);
    await rename(swapped.evidenceRoot, original);
    await symlink(outsideRoot, swapped.evidenceRoot, "dir");
    await expect(publishFrozenOutputImport({
      custody: evidenceCustody,
      scope: swapped.scope,
      plan: swappedPlan,
      expectedPlanSha256: frozenOutputImportPlanSha256(swappedPlan),
      rebuildCurrentPlan: async () => swappedPlan,
    })).rejects.toThrow("root_noncanonical");
    expect(await readdir(outsideRoot)).toEqual([]);
  });
  });

if (localProjectControlEvidenceCustodySupported) {
  certifyControlDebtPhaseB({
    custody: evidenceCustody,
    retirementFixture,
    frozenFixture,
  });
}

async function retirementFixture(
  targetProjectId = "p0",
  manifestPatch: Partial<CodexGoalJobManifest> = {},
) {
  return await createRetirementFixture(
    evidenceCustody,
    (root) => remediationRoots.add(root),
    targetProjectId,
    manifestPatch,
  );
}

async function frozenFixture() {
  return await createFrozenFixture(
    evidenceCustody,
    (root) => remediationRoots.add(root),
  );
}
