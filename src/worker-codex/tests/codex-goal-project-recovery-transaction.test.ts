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
import { captureLocalTerminalOutputBackup, LocalConsumedOutputLedgerWriter } from "../../worker-local/consumed-output-ledger-local-adapter";
import { openProjectControlRecoveryStore, RecoveryFileFaultPoint } from "../../worker-local/project-control-recovery-file-store";
import { applyConfirmedControllerScopeRecovery, ScopeRecoveryFaultPoint } from "../codex-goal-project-custody-recovery";
import { parseCodexGoalJobManifest, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { projectControlUpdateControllerScopeView } from "../codex-goal-mcp-project-control-admin";
import { loadProjectControlController } from "../codex-goal-mcp-project-control-deps";
import { durableReplaceJsonFile } from "../project-control-operation-file-store";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { git } from "./codex-goal-mcp-test-support";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(nested = false, configured = false) {
  const root = await mkdtemp(join(tmpdir(), "TEST-scope-recovery-")); roots.push(root);
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
    projectAccessScope: { projectId: "project", readRoots: [root], workspaceRoots: [root], allowedAccountIds: ["account-a"],
      ...(configured ? { consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archives] } : {}) },
  });
  const proposed = { ...controller.projectAccessScope!, allowedAccountIds: ["account-a", "account-b"],
    consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archives] };
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

async function retainedFixture(configured: boolean) {
  const f = await fixture(false, configured);
  await git(f.root, ["init", "-q"]);
  const backup = await captureLocalTerminalOutputBackup({
    archiveRoot: f.archives, archiveName: "retained-worker-attempt", workspacePath: f.root,
    changedFiles: [], sourcePatchBytes: Buffer.from("retained TEST patch\n"), requireEvidenceCustody: true,
  });
  const receipt = await new LocalConsumedOutputLedgerWriter(undefined, f.root, [f.archives]).record({
    ledgerRoot: f.ledger,
    decision: { schemaVersion: 1, jobId: "retained-worker", status: "archived",
      closedAt: "2026-09-20T00:00:00.000Z", note: "TEST retained output", archivePath: backup.archivePath,
      backup: { workspace: f.root, statusPath: backup.statusPath, patchPath: backup.patchPath, numstatPath: backup.numstatPath } },
  });
  const retained = await Promise.all([backup.statusPath, backup.patchPath, backup.numstatPath, receipt.ledgerPath]
    .map(async path => {
      const metadata = await stat(path);
      return { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
        identity: { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode } };
    }));
  const directories = await Promise.all([f.ledger, join(f.ledger, "items"), f.archives, backup.archivePath]
    .map(async path => ({ path, metadata: await stat(path) })));
  const assertRetained = async (archiveRoot = f.archives) => {
    const relocated = (path: string) => path === f.archives || path.startsWith(`${f.archives}/`)
      ? `${archiveRoot}${path.slice(f.archives.length)}` : path;
    expect(await readdir(archiveRoot)).toEqual(["retained-worker-attempt"]);
    expect((await readdir(relocated(backup.archivePath))).sort()).toEqual(["git-status.txt", "tracked.diff", "tracked.numstat"]);
    expect(await readdir(join(f.ledger, "items"))).toEqual(["retained-worker.json"]);
    for (const file of retained) {
      expect(createHash("sha256").update(await readFile(relocated(file.path))).digest("hex")).toBe(file.sha256);
      expect(await stat(relocated(file.path))).toMatchObject(file.identity);
    }
    for (const { path, metadata } of directories) {
      expect(await stat(relocated(path))).toMatchObject({ dev: metadata.dev, ino: metadata.ino,
        uid: metadata.uid, gid: metadata.gid, mode: metadata.mode });
    }
    const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archives] });
    if (archiveRoot === f.archives) {
      expect(ledger.byJobId.get("retained-worker")).toMatchObject({ valid: true, ledgerPath: receipt.ledgerPath });
      expect(ledger.debt).toEqual([]);
    } else expect(ledger.debt).toHaveLength(1);
    await expect(stat(join(archiveRoot, "items"))).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { ...f, assertRetained, retained, directories };
}

