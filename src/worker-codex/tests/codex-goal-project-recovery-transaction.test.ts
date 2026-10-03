import { localProjectControlRecoveryDirectories } from "../../worker-local/project-control-recovery-directory-identity";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary, NetworkAccessMode, ProjectControlRecoveryOutcome,
  ProjectControlRecoveryPhase,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "../../worker-local/project-control-evidence-custody-local-adapter";
import { openProjectControlRecoveryStore, RecoveryFileFaultPoint } from "../../worker-local/project-control-recovery-file-store";
import { applyConfirmedControllerScopeRecovery, ScopeRecoveryFaultPoint } from "../codex-goal-project-custody-recovery";
import { parseCodexGoalJobManifest, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { durableReplaceJsonFile } from "../project-control-operation-file-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(nested = false) {
  const root = await mkdtemp(join(tmpdir(), "scope-recovery-")); roots.push(root);
  const custodyParent = nested ? join(root, "outer", "inner") : root;
  if (nested) await mkdir(custodyParent, { recursive: true });
  const ledger = join(custodyParent, "ledger"), archives = join(custodyParent, "archives");
  await mkdir(ledger); await mkdir(archives);
  const controller = parseCodexGoalJobManifest({
    schemaVersion: 1, jobId: "project-controller", taskId: "project-controller",
    createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
    jobRootDir: root, workspacePath: root, promptPath: join(root, "prompt.md"),
    accounts: ["account-a"], accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: { projectId: "project", readRoots: [root], workspaceRoots: [root], allowedAccountIds: ["account-a"] },
  });
  const proposed = { ...controller.projectAccessScope!, consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archives] };
  const path = join(root, "manifest.json"); await durableReplaceJsonFile({ path, value: controller });
  const read = async () => JSON.parse(await readFile(path, "utf8")) as CodexGoalJobManifest;
  let publications = 0;
  const run = async (options: {
    fault?: (point: ScopeRecoveryFaultPoint) => Promise<void>;
    fileFault?: Parameters<typeof openProjectControlRecoveryStore>[0]["fault"];
    custody?: LocalProjectControlEvidenceCustody;
    confirmed?: boolean;
  } = {}) => {
    const current = await read();
    const store = await openProjectControlRecoveryStore({ parent: root, taskId: current.taskId,
      ...(options.fileFault ? { fault: options.fileFault } : {}) });
    try {
      return await applyConfirmedControllerScopeRecovery({
        confirmed: options.confirmed ?? true, controller: current, proposed,
        directories: localProjectControlRecoveryDirectories,
        custody: options.custody ?? new LocalProjectControlEvidenceCustody(), store,
        ...(options.fault ? { fault: options.fault } : {}),
        confirmManifestDurability: async () => {},
        publish: async (now, revalidate) => {
          await revalidate(); publications++;
          const manifest = parseCodexGoalJobManifest({ ...current, projectAccessScope: proposed, updatedAt: now.toISOString() });
          await durableReplaceJsonFile({ path, value: manifest }); return manifest;
        },
      });
    } finally { await store.close(); }
  };
  return { root, ledger, archives, path, controller, proposed, read, run, publications: () => publications,
    audit: join(root, "project-controller.project-control-events.jsonl"),
    journal: join(root, "project-controller.project-control-recovery.jsonl") };
}

