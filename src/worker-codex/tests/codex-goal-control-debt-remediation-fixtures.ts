import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectAccessScope, ProjectControlEvidenceCustodyPort } from
  "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../codex-goal-jobs";
import { buildLegacyJobSummaryRetirementPlan } from
  "../application/project-control/codex-goal-legacy-job-summary-retirement";
import { buildFrozenOutputImportPlan } from
  "../application/project-control/codex-goal-frozen-output-import";

export function manifestFor(
  jobId: string,
  workspacePath: string,
  jobRootDir: string,
): CodexGoalJobManifest {
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

export async function writeManifest(
  registry: string,
  manifest: CodexGoalJobManifest,
) {
  const root = join(registry, manifest.jobId);
  await mkdir(root, { recursive: true });
  const path = join(root, "job.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export function summaryFor(
  manifest: CodexGoalJobManifest,
  manifestPath: string,
): CodexGoalJobSummary {
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

export function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createRetirementFixture(
  evidenceCustody: ProjectControlEvidenceCustodyPort,
  retainRoot: (root: string) => void,
  targetProjectId = "p0",
  manifestPatch: Partial<CodexGoalJobManifest> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "summary-retirement-"));
  retainRoot(root);
  const registry = join(root, "registry");
  const workspace = join(root, "gone-workspace", "leaf");
  await mkdir(registry, { recursive: true });
  const manifest = {
    ...manifestFor("legacy", workspace, join(registry, "legacy")),
    projectAccessScope: { projectId: targetProjectId },
    ...manifestPatch,
  };
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
      custody: ProjectControlEvidenceCustodyPort;
    }> = {}) => await buildLegacyJobSummaryRetirementPlan({
      custody: override.custody ?? evidenceCustody,
      registryRootDir: registry,
      projectId: "p0",
      controllerJobId: "controller",
      jobIdPrefixes: ["legacy", "retained"],
      manifestPath,
      expectedManifestPath: override.expectedManifestPath ?? manifestPath,
      expectedManifestSha256: override.expectedManifestSha256 ??
        sha(await readFile(manifestPath)),
      expectedWorkspacePath: workspace,
      retainedManifestPath: retainedPath,
      expectedRetainedManifestSha256: sha(await readFile(retainedPath)),
      observeRuntime: async () => ({ workerAlive: override.workerAlive ?? false }),
    }),
  };
}

export async function createFrozenFixture(
  evidenceCustody: ProjectControlEvidenceCustodyPort,
  retainRoot: (root: string) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "frozen-import-"));
  retainRoot(root);
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
  await writeFile(sourcePath,
    `From ${"2".repeat(40)} Mon Sep 17 00:00:00 2001\n` +
    "Subject: [PATCH] test\n\n" +
    "diff --git a/a.ts b/a.ts\n+changed\n-- \n2.0\n" +
    `base-commit: ${"1".repeat(40)}\n`);
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
    readRoots: [root],
    consumedOutputEvidenceRoots: [evidenceRoot],
    consumedOutputLedgerRoots: [ledgerRoot],
  };
  await writeFile(sourceManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    projectId: "p0",
    controllerJobId: "controller",
    patch: {
      sha256: sourceSha256,
      length: (await readFile(sourcePath)).length,
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
      changedPaths: ["a.ts"],
    },
    retainedOutput: {
      jobId: retainedManifest.jobId,
      manifestSha256: sha(await readFile(retainedManifestPath)),
      outputSha256: sha(await readFile(retainedOutputPath)),
    },
  }, null, 2)}\n`);
  return {
    root, registry, sourceRoot, sourcePath, sourceManifestPath, sourceSha256,
    scope, evidenceRoot, workspace, retainedOutputPath, retainedManifest,
    retainedManifestPath, legacyManifest, legacyManifestPath, summary,
    plan: async (override: Partial<{
      sourcePath: string;
      sourceManifestPath: string;
      expectedSourceSha256: string;
      changedPaths: readonly string[];
      workspaceDirty: boolean;
      workerAlive: boolean;
      workspacePath: string;
      legacyOutputPath: string;
      scope: ProjectAccessScope;
      observedResultExists: boolean;
      custody: ProjectControlEvidenceCustodyPort;
      observeRuntime: (manifest: CodexGoalJobManifest) => Promise<{
        readonly workspaceDirty: boolean;
        readonly workerAlive: boolean;
        readonly resultExists: boolean;
        readonly resultPath?: string;
      }>;
      additionalSuperseded: readonly {
        readonly jobId: string;
        readonly manifestPath: string;
        readonly expectedManifestSha256: string;
      }[];
    }> = {}) => {
      const candidate = {
        ...legacyManifest,
        workspacePath: override.workspacePath ?? legacyManifest.workspacePath,
        ...(override.legacyOutputPath ? { outputPath: override.legacyOutputPath } : {}),
      };
      if (override.workspacePath || override.legacyOutputPath) {
        await writeFile(legacyManifestPath, `${JSON.stringify(candidate, null, 2)}\n`);
      }
      return await buildFrozenOutputImportPlan({
        custody: override.custody ?? evidenceCustody,
        scope: override.scope ?? scope,
        registryRootDir: registry,
        controllerJobId: "controller",
        jobIdPrefixes: ["legacy", "retained"],
        sourcePath: override.sourcePath ?? sourcePath,
        expectedSourceSha256: override.expectedSourceSha256 ?? sourceSha256,
        expectedSourceLength: (await readFile(sourcePath)).length,
        sourceManifestPath: override.sourceManifestPath ?? sourceManifestPath,
        expectedSourceManifestSha256: sha(await readFile(sourceManifestPath)),
        destinationEvidenceRoot: evidenceRoot,
        destinationLedgerRoot: ledgerRoot,
        changedPaths: override.changedPaths ?? ["a.ts"],
        baseCommit: "1".repeat(40),
        headCommit: "2".repeat(40),
        patchSha256: sourceSha256,
        retainedRegistrationJobId: retainedManifest.jobId,
        retainedManifestPath,
        expectedRetainedManifestSha256: sha(await readFile(retainedManifestPath)),
        expectedRetainedOutputSha256: sha(await readFile(retainedOutputPath)),
        observeRuntime: override.observeRuntime ?? (async () => ({
          workspaceDirty: override.workspaceDirty ?? true,
          workerAlive: override.workerAlive ?? false,
          resultExists: override.observedResultExists ?? false,
        })),
        superseded: [{
          jobId: candidate.jobId,
          manifestPath: legacyManifestPath,
          expectedManifestSha256: sha(await readFile(legacyManifestPath)),
        }, ...(override.additionalSuperseded ?? [])],
      });
    },
  };
}
