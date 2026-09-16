import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";

const execFileAsync = promisify(execFile);
const D0A_COMMIT = "7d6d19a096f2cd0e3772f8369e6e09034c8b4280";
const D0A_BUILDER_SHA256 =
  "858be0c57bace3f1cc0e262357c78ccc0bd96b33031dbb437583e2afd849109e";
const D0A_COMPILED_BUILDER_SHA256 =
  "e0940490668806afa15c074fd3cd2e37d2ac6e1fdc19f95150efad40ed80e477";
type EpochBuilderModule = typeof import(
  "../application/project-control/codex-goal-consumed-output-ledger-epoch"
);
let isolatedD0aFixturePromise: Promise<EpochBuilderModule> | undefined;

export async function seedLegacyAdmissionHandlerFixture(input: {
  readonly root: string;
  readonly oldRoot: string;
  readonly consumedCount: number;
  readonly fastOrphanBoundaries?: boolean;
}): Promise<ProjectAdmissionSnapshot> {
  const itemsRoot = join(input.oldRoot, "items");
  const evidenceRoot = join(input.root, "legacy-admission-evidence");
  const statusPath = join(evidenceRoot, "status.txt");
  const patchPath = join(evidenceRoot, "tracked.patch");
  const numstatPath = join(evidenceRoot, "numstat.txt");
  await Promise.all([
    mkdir(itemsRoot, { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(statusPath, " M src/index.ts\n"),
    writeFile(patchPath, "diff --git a/src/index.ts b/src/index.ts\n"),
    writeFile(numstatPath, "1\t1\tsrc/index.ts\n"),
  ]);
  const consumedJobIds = Array.from({ length: input.consumedCount }, (_, index) =>
    `legacy-consumed-${index}`
  );
  const sharedJobWorkspace = join(input.root, "workspaces", "legacy-job-custody");
  await Promise.all(consumedJobIds.map(async (jobId) => {
    const workspace = sharedJobWorkspace;
    await seedJob(input.root, jobId, workspace);
    await writeFile(join(itemsRoot, `${jobId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      jobId,
      status: "rejected",
      closedAt: "2026-08-02T00:00:00.000Z",
      note: "hash-bound production legacy admission fixture",
      backup: { workspace, statusPath, patchPath, numstatPath },
    })}\n`);
  }));
  await Promise.all(Array.from({ length: 209 }, (_, index) =>
    writeFile(join(itemsRoot, `legacy-invalid-${index}.json`), "not-json\n")
  ));
  const orphanWorkspaces = input.fastOrphanBoundaries
    ? await sharedDirtyOrphanWorkspaces(input.root)
    : await dirtyOrphanWorkspaces(input.root);
  const activeJobIds = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const jobId = `legacy-active-writer-${index}`;
    await seedJob(input.root, jobId, sharedJobWorkspace);
    return jobId;
  }));
  return legacyAdmissionSnapshot(consumedJobIds, orphanWorkspaces, activeJobIds);
}

