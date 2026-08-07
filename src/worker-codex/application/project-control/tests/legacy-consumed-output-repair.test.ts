import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
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
} from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerMutationLock } from "@vioxen/subscription-runtime/worker-local";
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
      await expect(access(join(fixture.ledgerRoot, ".mutation-locks"))).rejects.toThrow();
      expect(fixture.locks).toMatchObject({ held: 0, maxHeld: 0 });

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
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: replaySnapshot,
        confirm: true,
        mutationLocks: fixture.locks,
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
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        mutationLocks: fixture.locks,
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

  it("revalidates retained output and workspace immediately before rename", async () => {
    const patchFixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: patchFixture.registryRoot,
        authorizedLedgerRoots: [patchFixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: patchFixture.snapshot,
        confirm: true,
        mutationLocks: patchFixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
        afterReceipt: async () => {
          await writeFile(
            join(patchFixture.backupRoot, "legacy-worker-v2.patch"),
            "late authored bytes!!\n",
          );
        },
      })).rejects.toThrow("project_control_legacy_output_late_proof_changed");
      await expect(access(patchFixture.paths[0]!)).resolves.toBeUndefined();
    } finally {
      await rm(patchFixture.root, { recursive: true, force: true });
    }

    const workspaceFixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: workspaceFixture.registryRoot,
        authorizedLedgerRoots: [workspaceFixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: workspaceFixture.snapshot,
        confirm: true,
        mutationLocks: workspaceFixture.locks,
        prove: async (candidate) => {
          try {
            await lstat(candidate.workspace!);
            return { eligible: false as const, reasons: ["workspace exists"] };
          } catch {
            return { eligible: true as const, evidence: ["workspace absent"] };
          }
        },
        afterReceipt: async (candidate) => {
          await mkdir(candidate.workspace!, { recursive: true });
        },
      })).rejects.toThrow("project_control_legacy_output_late_proof_changed");
      await expect(access(workspaceFixture.paths[0]!)).resolves.toBeUndefined();
    } finally {
      await rm(workspaceFixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the preview hash no longer matches", async () => {
    const fixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        mutationLocks: fixture.locks,
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

  it("refuses an authored retained patch and keeps admission blocked", async () => {
    const fixture = await makeFixture(1);
    try {
      await writeFile(join(fixture.backupRoot, "legacy-worker-v2.patch"), "authored output\n");
      const result = await repair(fixture, true);
      expect(result).toMatchObject({
        ok: false,
        eligibleCount: 0,
        refusedCount: 1,
        quarantinedCount: 0,
      });
      expect(result.items[0]?.reasons[0]).toContain("non-empty or changed");
      await expect(access(fixture.paths[0]!)).resolves.toBeUndefined();
      expect(admission(await snapshotFromLedger(fixture.ledgerRoot)).allowed).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses future schemas and job ids outside the project prefix", async () => {
    const fixture = await makeFixture(1);
    try {
      const value = JSON.parse(await readFile(fixture.paths[0]!, "utf8")) as {
        schemaVersion: number;
      };
      value.schemaVersion = 2;
      await writeFile(fixture.paths[0]!, JSON.stringify(value));
      const futureSnapshot = await snapshotFromLedger(fixture.ledgerRoot);
      const future = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: futureSnapshot,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(future).toMatchObject({ eligibleCount: 0, refusedCount: 1 });

      value.schemaVersion = 1;
      await writeFile(fixture.paths[0]!, JSON.stringify(value));
      const foreign = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["different-project-"],
        admissionSnapshot: await snapshotFromLedger(fixture.ledgerRoot),
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(foreign).toMatchObject({ eligibleCount: 0, refusedCount: 1 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires the exact legacy failure and output value contract", async () => {
    const fixture = await makeFixture(1);
    try {
      const value = JSON.parse(await readFile(fixture.paths[0]!, "utf8")) as {
        failure: Record<string, unknown>;
        output: Record<string, unknown>;
      };
      value.failure.unexpected = "foreign";
      value.output.authoredChanges = "false";
      await writeFile(fixture.paths[0]!, JSON.stringify(value));
      const preview = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: fixture.snapshot,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(preview).toMatchObject({ eligibleCount: 0, refusedCount: 1 });
      await expect(access(fixture.paths[0]!)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an existing quarantine symlink before any outside-root write", async () => {
    const fixture = await makeFixture(1);
    const outside = join(fixture.root, "outside-quarantine");
    try {
      await mkdir(outside);
      await symlink(outside, join(fixture.ledgerRoot, "quarantine"), "dir");
      await expect(repair(fixture, true)).rejects.toThrow(
        "project_control_legacy_output_quarantine_path_unsafe",
      );
      expect(await readdir(outside)).toEqual([]);
      await expect(access(fixture.paths[0]!)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a prepared receipt after rename and completes it idempotently", async () => {
    const fixture = await makeFixture(1);
    try {
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
        afterRename: async () => {
          throw new Error("simulated_crash_after_rename");
        },
      })).rejects.toThrow("simulated_crash_after_rename");
      await expect(access(fixture.paths[0]!)).rejects.toThrow();
      await appendFile(
        join(fixture.ledgerRoot, "quarantine", "legacy-consumed-output", "manifest.jsonl"),
        '{"phase":"quarantined"',
      );

      const recovered = await repair(fixture, true);
      expect(recovered).toMatchObject({
        ok: true,
        eligibleCount: 1,
        quarantinedCount: 1,
      });
      expect(recovered.items[0]?.reasons).toContain(
        "recovered and verified a prepared quarantine receipt",
      );
      const receiptLines = (await readFile(
        join(fixture.ledgerRoot, "quarantine", "legacy-consumed-output", "manifest.jsonl"),
        "utf8",
      )).trim().split("\n");
      const receipts = receiptLines.flatMap((line) => {
        try {
          return [JSON.parse(line) as {
        phase: string;
        recovered?: boolean;
          }];
        } catch {
          return [];
        }
      });
      expect(receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "prepared" }),
        expect.objectContaining({ phase: "quarantined", recovered: true }),
      ]));

      const replay = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: await snapshotFromLedger(fixture.ledgerRoot),
        confirm: true,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(replay).toMatchObject({ eligibleCount: 0, quarantinedCount: 0 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("seals a torn first manifest append before the next receipt", async () => {
    const fixture = await makeFixture(1);
    try {
      const quarantineRoot = join(
        fixture.ledgerRoot,
        "quarantine",
        "legacy-consumed-output",
      );
      await mkdir(join(quarantineRoot, "records"), { recursive: true });
      await writeFile(join(quarantineRoot, "manifest.jsonl"), '{"schemaVersion":1');
      const repaired = await repair(fixture, true);
      expect(repaired).toMatchObject({ quarantinedCount: 1, ok: true });
      const replay = await repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: await snapshotFromLedger(fixture.ledgerRoot),
        confirm: true,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
      });
      expect(replay).toMatchObject({ quarantinedCount: 0, eligibleCount: 0 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("never truncates a replacement symlink target after opening the manifest", async () => {
    const fixture = await makeFixture(1);
    const quarantineRoot = join(
      fixture.ledgerRoot,
      "quarantine",
      "legacy-consumed-output",
    );
    const manifestPath = join(quarantineRoot, "manifest.jsonl");
    const displacedManifestPath = join(quarantineRoot, "manifest.displaced");
    const outsidePath = join(fixture.root, "outside.txt");
    try {
      await mkdir(join(quarantineRoot, "records"), { recursive: true });
      await writeFile(manifestPath, '{"schemaVersion":1');
      await writeFile(outsidePath, "outside-safe\n");
      await expect(repairLegacyConsumedOutputDebt({
        projectId: "project",
        registryRootDir: fixture.registryRoot,
        authorizedLedgerRoots: [fixture.ledgerRoot],
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: fixture.snapshot,
        confirm: true,
        mutationLocks: fixture.locks,
        prove: async () => ({ eligible: true, evidence: ["safe"] }),
        beforeManifestTailTruncate: async () => {
          await rename(manifestPath, displacedManifestPath);
          await symlink(outsidePath, manifestPath);
        },
      })).rejects.toBeDefined();
      expect(await readFile(outsidePath, "utf8")).toBe("outside-safe\n");
      await rm(manifestPath);
      await rename(displacedManifestPath, manifestPath);
      expect(await repair(fixture, true)).toMatchObject({ quarantinedCount: 1 });
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
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: snapshot,
        mutationLocks: fixture.locks,
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
        allowedJobIdPrefixes: ["legacy-"],
        admissionSnapshot: snapshot,
        confirm: true,
        mutationLocks: fixture.locks,
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
    const numstatPath = join(backupRoot, `${jobId}.numstat`);
    const untrackedArchivePath = join(backupRoot, `${jobId}.untracked.tar`);
    const ledgerPath = join(ledgerRoot, "items", `${jobId}.json`);
    await writeFile(statusPath, "?? legacy-output.txt\n");
    await writeFile(patchPath, "");
    await writeFile(numstatPath, "");
    await writeFile(untrackedArchivePath, "");
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
        numstatPath,
        untrackedArchivePath,
      },
    }, null, 2)}\n`);
    paths.push(ledgerPath);
  }
  return {
    root,
    ledgerRoot,
    registryRoot,
    paths,
    backupRoot,
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
    allowedJobIdPrefixes: ["legacy-"],
    admissionSnapshot: fixture.snapshot,
    confirm,
    mutationLocks: fixture.locks,
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

class TestLocks extends LocalConsumedOutputLedgerMutationLock {
  held = 0;
  maxHeld = 0;

  async acquire(input: { readonly ledgerRoots: readonly string[]; readonly owner: string }) {
    this.held += 1;
    this.maxHeld = Math.max(this.maxHeld, this.held);
    return await super.acquire(input);
  }

  async release(lease: Awaited<ReturnType<LocalConsumedOutputLedgerMutationLock["acquire"]>>): Promise<void> {
    await super.release(lease);
    this.held -= 1;
  }
}
