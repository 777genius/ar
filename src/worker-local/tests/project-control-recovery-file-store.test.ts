import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ProjectControlRecoveryOperation, ProjectControlRecoveryPhase, ProjectControlRecoveryAuditPhase } from "@vioxen/subscription-runtime/worker-core";
import { openProjectControlRecoveryStore, RecoveryFileFaultPoint } from "../project-control-recovery-file-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovery-audit-")); roots.push(root);
  const parent = join(root, "parent"); await mkdir(parent);
  const record = { operationId: randomUUID(), operation: ProjectControlRecoveryOperation.ControllerScope,
    phase: ProjectControlRecoveryPhase.Prepared, controllerJobId: "controller",
    beforeManifestSha256: "a".repeat(64), afterManifestSha256: "b".repeat(64),
    proposedScopeSha256: "c".repeat(64), at: new Date().toISOString(), identities: [] };
  return { root, parent, record, taskId: "controller", audit: join(parent, "controller.project-control-events.jsonl") };
}

describe("anchored recovery audit", () => {
  it.each(["ancestor-symlink", "leaf-symlink", "hard-link", "directory"])("rejects %s before writing", async kind => {
    const f = await fixture();
    const outside = join(f.root, "outside"); await mkdir(outside);
    const sentinel = join(outside, "sentinel"); await writeFile(sentinel, "sentinel");
    if (kind === "ancestor-symlink") {
      await rm(f.parent, { recursive: true }); await symlink(outside, f.parent);
    } else if (kind === "leaf-symlink") await symlink(sentinel, f.audit);
    else if (kind === "hard-link") await link(sentinel, f.audit);
    else await mkdir(f.audit);
    await expect(openProjectControlRecoveryStore(f)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
    expect(await readdir(outside)).toEqual(["sentinel"]);
  });

  it.each(["parent", "audit", "hard-link", "ancestor-symlink"])("rejects a late %s attack before append", async kind => {
    const f = await fixture();
    const store = await openProjectControlRecoveryStore({ ...f, fault: async (point, name) => {
      if (point !== RecoveryFileFaultPoint.BeforeAppend || !name.endsWith("events.jsonl")) return;
      if (kind === "parent" || kind === "ancestor-symlink") {
        await rename(f.parent, join(f.root, "saved-parent"));
        if (kind === "parent") await mkdir(f.parent);
        else await symlink(join(f.root, "saved-parent"), f.parent);
      } else if (kind === "audit") {
        await rename(f.audit, `${f.audit}.saved`); await writeFile(f.audit, "sentinel");
      } else await link(f.audit, join(f.root, "alias"));
    } });
    try {
      await store.save(f.record);
      await expect(store.audit(f.record, ProjectControlRecoveryAuditPhase.Requested)).rejects.toThrow();
      if (kind === "audit") expect(await readFile(f.audit, "utf8")).toBe("sentinel");
      if (kind === "hard-link") expect(await readFile(join(f.root, "alias"), "utf8")).toBe("");
      if (kind === "parent") expect(await readdir(f.parent)).toEqual([]);
    } finally { await store.close(); }
  });

  it("revalidates parent and file after append instead of reporting success", async () => {
    const f = await fixture();
    const store = await openProjectControlRecoveryStore({ ...f, fault: async (point, name) => {
      if (point === RecoveryFileFaultPoint.AfterAppend && name.endsWith("events.jsonl")) {
        await rename(f.parent, join(f.root, "saved-parent")); await mkdir(f.parent);
      }
    } });
    try { await expect(store.audit(f.record, ProjectControlRecoveryAuditPhase.Requested)).rejects.toThrow(); }
    finally { await store.close(); }
    expect(await readdir(f.parent)).toEqual([]);
  });

  it.each(["outside-parent", "wrong-operation", "already-applied", "wrong-phase"])(
    "rejects an inconsistent pending directory: %s", async kind => {
      const f = await fixture();
      const target = join(f.parent, "items");
      const pending = { path: target, device: 1, inode: 2,
        stagingPath: join(f.parent, `.custody-${f.record.operationId}-staged`) };
      const record = { ...f.record, pendingDirectory: pending,
        ...(kind === "wrong-phase" ? { phase: ProjectControlRecoveryPhase.Materialized } : {}),
        ...(kind === "already-applied" ? { identities: [{ path: target, device: 1, inode: 2 }] } : {}) };
      if (kind === "outside-parent") pending.stagingPath = join(f.root, `.custody-${f.record.operationId}-staged`);
      if (kind === "wrong-operation") pending.stagingPath = join(f.parent, `.custody-${randomUUID()}-staged`);
      const store = await openProjectControlRecoveryStore(f);
      try {
        await store.save(record);
        await expect(store.records()).rejects.toThrow("project_control_recovery_journal_invalid");
      } finally { await store.close(); }
    });

  it("reconciles a torn audit frame and deduplicates the durable operation", async () => {
    const f = await fixture();
    let store = await openProjectControlRecoveryStore(f);
    await store.save(f.record); await store.close();
    await writeFile(f.audit, '{"torn":');
    store = await openProjectControlRecoveryStore(f);
    try {
      expect(await store.records()).toEqual([f.record]);
      await store.audit(f.record, ProjectControlRecoveryAuditPhase.Requested);
      await store.audit(f.record, ProjectControlRecoveryAuditPhase.Requested);
      const events = (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(events).toHaveLength(1); expect(events[0].operationId).toBe(f.record.operationId);
    } finally { await store.close(); }
  });
});
