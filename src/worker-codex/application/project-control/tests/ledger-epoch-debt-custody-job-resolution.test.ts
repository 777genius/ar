import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../../../codex-goal-jobs";
import {
  assertLedgerEpochDebtCustodyUnchanged,
  resolveLedgerEpochDebtCustody,
} from "../codex-goal-consumed-output-ledger-epoch-switch";

describe("ledger epoch debt custody job resolution", () => {
  it("resolves a target-shaped absolute debt subject to its unique manifest", async () => {
    const fixture = await jobFixture("target-job");
    const snapshot = debtSnapshot(fixture.workspacePath);

    const custody = await resolveLedgerEpochDebtCustody(snapshot, [fixture.summary]);

    expect(custody).toHaveLength(1);
    expect(custody[0]).toMatchObject({
      subject: fixture.workspacePath,
      jobId: fixture.summary.jobId,
      declaredPath: fixture.workspacePath,
      canonicalPath: await realpath(fixture.workspacePath),
      registryManifest: {
        path: fixture.summary.manifestPath,
        present: true,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(assertLedgerEpochDebtCustodyUnchanged(custody, [fixture.summary]))
      .resolves.toBeUndefined();
  });

  it("uses a unique canonical workspace match when normalized paths differ", async () => {
    const fixture = await jobFixture("canonical-job");
    const aliasPath = join(fixture.root, "workspace-alias");
    await symlink(fixture.workspacePath, aliasPath, "dir");
    const summary = { ...fixture.summary, workspacePath: aliasPath };

    await expect(resolveLedgerEpochDebtCustody(
      debtSnapshot(fixture.workspacePath),
      [summary],
    )).resolves.toMatchObject([{ jobId: summary.jobId, declaredPath: aliasPath }]);
  });

  it("rejects duplicate workspace summaries as ambiguous before binding custody", async () => {
    const fixture = await jobFixture("duplicate-job-a");
    const duplicate = {
      ...fixture.summary,
      jobId: "duplicate-job-b",
      manifestPath: join(fixture.root, "missing-job.json"),
    };
    const first = {
      ...fixture.summary,
      manifestPath: join(fixture.root, "also-missing-job.json"),
    };

    await expect(resolveLedgerEpochDebtCustody(
      debtSnapshot(fixture.workspacePath),
      [first, duplicate],
    )).rejects.toThrow(
      `ledger_epoch_debt_job_manifest_ambiguous:${fixture.workspacePath}`,
    );
  });

  it("preserves the missing-manifest error for an unmatched absolute subject", async () => {
    const fixture = await jobFixture("other-job");
    const unmatched = join(fixture.root, "unmatched-workspace");
    await mkdir(unmatched);

    await expect(resolveLedgerEpochDebtCustody(
      debtSnapshot(unmatched),
      [fixture.summary],
    )).rejects.toThrow(`ledger_epoch_debt_job_manifest_missing:${unmatched}`);
  });
});

function debtSnapshot(subject: string): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "ledger-epoch-custody-test",
    observedAt: "2026-08-10T00:00:00.000Z",
    debt: [{
      reason: ProjectDebtReason.UnconsumedCompletedJob,
      subject,
      severity: "blocking",
      evidence: [],
    }],
  };
}

async function jobFixture(jobId: string): Promise<{
  readonly root: string;
  readonly workspacePath: string;
  readonly summary: CodexGoalJobSummary;
}> {
  const root = await mkdtemp(join(tmpdir(), "ledger-epoch-debt-custody-"));
  const workspacePath = join(root, "workspace");
  const jobRoot = join(root, "job");
  const manifestPath = join(jobRoot, "job.json");
  await mkdir(workspacePath);
  await mkdir(jobRoot);
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    jobId,
    taskId: jobId,
    jobRootDir: jobRoot,
    workspacePath,
  })}\n`);
  return {
    root,
    workspacePath,
    summary: {
      jobId,
      tags: [],
      taskId: jobId,
      workspacePath,
      promptPath: join(jobRoot, "prompt.md"),
      accountNames: [],
      updatedAt: "2026-08-10T00:00:00.000Z",
      manifestPath,
    },
  };
}
