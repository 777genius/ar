import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  recordFailedNoOutput,
  type TerminalOutputBackup,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerWriter } from "@vioxen/subscription-runtime/worker-local";
import { readCodexGoalConsumedOutputLedgers } from
  "../application/project-control/codex-goal-consumed-output-ledger-io";
import { buildCodexProjectAdmissionSnapshot, codexProjectAdmissionGate } from
  "../application/project-control/codex-goal-project-admission";

const SOURCE_TIME = "2026-10-01T00:00:00.000Z";
const CORRECTION_TIME = "2026-10-02T00:00:00.000Z";

describe("failed_no_output correction admission on local files", () => {
  it("retires only the matching obsolete debt after an append-only correction and replay", async () => {
    const fixture = await createFixture();
    try {
      // These are real ledger/evidence files; only registry/runtime observations
      // are controlled. No provider or process is launched by admission.
      const { ledgerRoot, jobId, backup, sourcePath } = fixture;
      const sourceBytes = await readFile(sourcePath);
      const peerBackup = await fixture.createBackup("peer", "peer authored patch\n");
      const peerPath = await fixture.writeRecord("project-peer", {
        ...fixture.sourceValue,
        jobId: "project-peer",
        backup: peerBackup,
      });
      const preservedPaths = [sourcePath, backup.statusPath, backup.patchPath!,
        peerPath, peerBackup.statusPath, peerBackup.patchPath!];
      const preservedBytes = await Promise.all(preservedPaths.map((path) => readFile(path)));
      const before = await fixture.snapshot();
      expect(before.counts?.incompleteConsumedOutputRecords).toBe(1);
      await expect(fixture.admitProducer()).resolves.toMatchObject({
        allowed: false, reason: "output_debt_present",
      });

      const ledger = await fixture.readLedger();
      const sourceRecord = ledger.byJobId.get(jobId)!;
      expect(sourceRecord).toMatchObject({
        valid: false, reclassifiableAsFailedNoOutput: true, hasAuthoredOutput: false,
      });
      const writer = new LocalConsumedOutputLedgerWriter(undefined, fixture.root, [fixture.evidenceRoot]);
      const correction = {
        allowedLedgerRoots: [ledgerRoot], ledgerRoot, sourceRecord, jobId,
        workspace: backup.workspace, workerAlive: false, workspaceDirty: false,
        attemptId: "no-output-correction", closedAt: CORRECTION_TIME,
        failureCategory: "infrastructure", failureCode: "failed_before_task",
        note: "Corrected empty rejected output without removing history.",
      };
      const first = await recordFailedNoOutput({ writer }, correction);
      const replay = await recordFailedNoOutput({ writer }, correction);
      expect(first.idempotentReplay).toBe(false);
      expect(replay).toMatchObject({ ledgerPath: first.ledgerPath, idempotentReplay: true });
      expect(first.ledgerPath).not.toBe(sourcePath);
      expect(await readFile(sourcePath)).toEqual(sourceBytes);
      expect(await readdir(join(ledgerRoot, "items"))).toHaveLength(3);
      expect(await Promise.all(preservedPaths.map((path) => readFile(path)))).toEqual(preservedBytes);

      const afterLedger = await fixture.readLedger();
      expect(afterLedger.byJobId.get(jobId)).toMatchObject({ status: "failed_no_output", valid: true });
      expect(afterLedger.byJobId.get("project-peer")).toMatchObject({ status: "rejected", valid: true, hasAuthoredOutput: true });
      expect.soft(afterLedger.debt).toEqual([]);
      const after = await fixture.snapshot();
      expect.soft(after.counts).toMatchObject({ incompleteConsumedOutputRecords: 0, unreadableRoots: 0 });
      expect.soft(await fixture.admitProducer()).toMatchObject({ allowed: true, reason: "allowed" });

      // Correction of a terminal job never clears an independently live producer.
      await expect(fixture.admitProducer(true)).resolves.toMatchObject({
        allowed: false,
        debt: [expect.objectContaining({ reason: ProjectDebtReason.ActiveWriterConflict })],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves pruned retention evidence beside a valid no-output decision", async () => {
    const fixture = await createFixture();
    try {
      const note = "Rejected output retained by the terminal writer.";
      await writeFile(fixture.sourcePath, JSON.stringify({
        ...fixture.sourceValue, note, consumedAt: SOURCE_TIME,
        notes: [{ status: "rejected", text: note }],
      }));
      await rm(fixture.backup.statusPath);
      await rm(fixture.backup.patchPath!);
      await fixture.writeRecord(`${fixture.jobId}--correction`, {
        ...fixture.correctionValue(), backup: await fixture.createBackup("correction"),
      });
      const ledger = await fixture.readLedger();
      expect(ledger.byJobId.get(fixture.jobId)).toMatchObject({ status: "failed_no_output", valid: true });
      expect(ledger.debt).toEqual([expect.objectContaining({
        reason: ProjectDebtReason.RetentionEvidenceMissing, severity: "info", subject: fixture.sourcePath,
      })]);
      expect((await fixture.snapshot()).counts).toMatchObject({
        incompleteConsumedOutputRecords: 0, retentionEvidenceMissing: 1,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    "other job", "other workspace", "other backup", "authored source", "authored commit",
    "active source", "unknown source", "unreadable source", "newer source",
    "equal timestamp", "invalid source timestamp", "invalid correction",
    "missing source evidence", "newer invalid record", "foreign filename",
  ] as const)("keeps %s debt despite a failed_no_output record", async (control) => {
    const fixture = await createFixture();
    try {
      let sourceValue = { ...fixture.sourceValue };
      let correctionValue = fixture.correctionValue();
      switch (control) {
        case "other job":
          correctionValue = { ...correctionValue, jobId: "project-other" };
          break;
        case "other workspace":
          correctionValue = { ...correctionValue, backup: { ...fixture.backup, workspace: join(fixture.root, "other") } };
          break;
        case "other backup":
          correctionValue = { ...correctionValue, backup: await fixture.createBackup("other") };
          break;
        case "authored source":
          // Source is structurally invalid but carries real authored bytes.
          sourceValue = { ...sourceValue, note: "" };
          sourceValue.backup = await fixture.createBackup("authored", "authored patch\n");
          break;
        case "authored commit":
          sourceValue = { ...sourceValue, status: "integrated", commitSha: "a".repeat(40), note: "" };
          break;
        case "active source": sourceValue = { ...sourceValue, active: true }; break;
        case "unknown source": sourceValue = { ...sourceValue, status: "unknown" }; break;
        case "unreadable source": break;
        case "newer source": sourceValue = { ...sourceValue, closedAt: "2026-10-03T00:00:00.000Z" }; break;
        case "equal timestamp": correctionValue = { ...correctionValue, closedAt: SOURCE_TIME }; break;
        case "invalid source timestamp": sourceValue = { ...sourceValue, closedAt: "not-a-date" }; break;
        case "invalid correction": correctionValue = { ...correctionValue, failure: {} }; break;
        case "missing source evidence": sourceValue.backup = { ...fixture.backup, patchPath: join(fixture.evidenceRoot, "missing.patch") }; break;
        case "newer invalid record":
          await fixture.writeRecord(`${fixture.jobId}--later`, { ...sourceValue, closedAt: "2026-10-03T00:00:00.000Z" });
          break;
        case "foreign filename": break;
      }
      await writeFile(fixture.sourcePath, control === "unreadable source"
        ? "{broken JSON" : `${JSON.stringify(sourceValue)}\n`);
      const correctionPath = await fixture.writeRecord(control === "foreign filename" ? "project-foreign"
        : `${correctionValue.jobId}--zz-correction`, correctionValue);
      const sourceBytes = await readFile(fixture.sourcePath);
      const ledger = await fixture.readLedger();
      const reason = ["unreadable source", "foreign filename"].includes(control)
        ? ProjectDebtReason.UnreadableRoot : ProjectDebtReason.IncompleteConsumedOutputRecord;
      expect(ledger.debt).toContainEqual(expect.objectContaining({
        reason, severity: "blocking",
        subject: control === "foreign filename" ? correctionPath : fixture.sourcePath,
      }));
      expect(await readFile(fixture.sourcePath)).toEqual(sourceBytes);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "TEST-pr170-correction-"));
  const ledgerRoot = join(root, "ledger");
  const evidenceRoot = join(root, "evidence");
  const workspace = join(root, "workspace");
  const jobId = "project-worker";
  await mkdir(join(ledgerRoot, "items"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  async function createBackup(name: string, patch = ""): Promise<TerminalOutputBackup> {
    const directory = join(evidenceRoot, name);
    await mkdir(directory, { recursive: true });
    const backup = { workspace, statusPath: join(directory, "status.txt"), patchPath: join(directory, "output.patch") };
    await writeFile(backup.statusPath, "");
    await writeFile(backup.patchPath, patch);
    return backup;
  }
  async function writeRecord(name: string, value: unknown) {
    const path = join(ledgerRoot, "items", `${name}.json`);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }
  const backup = await createBackup("source");
  const sourceValue: Record<string, unknown> & { jobId: string; backup: TerminalOutputBackup } = {
    schemaVersion: 1, jobId, status: "rejected", closedAt: SOURCE_TIME,
    note: "Incorrectly rejected infrastructure failure.", backup,
  };
  const sourcePath = await writeRecord(jobId, sourceValue);
  const scope = {
    projectId: "TEST-pr170", readRoots: [root], jobIdPrefixes: ["project-"],
    consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot],
  };
  function admissionInput(activeProducer = false) {
    return {
      scope, registryRootDir: join(root, "registry"), controllerJobId: "project-controller",
      deps: {
        listJobs: async () => activeProducer ? [{
          jobId: "project-live", workspacePath: workspace, taskId: "project-live",
          tags: ["worker-role-producer"], promptPath: join(root, "synthetic-prompt.md"),
          accountNames: [], updatedAt: CORRECTION_TIME, manifestPath: join(root, "synthetic-manifest.json"),
        }] : [],
        buildOverviewItems: async () => activeProducer ? [{
          ok: true, jobId: "project-live", workspacePath: workspace, workspaceDirty: false,
          workerAlive: true, activeWriterRisk: "active_worker", activeWriterRiskReasons: ["controlled live producer fact"],
        }] : [],
      },
    };
  }
  return {
    root, ledgerRoot, evidenceRoot, jobId, backup, sourcePath, sourceValue,
    createBackup, writeRecord,
    correctionValue: (): typeof sourceValue => ({
      ...sourceValue, status: "failed_no_output", closedAt: CORRECTION_TIME,
      failure: { category: "infrastructure", code: "failed_before_task" },
      output: { authoredChanges: false, workspaceDirty: false },
    }),
    readLedger: async () => readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot], evidenceRoots: [evidenceRoot] }),
    snapshot: async () => buildCodexProjectAdmissionSnapshot(admissionInput()),
    admitProducer: async (activeProducer = false) => codexProjectAdmissionGate(admissionInput(activeProducer)).evaluate({
      operation: ProjectOperation.StartWorker, workerRole: ProjectAdmissionWorkerRole.Producer,
      jobId: "project-fresh", workspacePath: workspace,
    }),
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}
