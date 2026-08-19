import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type {
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../codex-goal-jobs";
import {
  frozenOutputImportPlanSha256,
  frozenOutputSupersessionProjection,
  publishFrozenOutputImport,
  type FrozenOutputImportPlan,
} from "../application/project-control/codex-goal-frozen-output-import";

type FrozenPhaseAFixture = {
  readonly root: string;
  readonly registry: string;
  readonly sourcePath: string;
  readonly evidenceRoot: string;
  readonly scope: ProjectAccessScope;
  readonly summary: CodexGoalJobSummary;
  readonly legacyManifest: {
    readonly taskId: string;
    readonly jobRootDir: string;
  };
  readonly plan: (override?: {
    readonly custody?: ProjectControlEvidenceCustodyPort;
  }) => Promise<FrozenOutputImportPlan>;
};

export function certifyFrozenOutputPhaseA(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly fixture: () => Promise<FrozenPhaseAFixture>;
}): void {
  it.each(["file", "directory", "symlink", "other"] as const)(
    "treats a matching %s handoff entry as output evidence",
    async (kind) => {
      const fixture = await input.fixture();
      const handoffName =
        `${fixture.legacyManifest.taskId}.late.handoff.summary.json`;
      const handoffPath = join(fixture.legacyManifest.jobRootDir, handoffName);
      let custody = input.custody;
      if (kind === "file") await writeFile(handoffPath, "handoff\n");
      if (kind === "directory") await mkdir(handoffPath);
      if (kind === "symlink") await symlink(fixture.sourcePath, handoffPath);
      if (kind === "other") {
        custody = new Proxy(input.custody, {
          get(target, property, receiver) {
            if (property !== "listDirectory") {
              return Reflect.get(target, property, receiver);
            }
            return async (path: string) =>
              path === fixture.legacyManifest.jobRootDir
                ? [{ name: handoffName, kind: "other" as const }]
                : await target.listDirectory(path);
          },
        });
      }
      await expect(fixture.plan({ custody }))
        .rejects.toThrow("handoff_bearing_refused");
    },
  );

  it("restores a projected summary when a matching handoff directory appears", async () => {
    const fixture = await input.fixture();
    const plan = await fixture.plan();
    await publishFrozenOutputImport({
      custody: input.custody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    });
    await mkdir(join(fixture.legacyManifest.jobRootDir,
      `${fixture.legacyManifest.taskId}.late.handoff.manifest.json`));
    const projection = await project(fixture, input.custody);
    expect(projection.active).toEqual([fixture.summary]);
  });

  it("rejects an out-of-ledger receipt registration before reading it", async () => {
    const fixture = await input.fixture();
    const plan = await fixture.plan();
    const published = await publishFrozenOutputImport({
      custody: input.custody,
      scope: fixture.scope,
      plan,
      expectedPlanSha256: frozenOutputImportPlanSha256(plan),
      rebuildCurrentPlan: async () => plan,
    });
    const outside = join(fixture.root, "outside-ledger", "receipt.json");
    await writeFile(published.receipt.receiptPath, `${JSON.stringify({
      ...published.receipt,
      ledgerRegistrationPath: outside,
    }, null, 2)}\n`);
    let outsideReads = 0;
    const custody = observingCustody(input.custody, (method, path) => {
      if (method === "readImmutableFile" && path === outside) outsideReads += 1;
    });
    await expect(project(fixture, custody))
      .rejects.toThrow("receipt_scope_mismatch");
    expect(outsideReads).toBe(0);
  });
}

function project(
  fixture: FrozenPhaseAFixture,
  custody: ProjectControlEvidenceCustodyPort,
) {
  return frozenOutputSupersessionProjection({
    custody,
    scope: fixture.scope,
    registryRootDir: fixture.registry,
    evidenceRoots: [fixture.evidenceRoot],
    ...(fixture.scope.consumedOutputLedgerRoots
      ? { ledgerRoots: fixture.scope.consumedOutputLedgerRoots }
      : {}),
    projectId: "p0",
    controllerJobId: "controller",
    summaries: [fixture.summary],
    observeRuntime: async () => ({
      workspaceDirty: true,
      workerAlive: false,
      resultExists: false,
    }),
  });
}

export function observingCustody(
  custody: ProjectControlEvidenceCustodyPort,
  observe: (method: string, path: unknown) => void,
): ProjectControlEvidenceCustodyPort {
  return new Proxy(custody, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        observe(String(property), args[0]);
        return Reflect.apply(value, target, args);
      };
    },
  });
}
