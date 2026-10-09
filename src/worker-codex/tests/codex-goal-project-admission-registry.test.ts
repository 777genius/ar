import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectDebtReason, ProjectDebtScope, ProjectOperation, projectAdmissionDebtFingerprint, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { assertAdmissionRegistryComplete } from "../application/project-control/codex-goal-project-admission-target";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { prospectiveAdmissionResourceBacking } from "../application/project-control/codex-goal-project-admission-paths";
import { historicalDebtIsPhysicallyUnrelated } from "../application/project-control/codex-goal-project-historical-debt-scope";
import { prepareCodexProjectScopedAdmission } from "../application/project-control/codex-goal-project-scoped-admission";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(layout: "combined" | "split" = "combined", temporaryRoot = tmpdir()) {
  const registryRootDir = await mkdtemp(join(temporaryRoot, "admission-registry-"));
  roots.push(registryRootDir);
  const container = join(registryRootDir, layout === "split" ? "consumed-output-evidence" : "consumed-output");
  const ledger = layout === "split" ? join(registryRootDir, "terminal-ledger") : join(container, "ledger");
  const archives = join(container, "archives");
  await mkdir(join(ledger, "items"), { recursive: true });
  await mkdir(archives, { recursive: true });
  const scope: ProjectAccessScope = {
    projectId: "test-registry",
    consumedOutputLedgerRoots: [ledger],
    consumedOutputEvidenceRoots: [archives],
  };
  const input = { registryRootDir, scope, summaries: [] };
  return { registryRootDir, container, ledger, archives, input };
}

async function nativeJobRecord(f: Awaited<ReturnType<typeof fixture>>, archiveRoot = f.archives) {
  const archive = join(archiveRoot, "job-backup");
  await mkdir(archive);
  const statusPath = join(archive, "git-status.txt");
  const patchPath = join(archive, "tracked.diff");
  await writeFile(statusPath, "");
  await writeFile(patchPath, "");
  const value = {
    schemaVersion: 1, jobId: "job", status: "failed_no_output",
    note: "Test fixture retained no authored output", closedAt: "2026-10-07T00:00:00.000Z",
    failure: { category: "infrastructure", code: "fixture_failure" },
    output: { authoredChanges: false, workspaceDirty: false },
    backup: { workspace: f.registryRootDir, statusPath, patchPath },
  };
  await writeFile(join(f.ledger, "items", "job.json"), JSON.stringify(value));
  return { patchPath, value };
}

