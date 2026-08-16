import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type {
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../codex-goal-jobs";
import {
  buildLegacyJobSummaryRetirementPlan,
  legacyJobSummaryRetirementPlanSha256,
  projectRetirementProjection,
  publishLegacyJobSummaryRetirement,
  type LegacyJobSummaryRetirementPlan,
} from "../application/project-control/codex-goal-legacy-job-summary-retirement";
import {
  frozenOutputImportPlanSha256,
  frozenOutputSupersessionProjection,
  publishFrozenOutputImport,
  type FrozenOutputImportPlan,
} from "../application/project-control/codex-goal-frozen-output-import";
import { observingCustody } from
  "./codex-goal-frozen-output-phase-a-certification";

type RetirementFixture = {
  readonly root: string;
  readonly registry: string;
  readonly workspace: string;
  readonly manifestPath: string;
  readonly manifest: CodexGoalJobManifest;
  readonly summary: CodexGoalJobSummary;
  readonly plan: (override?: {
    readonly workerAlive?: boolean;
    readonly custody?: ProjectControlEvidenceCustodyPort;
  }) => Promise<LegacyJobSummaryRetirementPlan>;
};

type FrozenFixture = {
  readonly registry: string;
  readonly evidenceRoot: string;
  readonly scope: ProjectAccessScope;
  readonly summary: CodexGoalJobSummary;
  readonly legacyManifestPath: string;
  readonly legacyManifest: CodexGoalJobManifest;
  readonly plan: (override?: {
    readonly custody?: ProjectControlEvidenceCustodyPort;
    readonly workspaceDirty?: boolean;
    readonly workerAlive?: boolean;
    readonly observeRuntime?: (manifest: CodexGoalJobManifest) => Promise<{
      readonly workspaceDirty: boolean;
      readonly workerAlive: boolean;
      readonly resultExists: boolean;
      readonly resultPath?: string;
    }>;
  }) => Promise<FrozenOutputImportPlan>;
};

export function certifyControlDebtPhaseB(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly retirementFixture: () => Promise<RetirementFixture>;
  readonly frozenFixture: () => Promise<FrozenFixture>;
}): void {
  certifyRetirement(input);
  certifyFrozen(input);
}

