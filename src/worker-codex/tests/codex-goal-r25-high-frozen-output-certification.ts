import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type {
  EvidenceDirectoryInspection,
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  frozenOutputImportPlanSha256,
  publishFrozenOutputImport,
  type FrozenOutputImportPlan,
} from "../application/project-control/codex-goal-frozen-output-import";
import { observingCustody } from "./codex-goal-frozen-output-phase-a-certification";

type HighFixFixture = {
  readonly root: string;
  readonly evidenceRoot: string;
  readonly workspace: string;
  readonly scope: ProjectAccessScope;
  plan(override?: Partial<{
    custody: ProjectControlEvidenceCustodyPort;
    legacyOutputPath: string;
  }>): Promise<FrozenOutputImportPlan>;
};

export function certifyR25HighFrozenOutput(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly fixture: () => Promise<HighFixFixture>;
}): void {
  it.each([
    "custodyOutputPath", "custodySourceManifestPath",
    "custodyRetainedManifestPath", "custodyRetainedOutputPath", "receiptPath",
    "ledgerRegistrationPath", "importedAt-invalid", "importedAt-noncanonical",
  ] as const)("rejects a prepared receipt with conflicting %s before publication",
    async (field) => {
      const fixture = await input.fixture();
      const plan = await fixture.plan();
      const planSha256 = frozenOutputImportPlanSha256(plan);
      const importRoot = join(fixture.evidenceRoot, "frozen-output-imports",
        planSha256);
      const ledgerRegistrationPath = join(plan.destinationLedgerRoot,
        "frozen-output-imports", `${planSha256}.json`);
      const expected = {
        ...plan, planSha256, importedAt: "2026-08-15T00:00:00.000Z",
        custodyOutputPath: join(importRoot, "output.patch"),
        custodySourceManifestPath: join(importRoot, "source-manifest.json"),
        custodyRetainedManifestPath: join(importRoot, "retained-manifest.json"),
        custodyRetainedOutputPath: join(importRoot, "retained-output.json"),
        receiptPath: join(importRoot, "receipt.json"), ledgerRegistrationPath,
      };
      const forgedPath = join(fixture.root, "forged", field);
      const receipt = field === "importedAt-invalid"
        ? { ...expected, importedAt: "not-a-date" }
        : field === "importedAt-noncanonical"
        ? { ...expected, importedAt: "2026-08-15T00:00:00Z" }
        : { ...expected, [field]: forgedPath };
      const prepared = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
      await mkdir(dirname(ledgerRegistrationPath), { recursive: true });
      await writeFile(ledgerRegistrationPath, prepared);
      let publications = 0;
      let copies = 0;
      let forgedReads = 0;
      const custody = observingCustody(input.custody, (method, argument) => {
        if (method === "publishImmutableBytes") publications += 1;
        if (method === "copyImmutableFile") copies += 1;
        if (argument === forgedPath) forgedReads += 1;
      });
      await expect(publishFrozenOutputImport({
        custody, scope: fixture.scope, plan, expectedPlanSha256: planSha256,
        rebuildCurrentPlan: async () => plan,
      })).rejects.toThrow("frozen_output_import_ledger_conflict");
      expect({ publications, copies, forgedReads }).toEqual({
        publications: 0, copies: 0, forgedReads: 0,
      });
      expect(await readdir(fixture.evidenceRoot)).toEqual([]);
      expect(await readFile(ledgerRegistrationPath)).toEqual(prepared);
    });

  it("recovers after a crash following ledger-first reservation", async () => {
    const fixture = await input.fixture();
    const plan = await fixture.plan();
    const planSha256 = frozenOutputImportPlanSha256(plan);
    let crashed = false;
    const custody = new Proxy(input.custody, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!crashed && property === "copyImmutableFile") {
            crashed = true;
            throw new Error("simulated_post_reservation_crash");
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    await expect(publishFrozenOutputImport({
      custody, scope: fixture.scope, plan, expectedPlanSha256: planSha256,
      rebuildCurrentPlan: async () => plan,
      now: new Date("2026-08-15T00:00:00.000Z"),
    })).rejects.toThrow("simulated_post_reservation_crash");
    const ledgerPath = join(plan.destinationLedgerRoot,
      "frozen-output-imports", `${planSha256}.json`);
    const reserved = await readFile(ledgerPath);
    const recovered = await publishFrozenOutputImport({
      custody: input.custody, scope: fixture.scope, plan,
      expectedPlanSha256: planSha256, rebuildCurrentPlan: async () => plan,
    });
    expect(recovered.receipt.importedAt).toBe("2026-08-15T00:00:00.000Z");
    expect(await readFile(ledgerPath)).toEqual(reserved);
  });

  it("binds path classification to an authorized open parent capability", async () => {
    const rootEqual = await input.fixture();
    let parentInspections = 0;
    const rootCustody = observingCustody(input.custody, (method, argument) => {
      if (method === "openDirectoryForInspection" &&
        argument === dirname(rootEqual.root)) parentInspections += 1;
    });
    await expect(rootEqual.plan({
      legacyOutputPath: rootEqual.root, custody: rootCustody,
    })).rejects.toThrow("output_bearing_refused");
    expect(parentInspections).toBe(0);

    const swapped = await input.fixture();
    const outputParent = join(swapped.root, "original-result-parent");
    const outsideParent = join(swapped.root, "outside-result-parent");
    await Promise.all([outputParent, outsideParent].map((path) => mkdir(path)));
    await writeFile(join(outsideParent, "race-result.json"), "outside result\n");
    let swapReached = false;
    const swapCustody = inspectionCustody(input.custody, async (inspection) => ({
      ...inspection,
      pathKind: async (entryName: string) => {
        if (!swapReached) {
          swapReached = true;
          await rename(outputParent, `${outputParent}-moved`);
          await symlink(outsideParent, outputParent, "dir");
        }
        return await inspection.pathKind(entryName);
      },
    }));
    await expect(swapped.plan({
      legacyOutputPath: join(outputParent, "race-result.json"),
      custody: swapCustody,
    })).rejects.toThrow("inspection_parent_drift");
    expect(swapReached).toBe(true);

    const rejected = await input.fixture();
    const outsideCanonicalParent = await mkdtemp(join(tmpdir(),
      "foreign-inspection-parent-"));
    let closed = 0;
    const rejectedCustody = inspectionCustody(input.custody,
      async (inspection) => ({
        ...inspection, canonicalPath: outsideCanonicalParent,
        close: async () => { closed += 1; await inspection.close(); },
      }));
    await expect(rejected.plan({
      legacyOutputPath: join(rejected.workspace, "absent-result.json"),
      custody: rejectedCustody,
    })).rejects.toThrow("path_outside_project_scope");
    expect(closed).toBe(1);
    await rm(outsideCanonicalParent, { recursive: true, force: true });
  });
}

function inspectionCustody(
  custody: ProjectControlEvidenceCustodyPort,
  wrap: (inspection: EvidenceDirectoryInspection) =>
    Promise<EvidenceDirectoryInspection>,
): ProjectControlEvidenceCustodyPort {
  return new Proxy(custody, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "openDirectoryForInspection") {
        return (...args: unknown[]) => Reflect.apply(value, target, args);
      }
      return async (...args: unknown[]) => await wrap(
        await Reflect.apply(value, target, args) as EvidenceDirectoryInspection,
      );
    },
  });
}