async function dirtyOrphanWorkspaces(root: string): Promise<readonly string[]> {
  const orphanTemplate = await dirtyOrphanWorkspace(root, "template");
  const paths = new Array<string>(205);
  let nextIndex = 0;
  const copyWorkspace = async (): Promise<void> => {
    while (nextIndex < paths.length) {
      const index = nextIndex++;
      const path = join(root, "worktrees", `legacy-orphan-${index}`);
      await cp(orphanTemplate, path, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
      paths[index] = path;
    }
  };
  await Promise.all(Array.from({ length: 32 }, copyWorkspace));
  return paths;
}

async function sharedDirtyOrphanWorkspaces(root: string): Promise<readonly string[]> {
  const orphanTemplate = await dirtyOrphanWorkspace(root, "template");
  return await Promise.all(Array.from({ length: 205 }, async (_, index) => {
    const path = join(root, "worktrees", `legacy-orphan-${index}`);
    await mkdir(path, { recursive: true });
    await Promise.all([
      symlink(join(orphanTemplate, ".git"), join(path, ".git"), "dir"),
      writeFile(join(path, "tracked.txt"), "dirty\n"),
    ]);
    return path;
  }));
}

export async function seedAuthenticD0aPreparedEpochV1(input: {
  readonly root: string;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly controllerJobId: string;
  readonly cutoff: string;
  readonly orphanWorkspacePaths: readonly string[];
  readonly controllerManifestSha256: string;
  readonly controllerStableScopeSha256: string;
}): Promise<Record<string, unknown>> {
  const exact = await isolatedD0aFixture();
  const plan = await exact.buildConsumedOutputLedgerEpochPlan({
    controllerJobId: input.controllerJobId,
    projectId: "social-monitor",
    oldRoot: input.oldRoot,
    newRoot: input.newRoot,
    cutoff: input.cutoff,
    currentJobIds: new Set([input.controllerJobId]),
    evidenceRoots: [
      input.root,
      join(input.root, "workspaces"),
      join(input.root, "worktrees"),
      input.oldRoot,
    ],
    deniedRoots: [join(input.root, "secrets")],
    orphanWorkspacePaths: input.orphanWorkspacePaths,
    controllerManifestSha256: input.controllerManifestSha256,
    controllerStableScopeSha256: input.controllerStableScopeSha256,
  });
  try {
    await exact.applyConsumedOutputLedgerEpoch({
      plan,
      expectedPlanSha256: plan.planSha256,
      buildCurrentPlan: async () => plan,
      admissionBefore: { debtCount: 710, counts: {
        unconsumedCompletedJobs: 495,
        orphanLegacyWorkspaces: 205,
        activeWriterConflicts: 6,
        inactiveDirtyWorkspaces: 4,
      } },
      validateProposedAdmission: async () => ({ debtCount: 414, counts: {
        legacyOutputQuarantineRequired: 414,
      } }),
      admissionForNewRoot: async () => ({ debtCount: 414 }),
      switchScope: async () => undefined,
      readActiveRoot: async () => input.oldRoot,
      revalidatePostSwitchBindings: async () => undefined,
      crashAfterPhase: "prepared",
    });
    throw new Error("ledger_epoch_exact_d0a_fixture_did_not_stop_at_prepared");
  } catch (error) {
    if (!(error instanceof Error) ||
      error.message !== "ledger_epoch_simulated_crash_after_prepared") throw error;
  }
  return plan as unknown as Record<string, unknown>;
}

export async function prepareAuthenticD0aFixture(): Promise<void> {
  await isolatedD0aFixture();
}

async function isolatedD0aFixture(): Promise<EpochBuilderModule> {
  isolatedD0aFixturePromise ??= createIsolatedD0aFixture();
  return await isolatedD0aFixturePromise;
}

async function createIsolatedD0aFixture(): Promise<EpochBuilderModule> {
  const cachedSourceRoot = join(
    tmpdir(),
    `subscription-runtime-d0a-${D0A_BUILDER_SHA256}-${process.versions.modules}`,
  );
  const cached = await loadCompiledD0aFixture(cachedSourceRoot);
  if (cached) return cached;
  const root = await mkdtemp(join(tmpdir(), "ledger-epoch-authentic-d0a-"));
  const archivePath = join(root, "d0a.tar");
  let sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  await execFileAsync("git", [
    "archive",
    `--output=${archivePath}`,
    D0A_COMMIT,
  ]);
  await execFileAsync("tar", ["-xf", archivePath, "-C", sourceRoot]);
  await symlink(join(process.cwd(), "node_modules"), join(sourceRoot, "node_modules"), "dir");
  const builderPath = join(
    sourceRoot,
    "src/worker-codex/application/project-control/codex-goal-consumed-output-ledger-epoch.ts",
  );
  const builderBytes = await readFile(builderPath);
  if (createHash("sha256").update(builderBytes).digest("hex") !== D0A_BUILDER_SHA256) {
    throw new Error("ledger_epoch_authentic_d0a_builder_hash_mismatch");
  }
  await execFileAsync(join(process.cwd(), "node_modules", ".bin", "tsc"), [
    "-p",
    "tsconfig.build.json",
    "--noCheck",
  ], { cwd: sourceRoot, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  await execFileAsync(process.execPath, ["scripts/rewrite-dist-esm-imports.mjs"], {
    cwd: sourceRoot,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    await rename(sourceRoot, cachedSourceRoot);
    sourceRoot = cachedSourceRoot;
  } catch (error) {
    if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) {
      throw error;
    }
    const raced = await loadCompiledD0aFixture(cachedSourceRoot);
    if (raced) return raced;
  }
  const compiled = await loadCompiledD0aFixture(sourceRoot);
  if (!compiled) throw new Error("ledger_epoch_authentic_d0a_cache_invalid");
  return compiled;
}

async function loadCompiledD0aFixture(
  sourceRoot: string,
): Promise<EpochBuilderModule | undefined> {
  const builderPath = join(
    sourceRoot,
    "src/worker-codex/application/project-control/codex-goal-consumed-output-ledger-epoch.ts",
  );
  const modulePath = join(
    sourceRoot,
    "dist/worker-codex/application/project-control/codex-goal-consumed-output-ledger-epoch.js",
  );
  try {
    const builderBytes = await readFile(builderPath);
    if (createHash("sha256").update(builderBytes).digest("hex") !==
      D0A_BUILDER_SHA256) return undefined;
    await access(modulePath);
    const compiledBytes = await readFile(modulePath);
    if (createHash("sha256").update(compiledBytes).digest("hex") !==
      D0A_COMPILED_BUILDER_SHA256) return undefined;
    return await import(pathToFileURL(modulePath).href) as EpochBuilderModule;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function legacyAdmissionSnapshot(
  consumedJobIds: readonly string[],
  orphanWorkspaces: readonly string[],
  activeJobIds: readonly string[],
): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "social-monitor",
    observedAt: "2026-08-08T00:00:00.000Z",
    debt: [
      ...consumedJobIds.map((subject, index) => ({
        reason: ProjectDebtReason.UnconsumedCompletedJob,
        subject,
        severity: "blocking" as const,
        evidence: [`legacy unconsumed job ${index}`],
      })),
      ...orphanWorkspaces.map((subject, index) => ({
        reason: ProjectDebtReason.OrphanLegacyWorkspace,
        subject,
        severity: "blocking" as const,
        evidence: [`legacy orphan ${index}`],
      })),
      ...activeJobIds.map((subject, index) => ({
        reason: ProjectDebtReason.ActiveWriterConflict,
        subject,
        severity: "blocking" as const,
        evidence: [`inactive shared-workspace conflict ${index}`],
      })),
      ...orphanWorkspaces.slice(6, 10).map((subject, index) => ({
        reason: ProjectDebtReason.InactiveDirtyWorkspace,
        subject,
        severity: "blocking" as const,
        evidence: [`inactive dirty workspace ${index}`],
      })),
    ],
  };
}

async function seedJob(root: string, jobId: string, workspacePath: string): Promise<void> {
  const jobRootDir = join(root, "registry", jobId);
  await Promise.all([
    mkdir(jobRootDir, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  await writeFile(join(jobRootDir, "job.json"), `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    jobRootDir,
    workspacePath,
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: jobId,
    accounts: ["account-a"],
  }, null, 2)}\n`);
}

async function dirtyOrphanWorkspace(root: string, index: number | string): Promise<string> {
  const path = join(root, "worktrees", `legacy-orphan-${index}`);
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: path,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: path });
  await writeFile(join(path, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: path });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: path });
  await writeFile(join(path, "tracked.txt"), "dirty\n");
  return path;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
