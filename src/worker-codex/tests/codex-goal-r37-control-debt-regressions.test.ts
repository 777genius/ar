import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  localProjectControlEvidenceCustodySupported,
  LocalProjectControlEvidenceCustody,
} from
  "../../worker-local/project-control-evidence-custody-local-adapter";
import { planFromFrozenOutputReceipt } from
  "../application/project-control/codex-goal-frozen-output-contract";
import {
  frozenOutputImportPlanSha256,
  frozenOutputSupersessionProjection,
  publishFrozenOutputImport,
} from "../application/project-control/codex-goal-frozen-output-import";
import {
  createFrozenFixture,
  createRetirementFixture,
  manifestFor,
  sha,
  summaryFor,
  writeManifest,
} from "./codex-goal-control-debt-remediation-fixtures";

const roots = new Set<string>();
const custody = new LocalProjectControlEvidenceCustody();
const retainRoot = (root: string) => roots.add(root);
afterAll(async () => await Promise.all([...roots].map((root) =>
  rm(root, { recursive: true, force: true })
)));

describe.runIf(localProjectControlEvidenceCustodySupported)(
  "R37 control-debt regressions", () => {
  it("fails closed when retirement absence listing loses its lexical binding", async () => {
    const fixture = await createRetirementFixture(custody, retainRoot);
    const listedRoot = fixture.manifest.jobRootDir;
    let swapped = false;
    const racingCustody = listSwapCustody(listedRoot, async () => {
      await rename(listedRoot, `${listedRoot}-listed-original`);
      await mkdir(listedRoot);
      swapped = true;
    });
    await expect(fixture.plan({ custody: racingCustody })).rejects.toThrow(
      "inspection_parent_drift",
    );
    expect(swapped).toBe(true);
  });

  it("fails closed when frozen handoff absence listing loses its lexical binding", async () => {
    const fixture = await createFrozenFixture(custody, retainRoot);
    const listedRoot = fixture.legacyManifest.jobRootDir;
    let swapped = false;
    const racingCustody = listSwapCustody(listedRoot, async () => {
      await rename(listedRoot, `${listedRoot}-listed-original`);
      await mkdir(listedRoot);
      await writeFile(join(listedRoot,
        `${fixture.legacyManifest.taskId}.late.handoff.patch`), "late\n");
      swapped = true;
    });
    await expect(fixture.plan({ custody: racingCustody })).rejects.toThrow(
      "inspection_parent_drift",
    );
    expect(swapped).toBe(true);
  });

  it("reports mixed restoration without changing the immutable receipt hash", async () => {
    const fixture = await createFrozenFixture(custody, retainRoot);
    const secondManifest = manifestFor("legacy-second", fixture.workspace,
      join(fixture.registry, "legacy-second"));
    const secondManifestPath = await writeManifest(fixture.registry, secondManifest);
    const secondSummary = summaryFor(secondManifest, secondManifestPath);
    const plan = await fixture.plan({
      additionalSuperseded: [{
        jobId: secondManifest.jobId,
        manifestPath: secondManifestPath,
        expectedManifestSha256: sha(await readFile(secondManifestPath)),
      }],
    });
    await publishFrozenOutputImport({
      custody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    });
    const projection = await frozenOutputSupersessionProjection({
      custody,
      scope: fixture.scope,
      registryRootDir: fixture.registry,
      evidenceRoots: [fixture.evidenceRoot],
      summaries: [fixture.summary, secondSummary],
      observeRuntime: async (manifest) => ({
        workspaceDirty: true,
        workerAlive: false,
        resultExists: manifest.jobId === fixture.legacyManifest.jobId,
      }),
    });
    expect(projection.active).toEqual([fixture.summary]);
    expect(projection.supersessions).toHaveLength(1);
    const supersession = projection.supersessions[0]!;
    expect(supersession.supersededSummaries.map(({ jobId }) => jobId))
      .toEqual([secondManifest.jobId]);
    expect(supersession.receipt.supersededSummaries).toHaveLength(2);
    expect(frozenOutputImportPlanSha256(
      planFromFrozenOutputReceipt(supersession.receipt),
    )).toBe(supersession.receipt.planSha256);
  });
  });

function listSwapCustody(
  listedRoot: string,
  swap: () => Promise<void>,
): LocalProjectControlEvidenceCustody {
  return new LocalProjectControlEvidenceCustody(async (point, path) => {
    if (point === "after_directory_listing_before_lexical_revalidation" &&
      path === listedRoot) await swap();
  });
}