describe("admission native consumed-output registry", () => {
  it("keeps corrupt external ledger control state out of advisory backlog", async () => {
    const f = await fixture();
    const external = await mkdtemp(join(tmpdir(), "admission-external-ledger-"));
    roots.push(external);
    await mkdir(join(external, "items"));
    await writeFile(join(external, "items", "job.json"), "{");
    const scope = { ...f.input.scope, consumedOutputLedgerRoots: [f.ledger, external] };
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope })).resolves.toBeUndefined();
    const ledger = await readCodexGoalConsumedOutputLedgers({
      roots: scope.consumedOutputLedgerRoots, evidenceRoots: [f.archives],
    });
    expect(ledger.debt).toEqual([expect.objectContaining({
      reason: ProjectDebtReason.UnreadableRoot, scope: ProjectDebtScope.ControlState,
    })]);
    const scoped = await prepareCodexProjectScopedAdmission({
      registryRootDir: f.registryRootDir, scope,
      request: { operation: ProjectOperation.CreateWorktree },
      snapshot: { schemaVersion: 1, projectId: scope.projectId, observedAt: new Date().toISOString(), debt: ledger.debt },
      deps: { async listJobs() { return []; }, async buildOverviewItems() { return []; } },
    });
    expect(scoped.safetyDebt).toEqual(ledger.debt);
    expect(scoped.backlog.count).toBe(0);
    const { scope: classification, ...unclassified } = ledger.debt[0]!;
    expect(classification).toBe(ProjectDebtScope.ControlState);
    expect(projectAdmissionDebtFingerprint(ledger.debt))
      .not.toBe(projectAdmissionDebtFingerprint([unclassified]));
  });

  it("recognizes a scoped evidence container separate from its ledger", async () => {
    const f = await fixture("split");
    await nativeJobRecord(f);
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
    const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
    expect(ledger.byJobId.get("job")?.valid).toBe(true);
  });

  it("recognizes an exact scoped evidence root directly in the registry", async () => {
    const f = await fixture("split");
    await rm(f.container, { recursive: true });
    const archives = join(f.registryRootDir, "retained-evidence");
    await mkdir(archives);
    await nativeJobRecord(f, archives);
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope: {
      ...f.input.scope, consumedOutputEvidenceRoots: [archives],
    } })).resolves.toBeUndefined();
  });

  it("requires declared custody for a separate evidence container", async () => {
    const f = await fixture("split");
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope: {
      ...f.input.scope, consumedOutputEvidenceRoots: [join(f.registryRootDir, "other-evidence", "archives")],
    } })).rejects.toThrow("unregistered registry directory: consumed-output-evidence");
  });

  it("rejects an unknown branch inside a scoped evidence container", async () => {
    const f = await fixture("split");
    await mkdir(join(f.container, "unregistered-job"));
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered consumed-output entry: unregistered-job");
  });

  it("rejects a hidden job inside a separate scoped evidence root", async () => {
    const f = await fixture("split");
    const nested = join(f.archives, "nested", "unregistered-job");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "job.json"), "{}");
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered job inside consumed-output");
  });

  it("recognizes scoped native ledger, archive and mutation-lock layouts", async () => {
    const f = await fixture();
    const archive = join(f.archives, "test-attempt");
    await mkdir(archive);
    for (const name of ["git-status.txt", "tracked.diff", "tracked.numstat"]) {
      await writeFile(join(archive, name), "");
    }
    const lock = join(f.container, ".consumed-output-ledger-mutation-locks", "a".repeat(64));
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "lock.json"), "{}");
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
  });

  it("recognizes native records while preserving blocking missing-evidence debt", async () => {
    const f = await fixture();
    const { patchPath } = await nativeJobRecord(f);
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
    await rm(patchPath);
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
    const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
    expect(ledger.byJobId.get("job")?.valid).toBe(false);
    expect(ledger.debt).toContainEqual(expect.objectContaining({ severity: "blocking" }));
    const debt = ledger.debt.find(item => item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord);
    expect(debt).toMatchObject({ scope: ProjectDebtScope.RetainedOutput, retainedOutput: {
      jobId: "job", workspacePath: f.registryRootDir, ledgerPath: join(f.ledger, "items", "job.json"),
      ledgerSha256: createHash("sha256").update(await readFile(join(f.ledger, "items", "job.json"))).digest("hex"),
    } });
  });

  // Real tmpfs backing makes this independent of an unsupported CI overlay root.
  // Regression: an evidence/target alias introduced while owner IO yields must
  // prevent historical suppression even when the ledger itself never changes.
  it.skipIf(process.platform !== "linux").each(["evidence", "target"] as const)(
    "does not suppress retained debt after an async %s alias replacement", async (replacement) => {
      const f = await fixture("combined", "/dev/shm");
      const targetPath = await mkdtemp("/dev/shm/TEST-admission-target-");
      roots.push(targetPath);
      const { patchPath } = await nativeJobRecord(f);
      await rm(patchPath);
      const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
      const debt = ledger.debt.find(item => item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord);
      if (!debt?.retainedOutput) throw new Error("expected attributed blocking retained record");
      const manifest: CodexGoalJobManifest = {
        schemaVersion: 1, jobId: "job", taskId: "task", workspacePath: f.registryRootDir,
        jobRootDir: f.registryRootDir, promptPath: join(f.registryRootDir, "prompt.md"),
        createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", accounts: [],
      };
      const physicalWritableRoots = await prospectiveAdmissionResourceBacking(targetPath);
      if (!physicalWritableRoots?.length) throw new Error("expected supported tmpfs physical backing");
      const target = { canonicalPath: targetPath, writableRoots: [targetPath], physicalWritableRoots };
      const writer = { manifest, jobId: "job", workspacePath: f.registryRootDir,
        canonicalWorkspacePath: await realpath(f.registryRootDir), authority: "released" as const };
      expect(await historicalDebtIsPhysicallyUnrelated(debt, target, [writer], undefined, async () => true)).toBe(true);
      expect(await historicalDebtIsPhysicallyUnrelated(debt, target,
        [{ ...writer, authority: "unknown" }], undefined, async () => true)).toBe(false);
      expect(await historicalDebtIsPhysicallyUnrelated(debt, target, [writer], undefined, async () => {
        if (replacement === "evidence") await symlink(targetPath, patchPath);
        else {
          await rm(targetPath, { recursive: true });
          await symlink(f.registryRootDir, targetPath);
        }
        return true;
      })).toBe(false);
      expect(debt.severity).toBe("blocking");
    },
  );

  it("preserves native pruned terminal records and their informational debt", async () => {
    const f = await fixture();
    const closedAt = "2026-10-07T00:00:00.000Z";
    await writeFile(join(f.ledger, "items", "job.json"), JSON.stringify({
      schemaVersion: 1, jobId: "job", status: "rejected",
      note: "rejected output", closedAt, consumedAt: closedAt,
      notes: [{ status: "rejected", text: "rejected output" }],
      backup: { workspace: f.registryRootDir,
        statusPath: join(f.archives, "pruned", "git-status.txt"),
        patchPath: join(f.archives, "pruned", "tracked.diff"),
      },
    }));
    const ledger = await readCodexGoalConsumedOutputLedgers({
      roots: [f.ledger], evidenceRoots: [f.archives],
    });
    expect(ledger.byJobId.get("job")).toMatchObject({
      structurallyValid: true, valid: false, retentionEvidenceMissing: true,
    });
    expect(ledger.debt).toEqual([expect.objectContaining({
      reason: ProjectDebtReason.RetentionEvidenceMissing, severity: "info",
    })]);
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
  });

  it("uses every declared evidence root without accepting an undeclared root", async () => {
    const f = await fixture();
    const evidenceRoot = await mkdtemp(join(tmpdir(), "admission-second-evidence-"));
    roots.push(evidenceRoot);
    await nativeJobRecord(f, evidenceRoot);
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope: {
      ...f.input.scope, consumedOutputEvidenceRoots: [f.archives, evidenceRoot],
    } })).resolves.toBeUndefined();
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("consumed_output_evidence_path_outside_root");
  });

  it("rejects a manifest at the item position but leaves recognized incomplete terminal debt blocking", async () => {
    const f = await fixture();
    const path = join(f.ledger, "items", "job.json");
    await writeFile(path, JSON.stringify({ jobId: "job", taskId: "unregistered-job", workspacePath: "/unregistered" }));
    await expect(assertAdmissionRegistryComplete(f.input)).rejects.toThrow("invalid native job ledger record");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, jobId: "job", status: "failed_no_output" }));
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
    const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
    expect(ledger.byJobId.get("job")?.structurallyValid).toBe(false);
    expect(ledger.debt).toContainEqual(expect.objectContaining({ severity: "blocking" }));
  });

  it("preserves append-only corrected native history without retiring unrelated debt", async () => {
    const f = await fixture();
    const { value: correction } = await nativeJobRecord(f);
    const path = join(f.ledger, "items", "job.json");
    await writeFile(path, JSON.stringify({ ...correction, status: "rejected" }));
    const read = () => readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
    expect((await read()).debt).toContainEqual(expect.objectContaining({ severity: "blocking" }));
    await writeFile(join(f.ledger, "items", "job--correction.json"), JSON.stringify({
      ...correction, attemptId: "correction", closedAt: "2026-10-07T00:00:01.000Z",
    }));
    expect((await read()).debt).toEqual([]);
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
    await writeFile(join(f.ledger, "items", "peer.json"), JSON.stringify({ schemaVersion: 1, jobId: "peer", status: "failed_no_output" }));
    expect((await read()).debt).toContainEqual(expect.objectContaining({ severity: "blocking" }));
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
  });

  it("recognizes an archive root before its native writer creates it", async () => {
    const f = await fixture();
    await rm(f.archives, { recursive: true });
    await expect(assertAdmissionRegistryComplete(f.input)).resolves.toBeUndefined();
  });

  it.each(["ledger", "archives"])("rejects undeclared %s custody", async (kind) => {
    const f = await fixture();
    const scope = { ...f.input.scope,
      ...(kind === "ledger" ? { consumedOutputLedgerRoots: [] } : { consumedOutputEvidenceRoots: [] }),
    };
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope }))
      .rejects.toThrow("unregistered registry directory: consumed-output");
  });

  it("rejects an out-of-container declared root", async () => {
    const f = await fixture();
    await expect(assertAdmissionRegistryComplete({ ...f.input, scope: {
      ...f.input.scope, consumedOutputLedgerRoots: [join(f.container, "..", "other-ledger")],
    } })).rejects.toThrow("unregistered registry directory: consumed-output");
  });

  it("retains rejection of an unknown top-level job directory", async () => {
    const f = await fixture();
    await mkdir(join(f.registryRootDir, "unregistered-job"));
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered registry directory: unregistered-job");
  });

  it("rejects an unknown directory immediately inside the native container", async () => {
    const f = await fixture();
    await mkdir(join(f.container, "unregistered-job"));
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered consumed-output entry: unregistered-job");
  });

  it.each(["ledger", "archives", ".consumed-output-ledger-mutation-locks"])(
    "rejects a hidden native-subtree job under %s", async (kind) => {
      const f = await fixture();
      const nested = join(f.container, kind, "nested", "unregistered-job");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "job.json"), "{}");
      await expect(assertAdmissionRegistryComplete(f.input))
        .rejects.toThrow("unregistered job inside consumed-output");
    },
  );

  it("rejects a native child symlink", async () => {
    const f = await fixture();
    await rm(f.archives, { recursive: true });
    await symlink(f.ledger, f.archives, "dir");
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered registry directory: consumed-output");
  });

  it("rejects a nested escape symlink", async () => {
    const f = await fixture();
    await symlink(f.registryRootDir, join(f.archives, "escape"), "dir");
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("consumed-output entry symlink");
  });

  it("rejects a native child with a non-directory type", async () => {
    const f = await fixture();
    await rm(f.archives, { recursive: true });
    await writeFile(f.archives, "");
    await expect(assertAdmissionRegistryComplete(f.input))
      .rejects.toThrow("unregistered registry directory: consumed-output");
  });
});