function certifyRetirement(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly retirementFixture: () => Promise<RetirementFixture>;
}): void {
  it("binds manifest semantics to one custody read and re-proves before commit", async () => {
    const fixture = await input.retirementFixture();
    const retainedPath = join(fixture.registry, "retained", "job.json");
    const reads = new Map<string, number>();
    const custody = observingCustody(input.custody, (method, path) => {
      if (method === "readImmutableFile" && typeof path === "string") {
        reads.set(path, (reads.get(path) ?? 0) + 1);
      }
    });
    const plan = await buildLegacyJobSummaryRetirementPlan({
      custody,
      registryRootDir: fixture.registry,
      projectId: "p0",
      controllerJobId: "controller",
      jobIdPrefixes: ["legacy", "retained"],
      manifestPath: fixture.manifestPath,
      expectedManifestPath: fixture.manifestPath,
      expectedManifestSha256: sha(await readFile(fixture.manifestPath)),
      expectedWorkspacePath: fixture.workspace,
      retainedManifestPath: retainedPath,
      expectedRetainedManifestSha256: sha(await readFile(retainedPath)),
      observeRuntime: async (manifest) => {
        expect(manifest.jobId).toBe("legacy");
        return { workerAlive: false };
      },
    });
    expect(reads.get(fixture.manifestPath)).toBe(1);
    expect(reads.get(retainedPath)).toBe(1);
    await expect(publishLegacyJobSummaryRetirement({
      custody: input.custody,
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: legacyJobSummaryRetirementPlanSha256(plan),
      rebuildCurrentPlan: async () => {
        await mkdir(fixture.workspace, { recursive: true });
        return await fixture.plan();
      },
    })).rejects.toThrow("workspace_still_exists");
    expect(await readdir(fixture.registry)).not.toContain(".project-control");
  });

  it("restores a retired summary when current runtime evidence appears", async () => {
    const fixture = await input.retirementFixture();
    const plan = await fixture.plan();
    await publishLegacyJobSummaryRetirement({
      custody: input.custody,
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: legacyJobSummaryRetirementPlanSha256(plan),
      rebuildCurrentPlan: async () => await fixture.plan(),
    });
    const project = async (workerAlive: boolean) =>
      await projectRetirementProjection({
        custody: input.custody,
        registryRootDir: fixture.registry,
        projectId: "p0",
        controllerJobId: "controller",
        jobIdPrefixes: ["legacy", "retained"],
        summaries: [fixture.summary],
        observeRuntime: async () => ({ workerAlive }),
      });
    expect((await project(true)).active).toEqual([fixture.summary]);
    await mkdir(fixture.workspace, { recursive: true });
    expect((await project(false)).active).toEqual([fixture.summary]);
    await rm(fixture.workspace, { recursive: true });
    await writeFile(join(fixture.manifest.jobRootDir,
      `${fixture.manifest.taskId}.events.jsonl`), "late event\n");
    expect((await project(false)).active).toEqual([fixture.summary]);
  });

  it("restores a retired summary after a missing ancestor becomes a symlink", async () => {
    const fixture = await input.retirementFixture();
    const plan = await fixture.plan();
    await publishLegacyJobSummaryRetirement({
      custody: input.custody,
      registryRootDir: fixture.registry,
      plan,
      expectedPlanSha256: legacyJobSummaryRetirementPlanSha256(plan),
      rebuildCurrentPlan: async () => await fixture.plan(),
    });
    const replacementParent = join(dirname(fixture.registry), "replacement-parent");
    await mkdir(replacementParent);
    await symlink(replacementParent, dirname(fixture.workspace), "dir");
    let runtimeObserved = false;
    const projection = await projectRetirementProjection({
      custody: input.custody,
      registryRootDir: fixture.registry,
      projectId: "p0",
      controllerJobId: "controller",
      jobIdPrefixes: ["legacy", "retained"],
      summaries: [fixture.summary],
      observeRuntime: async () => {
        runtimeObserved = true;
        return { workerAlive: false };
      },
    });
    expect(projection.active).toEqual([fixture.summary]);
    expect(projection.retired).toEqual([]);
    expect(runtimeObserved).toBe(false);
  });

  it("rejects a detached renamed parent while proving retirement absence", async () => {
    const fixture = await input.retirementFixture();
    const parent = dirname(fixture.workspace);
    const moved = join(fixture.root, "gone-workspace-moved");
    const outside = join(fixture.root, "outside-workspace");
    await Promise.all([parent, outside].map((path) => mkdir(path)));
    let swapped = false;
    const custody = new Proxy(input.custody, {
      get(target, property, receiver) {
        if (property !== "openDirectoryForInspection") {
          return Reflect.get(target, property, receiver);
        }
        return async (path: string) => {
          const inspection = await target.openDirectoryForInspection(path);
          if (path !== parent) return inspection;
          return {
            ...inspection,
            pathKind: async (entryName: string) => {
              if (!swapped) {
                swapped = true;
                await rename(parent, moved);
                await symlink(outside, parent, "dir");
              }
              return await inspection.pathKind(entryName);
            },
          };
        };
      },
    });
    await expect(fixture.plan({ custody })).rejects.toThrow(
      "inspection_parent_drift",
    );
    expect(swapped).toBe(true);
  });

  it.each(["worker", "artifact"] as const)(
    "refuses retirement when %s evidence appears at the commit gate",
    async (race) => {
      const fixture = await input.retirementFixture();
      const plan = await fixture.plan();
      await expect(publishLegacyJobSummaryRetirement({
        custody: input.custody,
        registryRootDir: fixture.registry,
        plan,
        expectedPlanSha256: legacyJobSummaryRetirementPlanSha256(plan),
        rebuildCurrentPlan: async () => {
          if (race === "artifact") {
            await writeFile(join(fixture.manifest.jobRootDir,
              `${fixture.manifest.taskId}.progress.json`), "{}\n");
          }
          return await fixture.plan({ workerAlive: race === "worker" });
        },
      })).rejects.toThrow(race === "worker"
        ? "worker_live"
        : "runtime_artifact_present");
      expect(await readdir(fixture.registry)).not.toContain(".project-control");
    },
  );
}