describe("durable confirmed recovery", () => {
  it.each(Object.values(ScopeRecoveryFaultPoint))("reconciles %s on a confirmed retry", async point => {
    const f = await fixture();
    const first = await f.run({ fault: async actual => { if (actual === point) throw new Error("power-loss"); } });
    expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    const retried = await f.run();
    if (point === ScopeRecoveryFaultPoint.AfterMaterialization) {
      expect(retried.outcome).toBe(ProjectControlRecoveryOutcome.Committed);
      expect(f.publications()).toBe(1);
      return;
    }
    expect(retried).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
    expect(f.publications()).toBe(1);
    expect(await readdir(join(f.ledger, "items"))).toEqual([]);
    expect(await readdir(join(f.archives, "items"))).toEqual([]);
    const events = (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.phase)).toEqual(["requested", "applied"]);
    expect(JSON.parse((await readFile(f.journal, "utf8")).trim().split("\n").at(-1)!)).toMatchObject({ record: { phase: ProjectControlRecoveryPhase.Committed } });
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.Committed);
    expect(f.publications()).toBe(1);
  });

  it("recovers directory creation interrupted before parent fsync", async () => {
    const f = await fixture(); let injected = false;
    const custody = new LocalProjectControlEvidenceCustody(async point => {
      if (point === "after_custody_directory_creation_before_parent_fsync" && !injected) {
        injected = true; throw new Error("crash");
      }
    });
    expect((await f.run({ custody })).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.Committed);
  });

  it.each([
    "after_custody_staging_creation_before_checkpoint",
    "after_custody_staging_checkpoint_before_publication",
  ] as const)("converges after %s without adopting unrecorded directories", async point => {
    const f = await fixture();
    let interrupted = false;
    const first = await f.run({ custody: new LocalProjectControlEvidenceCustody(async actual => {
      if (actual === point && !interrupted) { interrupted = true; throw new Error("crash"); }
    }) });
    expect(interrupted).toBe(true);
    expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    await expect(stat(join(f.ledger, "items"))).rejects.toMatchObject({ code: "ENOENT" });
    const record = JSON.parse((await readFile(f.journal, "utf8")).trim().split("\n").at(-1)!).record;
    expect(record.phase).toBe(ProjectControlRecoveryPhase.Prepared);
    expect(record.identities.some((identity: { path: string }) => identity.path === join(f.ledger, "items"))).toBe(false);
    if (point === "after_custody_staging_checkpoint_before_publication") {
      const staged = await stat(record.pendingDirectory.stagingPath);
      expect(record.pendingDirectory).toMatchObject({ path: join(f.ledger, "items"), device: staged.dev, inode: staged.ino });
    } else expect(record.pendingDirectory).toBeUndefined();
    expect(await f.run()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
    expect(f.publications()).toBe(1);
  });

  it.each(["ledger-items", "archive-items", "legacy-lock", "lock-container", "derived-lock"])(
    "checkpoints the inode before publishing %s and resumes before parent fsync", async kind => {
      const f = await fixture();
      const target = kind === "ledger-items" ? join(f.ledger, "items")
        : kind === "archive-items" ? join(f.archives, "items")
        : kind === "legacy-lock" ? join(f.ledger, ".mutation-locks")
        : kind === "lock-container" ? join(f.root, ".consumed-output-ledger-mutation-locks")
        : join(f.root, ".consumed-output-ledger-mutation-locks", createHash("sha256").update(f.ledger).digest("hex"));
      const first = await f.run({ custody: new LocalProjectControlEvidenceCustody(async (point, path) => {
        if (point === "after_custody_directory_creation_before_parent_fsync" && path === target) throw new Error("crash");
      }) });
      expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      const record = JSON.parse((await readFile(f.journal, "utf8")).trim().split("\n").at(-1)!).record;
      const published = await stat(target);
      expect(record).toMatchObject({ phase: ProjectControlRecoveryPhase.Prepared,
        pendingDirectory: { path: target, device: published.dev, inode: published.ino } });
      expect(await f.run()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
      expect((await stat(target)).ino).toBe(published.ino);
    });

  it.each(["directory", "symlink"])("rejects a %s substitution of its own published but uncheckpointed inode", async kind => {
    const f = await fixture();
    const target = join(f.ledger, "items");
    await f.run({ custody: new LocalProjectControlEvidenceCustody(async point => {
      if (point === "after_custody_directory_creation_before_parent_fsync") throw new Error("crash");
    }) });
    await rename(target, `${target}.saved`);
    if (kind === "directory") await mkdir(target);
    else await symlink(`${target}.saved`, target);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect(f.publications()).toBe(0);
    expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
  });

  it("rejects an external final directory after an uncheckpointed staging mkdir", async () => {
    const f = await fixture();
    await f.run({ custody: new LocalProjectControlEvidenceCustody(async point => {
      if (point === "after_custody_staging_creation_before_checkpoint") throw new Error("crash");
    }) });
    const target = join(f.ledger, "items");
    await mkdir(target); const replacement = await stat(target);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect((await stat(target)).ino).toBe(replacement.ino);
    expect(f.publications()).toBe(0);
  });

  it("rejects a substituted staged inode before publication", async () => {
    const f = await fixture();
    await f.run({ custody: new LocalProjectControlEvidenceCustody(async point => {
      if (point === "after_custody_staging_checkpoint_before_publication") throw new Error("crash");
    }) });
    const record = JSON.parse((await readFile(f.journal, "utf8")).trim().split("\n").at(-1)!).record;
    const staged = record.pendingDirectory.stagingPath;
    await rename(staged, `${staged}.saved`); await mkdir(staged);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    await expect(stat(join(f.ledger, "items"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.publications()).toBe(0);
  });

  it("never clobbers an empty destination inserted at the atomic publication boundary", async () => {
    const f = await fixture(); let inserted: number | undefined;
    const result = await f.run({ custody: new LocalProjectControlEvidenceCustody(async (point, path) => {
      if (point === "before_custody_directory_publication" && inserted === undefined) {
        await mkdir(path); inserted = (await stat(path)).ino;
      }
    }) });
    expect(inserted).toBeDefined();
    expect(result.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect((await stat(join(f.ledger, "items"))).ino).toBe(inserted);
    expect(f.publications()).toBe(0);
  });

  it.each([RecoveryFileFaultPoint.BeforeAppend, RecoveryFileFaultPoint.AfterAppend, RecoveryFileFaultPoint.AfterSync]
    .flatMap(point => [2, 3].map(checkpoint => ({ point, checkpoint }))))(
    "recovers per-path journal checkpoint $checkpoint after $point", async ({ point, checkpoint }) => {
      const f = await fixture(); let writes = 0;
      const first = await f.run({ fileFault: async (actual, name) => {
        if (actual === point && name.endsWith("recovery.jsonl") && ++writes === checkpoint) throw new Error("crash");
      } });
      expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
      expect(await f.run()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
      expect(f.publications()).toBe(1);
    });

  it.each([RecoveryFileFaultPoint.BeforeAppend, RecoveryFileFaultPoint.AfterAppend, RecoveryFileFaultPoint.AfterSync])(
    "completes missing final audit after %s failure without publishing twice", async point => {
      const f = await fixture(); let audits = 0;
      const first = await f.run({ fileFault: async (actual, name) => {
        if (actual === point && name.endsWith("events.jsonl") && ++audits === 2) throw new Error("audit-failed");
      } });
      expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect((await f.read()).projectAccessScope).toEqual(f.proposed);
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.Committed);
      expect(f.publications()).toBe(1);
      const events = (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(events.map(event => event.phase)).toEqual(["requested", "applied"]);
    });

  it("requires confirmation and preserves lost previously configured items", async () => {
    const f = await fixture();
    await expect(f.run({ confirmed: false })).rejects.toThrow("confirm_update_required");
    expect(await readdir(f.ledger)).toEqual([]);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.Committed);
    await rename(join(f.ledger, "items"), join(f.ledger, "saved-items"));
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    await expect(readdir(join(f.ledger, "items"))).rejects.toThrow();
  });

  it.each(["ledger", "archives"])("refuses %s/items identity drift during reconciliation", async root => {
    const f = await fixture();
    await f.run({ fault: async point => { if (point === ScopeRecoveryFaultPoint.AfterMaterializedRecord) throw new Error("crash"); } });
    const path = join(root === "ledger" ? f.ledger : f.archives, "items");
    await rename(path, `${path}.saved`); await mkdir(path);
    expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
    expect(f.publications()).toBe(0);
    expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
  });

  it.each(["mutation-lock", "derived-lock", "intermediate-ancestor"] as const)(
    "rejects a %s replacement across crash/retry", async kind => {
      const f = await fixture();
      await f.run({ fault: async point => { if (point === ScopeRecoveryFaultPoint.AfterMaterializedRecord) throw new Error("crash"); } });
      const target = kind === "mutation-lock"
          ? join(f.ledger, ".mutation-locks")
        : kind === "derived-lock"
          ? join(f.root, ".consumed-output-ledger-mutation-locks", createHash("sha256").update(f.ledger).digest("hex"))
          : join(f.root, ".consumed-output-ledger-mutation-locks");
      const saved = `${target}.saved`;
      await rename(target, saved); await mkdir(target);
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect(f.publications()).toBe(0);
    });

  it.each(["mutation-lock", "derived-lock", "intermediate-ancestor"] as const)(
    "rejects a symlink %s substitution across crash/retry", async kind => {
      const f = await fixture();
      await f.run({ fault: async point => { if (point === ScopeRecoveryFaultPoint.AfterMaterializedRecord) throw new Error("crash"); } });
      const target = kind === "mutation-lock"
        ? join(f.ledger, ".mutation-locks")
        : kind === "derived-lock"
          ? join(f.root, ".consumed-output-ledger-mutation-locks", createHash("sha256").update(f.ledger).digest("hex"))
          : join(f.root, ".consumed-output-ledger-mutation-locks");
      const saved = `${target}.saved`;
      await rename(target, saved); await symlink(saved, target);
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect(f.publications()).toBe(0);
    });

  it.each([ScopeRecoveryFaultPoint.AfterPrepared, ScopeRecoveryFaultPoint.AfterMaterializedRecord])(
    "rejects replacement above nested root parents after %s", async point => {
      const f = await fixture(true);
      await f.run({ fault: async actual => { if (actual === point) throw new Error("crash"); } });
      const ancestor = join(f.root, "outer");
      await rename(ancestor, `${ancestor}.saved`);
      await mkdir(ancestor);
      // All descendants retain their original inodes; only the ancestor changes.
      await rename(join(`${ancestor}.saved`, "inner"), join(ancestor, "inner"));
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect(f.publications()).toBe(0);
      expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
    });

  it("rejects an unrelated manifest change while an operation is pending", async () => {
    const f = await fixture();
    await f.run({ fault: async () => { throw new Error("crash"); } });
    await writeFile(f.path, JSON.stringify({ ...await f.read(), promptPath: join(f.root, "changed") }));
    await expect(f.run()).rejects.toThrow("pending_conflict");
    expect(f.publications()).toBe(0);
  });
});
