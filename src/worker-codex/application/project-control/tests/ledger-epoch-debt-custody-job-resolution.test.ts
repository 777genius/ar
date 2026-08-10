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

  it.each([
    "social-monitor-recovery-runtime-acl-v2b-20260731",
    "social-monitor-recovery-runtime-acl-v2c-20260731",
  ])("selects %s only from its exact whole evidence line", async (jobId) => {
    const first = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2b-20260731",
    );
    const second = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2c-20260731",
      first,
    );

    const custody = await resolveLedgerEpochDebtCustody(
      debtSnapshot(first.workspacePath, [
        "unrelated context",
        `prefix\n${jobId} is inactive with dirty workspace\nsuffix`,
      ]),
      [first.summary, second.summary],
    );

    expect(custody).toMatchObject([{ jobId, subject: first.workspacePath }]);
  });

  it.each([
    ["missing", []],
    ["wrong", [
      "social-monitor-recovery-runtime-acl-v2b-20260731 is inactive with dirty workspace suffix",
    ]],
    ["ambiguous", [
      "social-monitor-recovery-runtime-acl-v2b-20260731 is inactive with dirty workspace",
      "social-monitor-recovery-runtime-acl-v2c-20260731 is inactive with dirty workspace",
    ]],
  ])("rejects %s evidence for a shared workspace", async (_case, evidence) => {
    const first = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2b-20260731",
    );
    const second = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2c-20260731",
      first,
    );

    await expect(resolveLedgerEpochDebtCustody(
      debtSnapshot(first.workspacePath, evidence),
      [first.summary, second.summary],
    )).rejects.toThrow(
      `ledger_epoch_debt_job_manifest_ambiguous:${first.workspacePath}`,
    );
  });

  it("replays a shared-workspace binding by anchored jobId without evidence", async () => {
    const first = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2b-20260731",
    );
    const second = await jobFixture(
      "social-monitor-recovery-runtime-acl-v2c-20260731",
      first,
    );
    const custody = await resolveLedgerEpochDebtCustody(
      debtSnapshot(first.workspacePath, [
        `${first.summary.jobId} is inactive with dirty workspace`,
      ]),
      [first.summary, second.summary],
    );

    await expect(assertLedgerEpochDebtCustodyUnchanged(
      custody,
      [first.summary, second.summary],
    )).resolves.toBeUndefined();
  });

  it("fails replay for missing, nonunique, or changed anchored job facts", async () => {
    const fixture = await jobFixture("anchored-job");
    const custody = await resolveLedgerEpochDebtCustody(
      debtSnapshot(fixture.summary.jobId),
      [fixture.summary],
    );
    const duplicate = { ...fixture.summary };
    const changed = {
      ...fixture.summary,
      updatedAt: "2026-08-10T00:00:01.000Z",
    };

    for (const summaries of [
      [],
      [{ ...fixture.summary, jobId: "wrong-job" }],
      [fixture.summary, duplicate],
      [changed],
    ]) {
      await expect(assertLedgerEpochDebtCustodyUnchanged(custody, summaries))
        .rejects.toThrow("ledger_epoch_debt_custody_drift");
    }
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

function debtSnapshot(
  subject: string,
  evidence: readonly string[] = [],
): ProjectAdmissionSnapshot {
  return {
    schemaVersion: 1,
    projectId: "ledger-epoch-custody-test",
    observedAt: "2026-08-10T00:00:00.000Z",
    debt: [{
      reason: ProjectDebtReason.UnconsumedCompletedJob,
      subject,
      severity: "blocking",
      evidence,
    }],
  };
}

async function jobFixture(
  jobId: string,
  shared?: { readonly root: string; readonly workspacePath: string },
): Promise<{
  readonly root: string;
  readonly workspacePath: string;
  readonly summary: CodexGoalJobSummary;
}> {
  const root = shared?.root ??
    await mkdtemp(join(tmpdir(), "ledger-epoch-debt-custody-"));
  const workspacePath = shared?.workspacePath ?? join(root, "workspace");
  const jobRoot = join(root, `${jobId}-job`);
  const manifestPath = join(jobRoot, "job.json");
  if (!shared) await mkdir(workspacePath);
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
