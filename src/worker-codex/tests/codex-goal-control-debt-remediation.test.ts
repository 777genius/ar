import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerWriter } from
  "@vioxen/subscription-runtime/worker-local";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../codex-goal-jobs";
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
import { readCodexGoalConsumedOutputLedgers } from
  "../application/project-control/codex-goal-consumed-output-ledger-io";
import { assertCanonicalLedgerRootsAllowed } from
  "../application/project-control/codex-goal-ledger-epoch-handler-admission";

describe("consumed output evidence scope", () => {
  it("allows ledger epoch roots beneath the configured canonical registry root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ledger-registry-scope-"));
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
    const root = await mkdtemp(join(tmpdir(), "hosted-evidence-root-"));
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
    const root = await mkdtemp(join(tmpdir(), "evidence-preflight-"));
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

describe("legacy job summary retirement", () => {
  it("publishes an immutable idempotent receipt and suppresses only the exact manifest", async () => {
    const fixture = await retirementFixture();
    const plan = await fixture.plan();
    const planSha256 = legacyJobSummaryRetirementPlanSha256(plan);
    const first = await publishLegacyJobSummaryRetirement({
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: planSha256,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const replay = await publishLegacyJobSummaryRetirement({
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: planSha256,
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(await readFile(first.receiptPath, "utf8")).toContain("workspace_enoent");

    const projected = await projectRetirementProjection({
      registryRootDir: fixture.registry,
      projectId: "p0",
      summaries: [fixture.summary],
    });
    expect(projected.active).toEqual([]);
    expect(projected.retired).toHaveLength(1);

    await writeFile(fixture.manifestPath, `${JSON.stringify({
      ...fixture.manifest,
      description: "later legitimate manifest",
    }, null, 2)}\n`);
    const changed = await projectRetirementProjection({
      registryRootDir: fixture.registry,
      projectId: "p0",
      summaries: [fixture.summary],
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

    const linked = await retirementFixture();
    const original = join(linked.root, "original.json");
    await writeFile(original, await readFile(linked.manifestPath));
    await writeFile(linked.manifestPath, "replacement");
    const linkPath = join(linked.root, "linked-job.json");
    await symlink(original, linkPath);
    await expect(linked.plan({ expectedManifestPath: linkPath }))
      .rejects.toThrow();
  });
});

describe("frozen output import and summary supersession", () => {
  it("copies hash-bound bytes, fsyncs an append-only receipt, replays idempotently, and projects exact summaries", async () => {
    const fixture = await frozenFixture();
    const authoredPath = join(fixture.workspace, "authored.txt");
    await writeFile(authoredPath, "authored bytes stay untouched\n");
    const authoredBefore = await readFile(authoredPath);
    const plan = await fixture.plan();
    const planSha256 = frozenOutputImportPlanSha256(plan);
    const first = await publishFrozenOutputImport({
      plan,
      expectedPlanSha256: planSha256,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const replay = await publishFrozenOutputImport({
      plan,
      expectedPlanSha256: planSha256,
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(sha(await readFile(first.receipt.custodyOutputPath)))
      .toBe(fixture.sourceSha256);
    expect(await readFile(authoredPath)).toEqual(authoredBefore);

    const projection = await frozenOutputSupersessionProjection({
      evidenceRoots: [fixture.evidenceRoot],
      summaries: [fixture.summary],
    });
    expect(projection.active).toEqual([]);
    expect(projection.receipts).toHaveLength(1);

    await writeFile(fixture.legacyManifestPath, `${JSON.stringify({
      ...fixture.legacyManifest,
      description: "new registration",
    }, null, 2)}\n`);
    const changed = await frozenOutputSupersessionProjection({
      evidenceRoots: [fixture.evidenceRoot],
      summaries: [fixture.summary],
    });
    expect(changed.active).toHaveLength(1);
  });

  it("refuses traversal, symlinks, CAS/TOCTOU drift, clean, live, missing, and output-bearing summaries", async () => {
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
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
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
  });
});

async function retirementFixture() {
  const root = await mkdtemp(join(tmpdir(), "summary-retirement-"));
  const registry = join(root, "registry");
  const workspace = join(root, "gone-workspace");
  await mkdir(registry, { recursive: true });
  const manifest = manifestFor("legacy", workspace, join(registry, "legacy"));
  const retained = manifestFor("retained", workspace, join(registry, "retained"));
  const manifestPath = await writeManifest(registry, manifest);
  const retainedPath = await writeManifest(registry, retained);
  const summary = summaryFor(manifest, manifestPath);
  return {
    root, registry, workspace, manifest, manifestPath, summary,
    plan: async (override: Partial<{
      expectedManifestPath: string;
      expectedManifestSha256: string;
      workerAlive: boolean;
    }> = {}) => await buildLegacyJobSummaryRetirementPlan({
      registryRootDir: registry,
      projectId: "p0",
      controllerJobId: "controller",
      manifest,
      manifestPath,
      expectedManifestPath: override.expectedManifestPath ?? manifestPath,
      expectedManifestSha256: override.expectedManifestSha256 ?? sha(await readFile(manifestPath)),
      expectedWorkspacePath: workspace,
      retainedManifest: retained,
      retainedManifestPath: retainedPath,
      expectedRetainedManifestSha256: sha(await readFile(retainedPath)),
      workerAlive: override.workerAlive ?? false,
    }),
  };
}

async function frozenFixture() {
  const root = await mkdtemp(join(tmpdir(), "frozen-import-"));
  const registry = join(root, "registry");
  const sourceRoot = join(root, "freeze");
  const evidenceRoot = join(root, "controller", "archives");
  const ledgerRoot = join(registry, "controller", "consumed-output-ledger");
  const workspace = join(root, "workspace");
  await Promise.all([registry, sourceRoot, evidenceRoot, ledgerRoot, workspace].map(
    (path) => mkdir(path, { recursive: true }),
  ));
  const sourcePath = join(sourceRoot, "output.patch");
  const sourceManifestPath = join(sourceRoot, "freeze-manifest.json");
  await writeFile(sourcePath, "diff --git a/a.ts b/a.ts\n+changed\n");
  await writeFile(sourceManifestPath, "{\"frozen\":true}\n");
  const sourceSha256 = sha(await readFile(sourcePath));
  const retainedOutputPath = join(root, "retained-result.json");
  await writeFile(retainedOutputPath, "{\"status\":\"done\"}\n");
  const retainedManifest = {
    ...manifestFor("retained", workspace, join(registry, "retained")),
    outputPath: retainedOutputPath,
  };
  const retainedManifestPath = await writeManifest(registry, retainedManifest);
  const legacyManifest = manifestFor("legacy", workspace, join(registry, "legacy"));
  const legacyManifestPath = await writeManifest(registry, legacyManifest);
  const summary = summaryFor(legacyManifest, legacyManifestPath);
  const scope: ProjectAccessScope = {
    projectId: "p0",
    readRoots: [sourceRoot],
    consumedOutputEvidenceRoots: [evidenceRoot],
    consumedOutputLedgerRoots: [ledgerRoot],
  };
  return {
    root, registry, sourceRoot, sourcePath, sourceSha256, evidenceRoot, workspace,
    legacyManifest, legacyManifestPath, summary,
    plan: async (override: Partial<{
      sourcePath: string;
      expectedSourceSha256: string;
      changedPaths: readonly string[];
      workspaceDirty: boolean;
      workerAlive: boolean;
      workspacePath: string;
      legacyOutputPath: string;
    }> = {}) => {
      const candidate = {
        ...legacyManifest,
        workspacePath: override.workspacePath ?? legacyManifest.workspacePath,
        ...(override.legacyOutputPath ? { outputPath: override.legacyOutputPath } : {}),
      };
      return await buildFrozenOutputImportPlan({
        scope,
        controllerJobId: "controller",
        sourcePath: override.sourcePath ?? sourcePath,
        expectedSourceSha256: override.expectedSourceSha256 ?? sourceSha256,
        expectedSourceLength: (await readFile(sourcePath)).length,
        sourceManifestPath,
        expectedSourceManifestSha256: sha(await readFile(sourceManifestPath)),
        destinationEvidenceRoot: evidenceRoot,
        destinationLedgerRoot: ledgerRoot,
        changedPaths: override.changedPaths ?? ["a.ts"],
        baseCommit: "1".repeat(40),
        headCommit: "2".repeat(40),
        patchSha256: sourceSha256,
        retainedManifest,
        retainedManifestPath,
        expectedRetainedManifestSha256: sha(await readFile(retainedManifestPath)),
        expectedRetainedOutputSha256: sha(await readFile(retainedOutputPath)),
        superseded: [{
          manifest: candidate,
          manifestPath: legacyManifestPath,
          expectedManifestSha256: sha(await readFile(legacyManifestPath)),
          workspaceDirty: override.workspaceDirty ?? true,
          workerAlive: override.workerAlive ?? false,
        }],
      });
    },
  };
}

function manifestFor(jobId: string, workspacePath: string, jobRootDir: string): CodexGoalJobManifest {
  return {
    schemaVersion: 1,
    jobId,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    jobRootDir,
    workspacePath,
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: jobId,
    accounts: ["account-a"],
    projectAccessScope: { projectId: "p0" },
  };
}

async function writeManifest(registry: string, manifest: CodexGoalJobManifest) {
  const root = join(registry, manifest.jobId);
  await mkdir(root, { recursive: true });
  const path = join(root, "job.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function summaryFor(manifest: CodexGoalJobManifest, manifestPath: string): CodexGoalJobSummary {
  return {
    jobId: manifest.jobId,
    tags: [],
    taskId: manifest.taskId,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    accountNames: manifest.accounts,
    updatedAt: manifest.updatedAt,
    manifestPath,
  };
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