async function nativeControllerFixture() {
  const f = await retainedFixture(true);
  const registryRootDir = join(f.root, "registry");
  const jobRootDir = join(registryRootDir, f.controller.jobId);
  const scope = { ...f.controller.projectAccessScope!, registryRoot: registryRootDir,
    jobIdPrefixes: ["project-"], tmuxSessionPrefixes: ["project-"] };
  const manifest = parseCodexGoalJobManifest({ ...f.controller, jobRootDir, projectAccessScope: scope });
  const path = join(jobRootDir, "job.json");
  await durableReplaceJsonFile({ path, value: manifest });
  const update = (options: {
    opening?: () => Promise<void>;
    fault?: (point: ScopeRecoveryFaultPoint) => Promise<void>;
  } = {}) => projectControlUpdateControllerScopeView({ registryRootDir,
    controllerJobId: manifest.jobId, projectAccessScope: { ...scope, allowedBranches: ["main", "TEST-repair"] },
    confirmUpdate: true }, {
    loadProjectControlController,
    admissionDeps: { listJobs: async () => [], buildOverviewItems: async () => [] },
    evidenceCustody: new LocalProjectControlEvidenceCustody(),
    recoveryDirectories: localProjectControlRecoveryDirectories,
    recoveryStore: async input => {
      const store = await openProjectControlRecoveryStore(input);
      try { await options.opening?.(); return store; }
      catch (error) { await store.close(); throw error; }
    },
    ...(options.fault ? { recoveryFault: options.fault } : {}),
  });
  const snapshots = async () => {
    const store = await openProjectControlRecoveryStore({ parent: jobRootDir, taskId: manifest.taskId });
    try { return await store.records(); }
    finally { await store.close(); }
  };
  return { ...f, path, update, snapshots };
}