function certifyFrozen(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly frozenFixture: () => Promise<FrozenFixture>;
}): void {
  it("binds frozen semantics to one custody generation and gates the final receipt", async () => {
    const fixture = await input.frozenFixture();
    let supersededReads = 0;
    const custody = observingCustody(input.custody, (method, path) => {
      if (method === "readImmutableFile" && path === fixture.legacyManifestPath) {
        supersededReads += 1;
      }
    });
    const plan = await fixture.plan({
      custody,
      observeRuntime: async (manifest) => {
        expect(manifest.jobId).toBe("legacy");
        return { workspaceDirty: true, workerAlive: false, resultExists: false };
      },
    });
    expect(supersededReads).toBe(1);
    const resultPath = join(fixture.legacyManifest.jobRootDir,
      `${fixture.legacyManifest.taskId}.latest-result.json`);
    await expect(publishFrozenOutputImport({
      custody: input.custody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => {
        await writeFile(resultPath, "late output\n");
        return await fixture.plan();
      },
    })).rejects.toThrow("output_bearing_refused");
    await expectNoFrozenReceipt(input.custody, fixture, plan);
  });

  it.each(["clean", "worker", "handoff"] as const)(
    "refuses frozen commitment when the candidate becomes %s at the commit gate",
    async (race) => {
      const fixture = await input.frozenFixture();
      const plan = await fixture.plan();
      await expect(publishFrozenOutputImport({
        custody: input.custody,
        scope: fixture.scope,
        plan,
        expectedPlanSha256: frozenOutputImportPlanSha256(plan),
        rebuildCurrentPlan: async () => {
          if (race === "handoff") {
            await mkdir(join(fixture.legacyManifest.jobRootDir,
              `${fixture.legacyManifest.taskId}.late.handoff.patch`));
          }
          return await fixture.plan({
            workspaceDirty: race !== "clean",
            workerAlive: race === "worker",
          });
        },
      })).rejects.toThrow(race === "clean"
        ? "dirty_workspace_required"
        : race === "worker" ? "worker_live" : "handoff_bearing_refused");
      await expectNoFrozenReceipt(input.custody, fixture, plan);
    },
  );

  it.each([
    { workspaceDirty: false, workerAlive: false, resultExists: false },
    { workspaceDirty: true, workerAlive: true, resultExists: false },
  ])("restores frozen summary for changed runtime facts %#", async (runtime) => {
    const fixture = await input.frozenFixture();
    const plan = await fixture.plan();
    await publishFrozenOutputImport({
      custody: input.custody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => await fixture.plan(),
    });
    const projection = await frozenOutputSupersessionProjection({
      custody: input.custody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      ...(fixture.scope.consumedOutputLedgerRoots === undefined
        ? {}
        : { ledgerRoots: fixture.scope.consumedOutputLedgerRoots }),
      projectId: "p0",
      controllerJobId: "controller",
      summaries: [fixture.summary],
      observeRuntime: async () => runtime,
    });
    expect(projection.active).toEqual([fixture.summary]);
    expect(projection.supersessions).toEqual([]);
  });
}

async function expectNoFrozenReceipt(
  custody: ProjectControlEvidenceCustodyPort,
  fixture: FrozenFixture,
  plan: FrozenOutputImportPlan,
): Promise<void> {
  const receiptPath = join(fixture.evidenceRoot, "frozen-output-imports",
    frozenOutputImportPlanSha256(plan), "receipt.json");
  expect(await custody.pathKind(receiptPath)).toBe("absent");
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
