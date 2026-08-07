import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  evaluateProjectAdmission,
  projectAdmissionDebtCounts,
  type ProjectAdmissionSnapshot,
  type WorkspaceLock,
  type WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalConsumedOutputLedgers } from "../codex-goal-consumed-output-ledger-io";
import { repairLegacyConsumedOutputDebt } from "../legacy-consumed-output-repair";

describe("legacy consumed-output repair", () => {
  it("previews without writes, bulk quarantines exact bytes, and replays idempotently", async () => {
    const fixture = await makeFixture(3);
    try {
      const original = await readFile(fixture.paths[0]!);
      const preview = await repair(fixture, false);
      expect(preview).toMatchObject({
        mode: "preview",
        eligibleCount: 3,
        quarantinedCount: 0,
      });
      expect(await readFile(fixture.paths[0]!)).toEqual(original);
      await expect(access(join(fixture.ledgerRoot, "quarantine"))).rejects.toThrow();

      const confirmed = await repair(fixture, true);
      expect(confirmed).toMatchObject({
        mode: "confirmed",
        eligibleCount: 3,
        quarantinedCount: 3,
      });
      const quarantinePath = confirmed.items[0]!.quarantinePath!;
      expect(await readFile(quarantinePath)).toEqual(original);
      expect(createHash("sha256").update(original).digest("hex"))
        .toBe(confirmed.items[0]!.sha256);
      expect((await lstat(quarantinePath)).mode & 0o777).toBe(0o400);
      const receipts = (await readFile(
        join(fixture.ledgerRoot, "quarantine", "legacy-consumed-output", "manifest.jsonl"),
        "utf8",
      )).trim().split("\n").map((line) => JSON.parse(line) as { phase: string });
      expect(receipts.filter((receipt) => receipt.phase === "prepared")).toHaveLength(3);
      expect(receipts.filter((receipt) => receipt.phase === "quarantined")).toHaveLength(3);
      expect(fixture.locks.maxHeld).toBe(1);

      const replaySnapshot = await snapshotFromLedger(fixture.ledgerRoot);
      const replay = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        admissionSnapshot: replaySnapshot,
        confirm: true,
        locks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(replay).toMatchObject({ eligibleCount: 0, quarantinedCount: 0 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed on concurrent mutation and leaves the active record in place", async () => {
    const fixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        locks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
        beforeQuarantine: async (candidate) => {
          await writeFile(candidate.ledgerPath, `${candidate.bytes.toString("utf8")} `);
        },
      })).rejects.toThrow(/concurrent_mutation|hash_mismatch/);
      await expect(access(fixture.paths[0]!)).resolves.toBeUndefined();
      await expect(access(join(fixture.ledgerRoot, "quarantine"))).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the preview hash no longer matches", async () => {
    const fixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        locks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
        beforeQuarantine: async (candidate) => {
          (candidate as { sha256: string }).sha256 = "0".repeat(64);
        },
      })).rejects.toThrow("project_control_legacy_output_hash_mismatch");
      await expect(access(fixture.paths[0]!)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks and path escapes while leaving valid/current records untouched", async () => {
    const fixture = await makeFixture(1);
    const outside = join(fixture.root, "outside.json");
    const linked = join(fixture.ledgerRoot, "items", "linked.json");
    const valid = join(fixture.ledgerRoot, "items", "valid.json");
    try {
      await writeFile(outside, await readFile(fixture.paths[0]!));
      await symlink(outside, linked);
      await writeFile(valid, JSON.stringify({
        schemaVersion: 1,
        jobId: "current-valid",
        status: "failed_no_output",
      }));
      const snapshot: ProjectAdmissionSnapshot = {
        ...fixture.snapshot,
        debt: [
          ...fixture.snapshot.debt,
          legacyDebt(linked),
          legacyDebt(outside),
        ],
      };
      const preview = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        admissionSnapshot: snapshot,
        locks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(preview).toMatchObject({ eligibleCount: 1, refusedCount: 2 });
      expect(preview.items.find((item) => item.ledgerPath === linked)?.reasons)
        .toContain("ledger record is not a regular non-symlink file");
      expect(preview.items.find((item) => item.ledgerPath === outside)?.reasons)
        .toContain("ledger path is outside controller-authorized items roots");
      const confirmed = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        admissionSnapshot: snapshot,
        confirm: true,
        locks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(confirmed).toMatchObject({
        ok: false,
        quarantinedCount: 1,
        refusedCount: 2,
      });
      await expect(access(valid)).resolves.toBeUndefined();
      await expect(access(linked)).resolves.toBeUndefined();
      await expect(access(outside)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("unblocks producer admission only after verified quarantine", async () => {
    const fixture = await makeFixture(1);
    try {
      expect(admission(fixture.snapshot).allowed).toBe(false);
      await repair(fixture, false);
      expect(admission(await snapshotFromLedger(fixture.ledgerRoot)).allowed).toBe(false);
      await repair(fixture, true);
      expect(admission(await snapshotFromLedger(fixture.ledgerRoot))).toMatchObject({
        allowed: true,
        reason: "allowed",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function makeFixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), "legacy-output-repair-"));
  const ledgerRoot = join(root, "consumed-output");
  const registryRoot = join(root, "registry");
  const backupRoot = join(root, "backups");
  await Promise.all([
    mkdir(join(ledgerRoot, "items"), { recursive: true }),
    mkdir(registryRoot, { recursive: true }),
    mkdir(backupRoot, { recursive: true }),
  ]);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const jobId = `legacy-worker-v${index + 2}`;
    const statusPath = join(backupRoot, `${jobId}.status`);
    const patchPath = join(backupRoot, `${jobId}.patch`);
    const ledgerPath = join(ledgerRoot, "items", `${jobId}.json`);
    await writeFile(statusPath, "?? legacy-output.txt\n");
    await writeFile(patchPath, "");
    await writeFile(ledgerPath, `${JSON.stringify({
      schemaVersion: 1,
      jobId,
      status: "failed_no_output",
      closedAt: `2025-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      failure: { category: "infrastructure", code: "legacy_failure" },
      output: { authoredChanges: false, workspaceDirty: false },
      note: "legacy record before preexisting workspace retention",
      backup: {
        workspace: join(root, "absent-workspaces", jobId),
        statusPath,
        patchPath,
      },
    }, null, 2)}\n`);
    paths.push(ledgerPath);
  }
  return {
    root,
    ledgerRoot,
    registryRoot,
    paths,
    snapshot: await snapshotFromLedger(ledgerRoot),
    locks: new TestLocks(),
  };
}

async function repair(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  confirm: boolean,
) {
  return repairLegacyConsumedOutputDebt({
    projectId: "project",
    registryRootDir: fixture.registryRoot,
    authorizedLedgerRoots: [fixture.ledgerRoot],
    admissionSnapshot: fixture.snapshot,
    confirm,
    locks: fixture.locks,
    prove: async () => ({ eligible: true, evidence: ["workspace absent; no live attempt"] }),
  });
}

async function snapshotFromLedger(ledgerRoot: string): Promise<ProjectAdmissionSnapshot> {
  const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot] });
  return {
    schemaVersion: 1,
    projectId: "project",
    observedAt: new Date().toISOString(),
    debt: ledger.debt,
    counts: projectAdmissionDebtCounts(ledger.debt),
  };
}

function legacyDebt(subject: string) {
  return {
    reason: ProjectDebtReason.IncompleteConsumedOutputRecord,
    subject,
    severity: "blocking" as const,
    evidence: ["failed_no_output record contradicts non-empty workspace status evidence"],
  };
}

function admission(snapshot: ProjectAdmissionSnapshot) {
  return evaluateProjectAdmission({
    request: {
      operation: ProjectOperation.StartWorker,
      workerRole: ProjectAdmissionWorkerRole.Producer,
    },
    snapshot,
  });
}

class TestLocks implements WorkspaceLockPort {
  held = 0;
  maxHeld = 0;

  async acquire(input: { readonly workspacePath: string; readonly owner: string }) {
    this.held += 1;
    this.maxHeld = Math.max(this.maxHeld, this.held);
    return {
      lockId: input.owner,
      workspacePath: input.workspacePath,
      owner: input.owner,
    } satisfies WorkspaceLock;
  }

  async release(): Promise<void> {
    this.held -= 1;
  }
}