describe("durable confirmed recovery", () => {
  it.each(["archives", "ledger", "ledger-items"] as const)(
    "native admin refuses already missing configured %s without bootstrapping", async role => {
      const f = await nativeControllerFixture();
      const target = role === "archives" ? f.archives : role === "ledger" ? f.ledger : join(f.ledger, "items");
      const before = await readFile(f.path);
      await rename(target, `${target}.saved`);
      let opened = false;
      await expect(f.update({ opening: async () => { opened = true; } })).rejects.toThrow();
      expect(opened).toBe(false);
      expect(await readFile(f.path)).toEqual(before);
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await rename(`${target}.saved`, target);
      await f.assertRetained();
    });

  it.each(["archives", "ledger", "ledger-items"].flatMap(role =>
    [false, true].map(replacement => ({ role, replacement })) ))(
    "native admin pins configured $role across store opening (replacement=$replacement)", async ({ role, replacement }) => {
      const f = await nativeControllerFixture();
      const target = role === "archives" ? f.archives : role === "ledger" ? f.ledger : join(f.ledger, "items");
      const saved = `${target}.saved`;
      const before = await readFile(f.path);
      const beforeManifest = await stat(f.path);
      const original = await stat(target);
      let shifted = false;
      const result = await f.update({ opening: async () => {
        // Real locked controller loading/canonical checks precede this existing factory await.
        await rename(target, saved);
        if (replacement) {
          await mkdir(target);
          if (role === "ledger") await mkdir(join(target, "items"));
        }
        shifted = true;
      } }).catch((error: unknown) => { expect(error).toBeInstanceOf(Error); return undefined; });
      expect(shifted).toBe(true);
      const relocated = (path: string) => path === target || path.startsWith(`${target}/`)
        ? `${saved}${path.slice(target.length)}` : path;
      const retainedFiles = await Promise.all(f.retained.map(async file => {
        const sha256 = createHash("sha256").update(await readFile(relocated(file.path))).digest("hex");
        const metadata = await stat(relocated(file.path));
        const identity = { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode };
        expect(sha256).toBe(file.sha256);
        expect(identity).toEqual(file.identity);
        return { path: file.path, before: { sha256: file.sha256, ...file.identity }, after: { sha256, ...identity } };
      }));
      for (const { path, metadata } of f.directories) {
        expect(await stat(relocated(path))).toMatchObject({ dev: metadata.dev, ino: metadata.ino,
          uid: metadata.uid, gid: metadata.gid, mode: metadata.mode });
      }
      expect(await readdir(relocated(join(f.ledger, "items")))).toEqual(["retained-worker.json"]);
      expect(await readdir(relocated(f.archives))).toEqual(["retained-worker-attempt"]);
      await expect(stat(join(relocated(f.archives), "items"))).rejects.toMatchObject({ code: "ENOENT" });
      const after = await readFile(f.path);
      const afterManifest = await stat(f.path);
      const current = await stat(target).catch(() => undefined);
      const records = await f.snapshots();
      console.log("TEST native custody proof", JSON.stringify({ role, replacement, outcome: result?.outcome ?? "rejected",
        beforeManifestSha256: createHash("sha256").update(before).digest("hex"),
        afterManifestSha256: createHash("sha256").update(after).digest("hex"),
        manifestIdentity: { before: { device: beforeManifest.dev, inode: beforeManifest.ino },
          after: { device: afterManifest.dev, inode: afterManifest.ino } },
        original: { device: original.dev, inode: original.ino },
        current: current ? { device: current.dev, inode: current.ino } : null, records, retainedFiles }));
      expect(result?.outcome ?? "rejected").not.toBe(ProjectControlRecoveryOutcome.Committed);
      expect(after).toEqual(before);
      expect(afterManifest).toMatchObject({ dev: beforeManifest.dev, ino: beforeManifest.ino });
      expect(records.some(record => record.phase === ProjectControlRecoveryPhase.Committed)).toBe(false);
      if (replacement) expect(await readdir(target)).toEqual(role === "ledger" ? ["items"] : []);
      else await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      if (replacement) await rm(target, { recursive: true });
      await rename(saved, target);
      await f.assertRetained();
      expect(await f.update()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed });
      await f.assertRetained();
    });

  it.each([ScopeRecoveryFaultPoint.AfterPrepared, ScopeRecoveryFaultPoint.AfterMaterializedRecord]
    .flatMap(point => ["archives", "ledger"].map(role => ({ point, role }))))(
    "native admin retains initial identities on $role replacement and resume after $point", async ({ point, role }) => {
      const f = await nativeControllerFixture();
      const paths = [f.archives, f.ledger, join(f.ledger, "items")];
      const original = await Promise.all(paths.map(async path => {
        const metadata = await stat(path);
        return { path, device: metadata.dev, inode: metadata.ino };
      }));
      const first = await f.update({ fault: async actual => { if (actual === point) throw new Error("TEST crash"); } });
      expect(first).toMatchObject({ outcome: ProjectControlRecoveryOutcome.PartialSuccess });
      const before = await readFile(f.path);
      const target = role === "archives" ? f.archives : f.ledger;
      const saved = `${target}.saved`;
      await rename(target, saved); await mkdir(target);
      if (role === "ledger") await mkdir(join(target, "items"));
      expect(await f.update()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.PartialSuccess });
      expect(await readFile(f.path)).toEqual(before);
      await rm(target, { recursive: true }); await rename(saved, target);
      await f.assertRetained();
      expect(await f.update()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
      const records = await f.snapshots();
      expect(records[0]?.phase).toBe(ProjectControlRecoveryPhase.Prepared);
      expect(records.at(-1)?.phase).toBe(ProjectControlRecoveryPhase.Committed);
      for (const record of records) for (const identity of original) expect(record.identities).toContainEqual(identity);
      const committed = await stat(f.path);
      expect(await f.update()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
      expect(await stat(f.path)).toMatchObject({ dev: committed.dev, ino: committed.ino });
      await f.assertRetained();
    });

  it("bootstraps wholly absent new roots once when the old scope has no custody", async () => {
    const f = await fixture();
    await rm(f.ledger, { recursive: true }); await rm(f.archives, { recursive: true });
    const first = await f.run();
    expect(first.outcome).toBe(ProjectControlRecoveryOutcome.Committed);
    expect(await readdir(join(f.ledger, "items"))).toEqual([]);
    expect(await readdir(f.archives)).toEqual([]);
    expect(await f.run()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
    expect(f.publications()).toBe(1);
  });

  it.each(["safe-directory-check", "first-journal-append", ScopeRecoveryFaultPoint.AfterPrepared,
    ScopeRecoveryFaultPoint.AfterMaterializedRecord].flatMap(boundary =>
    [false, true].map(replacement => ({ boundary, replacement }))))(
    "pins configured archive across $boundary (replacement=$replacement)", async ({ boundary, replacement }) => {
      const f = await retainedFixture(true);
      const before = await readFile(f.path);
      const saved = `${f.archives}.saved`;
      let shifted = false;
      let replacementInode: number | undefined;
      const shift = async () => {
        if (shifted) return;
        shifted = true;
        await rename(f.archives, saved);
        if (replacement) {
          await mkdir(f.archives);
          replacementInode = (await stat(f.archives)).ino;
        }
      };
      const custody = new class extends LocalProjectControlEvidenceCustody {
        override async canonicalDirectory(path: string, allowMissing = false): Promise<string> {
          const canonical = await super.canonicalDirectory(path, allowMissing);
          if (boundary === "safe-directory-check" && path === f.archives) await shift();
          return canonical;
        }
      }();
      const result = await f.run({ custody,
        fileFault: async (point, name) => {
          if (boundary === "first-journal-append" && point === RecoveryFileFaultPoint.BeforeAppend &&
              name.endsWith("recovery.jsonl")) await shift();
        },
        fault: async point => { if (point === boundary) await shift(); },
      }).catch((error: unknown) => { expect(error).toBeInstanceOf(Error); return undefined; });
      expect(shifted).toBe(true);
      await f.assertRetained(saved);
      const archive = await stat(f.archives).catch(() => undefined);
      expect({ outcome: result?.outcome ?? "rejected", publications: f.publications(), archiveExists: !!archive,
        archiveContents: archive ? await readdir(f.archives) : undefined, archiveInode: archive?.ino })
        .toEqual({ outcome: result ? ProjectControlRecoveryOutcome.PartialSuccess : "rejected",
          publications: 0, archiveExists: replacement, archiveContents: replacement ? [] : undefined,
          archiveInode: replacementInode });
      expect(await readFile(f.path)).toEqual(before);
      if (replacement) await rm(f.archives, { recursive: true });
      await rename(saved, f.archives);
      await f.assertRetained();
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.Committed);
      expect(f.publications()).toBe(1);
      await f.assertRetained();
    });

  it.each([ScopeRecoveryFaultPoint.AfterPrepared, ScopeRecoveryFaultPoint.AfterMaterializedRecord])(
    "refuses incomplete configured identity evidence on resume after %s", async point => {
      const f = await retainedFixture(true);
      const first = await f.run({ fault: async actual => { if (actual === point) throw new Error("TEST crash"); } });
      expect(first.outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      const store = await openProjectControlRecoveryStore({ parent: f.root, taskId: f.controller.taskId });
      try {
        const record = (await store.records()).at(-1)!;
        await store.save({ ...record, identities: record.identities.filter(identity => identity.path !== f.archives) });
      } finally { await store.close(); }
      const saved = `${f.archives}.saved`;
      await rename(f.archives, saved);
      expect((await f.run()).outcome).toBe(ProjectControlRecoveryOutcome.PartialSuccess);
      expect(f.publications()).toBe(0);
      await expect(stat(f.archives)).rejects.toMatchObject({ code: "ENOENT" });
      await f.assertRetained(saved);
      expect((await f.read()).projectAccessScope).toEqual(f.controller.projectAccessScope);
    });

  it.each([false, true].flatMap(configured => [undefined, ...Object.values(ScopeRecoveryFaultPoint)]
    .map(point => ({ configured, point }))))(
    "preserves a retained flat archive (configured=$configured, crash=$point) through scope append", async ({ configured, point }) => {
      const f = await retainedFixture(configured);
      const first = await f.run({ fault: async actual => { if (actual === point) throw new Error("TEST crash"); } });
      expect(first.outcome).toBe(point ? ProjectControlRecoveryOutcome.PartialSuccess : ProjectControlRecoveryOutcome.Committed);
      await f.assertRetained();
      expect(await f.run()).toMatchObject({ outcome: ProjectControlRecoveryOutcome.Committed, operationId: first.operationId });
      expect((await f.read()).projectAccessScope).toEqual(f.proposed);
      expect(f.publications()).toBe(1);
      await f.assertRetained();
    });

  it.each([
    ...["missing-evidence", "file-evidence", "symlink-evidence", "ancestor-symlink", "missing-ledger-items"]
      .map(kind => ({ kind, configured: true })),
    { kind: "missing-ledger-items", configured: false },
  ])(
    "refuses $kind (configured=$configured) without publishing or manufacturing custody", async ({ kind, configured }) => {
      const f = await retainedFixture(configured);
      const ledgerPath = join(f.ledger, "items", "retained-worker.json");
      const ledgerBytes = await readFile(ledgerPath);
      const target = kind === "missing-ledger-items" ? join(f.ledger, "items") : f.archives;
      const saved = `${target}.saved`;
      await rename(target, saved);
      if (kind === "file-evidence") await writeFile(target, "TEST sentinel");
      if (kind === "symlink-evidence") await symlink(saved, target);
      if (kind === "ancestor-symlink") {
        const ancestor = join(f.root, "linked");
        await symlink(f.root, ancestor);
        await rename(saved, target);
        const current = await f.read();
        await durableReplaceJsonFile({ path: f.path, value: { ...current,
          projectAccessScope: { ...current.projectAccessScope, consumedOutputEvidenceRoots: [join(ancestor, "archives")] } } });
      }
      const before = await readFile(f.path);
      await expect(f.run()).rejects.toThrow();
      expect(f.publications()).toBe(0);
      expect(await readFile(f.path)).toEqual(before);
      expect(await readFile(f.journal, "utf8")).toBe("");
      expect(await readFile(kind === "missing-ledger-items" ? join(saved, "retained-worker.json") : ledgerPath)).toEqual(ledgerBytes);
      if (kind.startsWith("missing")) await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });

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
    expect(await readdir(f.archives)).toEqual([]);
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

  it.each(["ledger-items", "archive-root", "legacy-lock", "lock-container", "derived-lock"])(
    "checkpoints the inode before publishing %s and resumes before parent fsync", async kind => {
      const f = await fixture();
      const target = kind === "ledger-items" ? join(f.ledger, "items")
        : kind === "archive-root" ? f.archives
        : kind === "legacy-lock" ? join(f.ledger, ".mutation-locks")
        : kind === "lock-container" ? join(f.root, ".consumed-output-ledger-mutation-locks")
        : join(f.root, ".consumed-output-ledger-mutation-locks", createHash("sha256").update(f.ledger).digest("hex"));
      if (kind === "archive-root") await rm(f.archives, { recursive: true });
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

  it.each(["ledger", "archives"])("refuses %s custody identity drift during reconciliation", async root => {
    const f = await fixture();
    await f.run({ fault: async point => { if (point === ScopeRecoveryFaultPoint.AfterMaterializedRecord) throw new Error("crash"); } });
    const path = root === "ledger" ? join(f.ledger, "items") : f.archives;
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
