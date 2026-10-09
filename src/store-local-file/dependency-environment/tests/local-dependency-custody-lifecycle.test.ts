import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { DependencyConsumerLaunchKind, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { claimDependencyConsumer, assertDependencyConsumer, markDependencyConsumerRunning, fenceDependencyConsumer,
  claimDependencyMaintenance, assertDependencyMaintenance, releaseDependencyMaintenance,
  DependencyOwnerPhase, type DependencyWorkspaceIdentity } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyOwnerStore } from "../local-dependency-owner-store";

const id = "00000000-0000-4000-8000-000000000001";
const ref = { path: "/TEST-protected/adoption.json", identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) };
const ordinary = { installationId: id, bootId: id, runtimeSha: "b".repeat(40), grantDigest: "c".repeat(64), startId: id,
  unit: `subscription-runtime-ordinary-${id}.service` };
const managed = { ...ordinary, kind: DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,
  association: ref, origin: { ...ref, path: "/TEST-protected/actual-start.json" }, unit: `subscription-runtime-outer-${id}.service` };
const host = { installationId: id, bootId: id, runtimeSha: ordinary.runtimeSha, grantDigest: managed.grantDigest,
  inventoryDigest: "d".repeat(64), supervisorId: "123:456" };
function custody(store: LocalDependencyOwnerStore, workspace: DependencyWorkspaceIdentity) {
  const value = store.read(workspace);
  if (!value || value.version !== 3) throw new Error("TEST expected actual stored custody record");
  return value;
}

// Actual disposable CAS/rename/fsync history catches v3 reconstruction/downgrade,
// kind loss while fencing, and reuse of stale epochs. References are data fixtures;
// these tests do not manufacture host authority, Ready or drain proof.
it.skipIf(process.platform !== "linux")("preserves the adopted pointer through real consumer and maintenance state transitions", () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-custody-lifecycle-"));
  mkdirSync(join(root,"owners"),{ mode: 0o700 });
  writeFileSync(join(root,"outside-sentinel"),"outside");
  const store = LocalDependencyOwnerStore.open({ rootPath: join(root,"owners"), maxRecordBytes: 16384 });
  const workspace = { canonicalPath: "/TEST-original/workspace", dev: "1", ino: "42" };
  try {
    store.compareAndSwap(workspace,null,{ version: 2, workspace, revision: 1, epoch: 1, owner: null });
    store.compareAndSwap(workspace,1,{ version: 3, workspace, revision: 2, epoch: 1, owner: null, custodyBinding: ref });
    const before = custody(store,workspace);
    expect(() => claimDependencyConsumer(store,workspace,ordinary,id)).toThrow("unsupported");
    expect(custody(store,workspace)).toEqual(before);
    const attempt = claimDependencyConsumer(store,workspace,managed,id);
    expect(attempt.epoch).toBe(2);
    const claimed = assertDependencyConsumer(store,workspace,attempt,DependencyOwnerPhase.ExclusiveMutation);
    expect(claimed.version).toBe(3); expect(claimed.revision).toBe(3);
    expect(sameDependencyProtectedReference(custody(store,workspace).custodyBinding,ref)).toBe(true);
    markDependencyConsumerRunning(store,workspace,attempt,"100");
    expect(custody(store,workspace).activity).toEqual({ lastEntry: { epoch: 2, atMs: "100" }, lastRelease: null });
    expect(() => claimDependencyMaintenance(store,workspace,host,id)).toThrow("busy");
    fenceDependencyConsumer(store,workspace,attempt);
    const fenced = custody(store,workspace);
    expect(fenced.owner?.phase).toBe(DependencyOwnerPhase.Fenced);
    expect(fenced.owner?.kind).toBe("consumer");
    expect(fenced.custodyBinding).toEqual(ref);
    fenceDependencyConsumer(store,workspace,attempt);
    expect(custody(store,workspace)).toEqual(fenced);
    // Storage-only release after Fenced: the host must independently prove its
    // actual complete drain before proposing this edge in production.
    store.compareAndSwap(workspace,fenced.revision,{ ...fenced, revision: fenced.revision + 1, owner: null,
      activity: { lastEntry: { epoch: 2, atMs: "100" }, lastRelease: { epoch: 2, atMs: "200" } } });
    const second = claimDependencyConsumer(store,workspace,managed,id);
    expect(second.epoch).toBe(3);
    expect(() => assertDependencyConsumer(store,workspace,attempt,DependencyOwnerPhase.ExclusiveMutation)).toThrow("stale_attempt");
    const secondRecord = custody(store,workspace);
    expect(secondRecord.custodyBinding).toEqual(ref);
    fenceDependencyConsumer(store,workspace,second);
    const held = custody(store,workspace);
    store.compareAndSwap(workspace,held.revision,{ ...held, revision: held.revision + 1, owner: null });
    const idle = custody(store,workspace), maintenance = claimDependencyMaintenance(store,workspace,host,id);
    expect(maintenance.epoch).toBe(4);
    expect(custody(store,workspace).custodyBinding).toEqual(ref);
    expect(custody(store,workspace).activity).toEqual(idle.activity);
    expect(() => assertDependencyMaintenance(store,workspace,{ ...maintenance, host: { ...host, grantDigest: "e".repeat(64) } })).toThrow("stale_attempt");
    releaseDependencyMaintenance(store,workspace,maintenance);
    const final = custody(store,workspace);
    expect(final.owner).toBeNull(); expect(final.epoch).toBe(4);
    expect(final.custodyBinding).toEqual(ref); expect(final.activity).toEqual(idle.activity);
    expect(readFileSync(join(root,"outside-sentinel"),"utf8")).toBe("outside");
  } finally { store.close(); rmSync(root,{ recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("cannot bootstrap custody authority from a launch fixture or migrate old idle wire implicitly", () => {
  const root = mkdtempSync(join(tmpdir(),"dependency-custody-no-bootstrap-"));
  const store = LocalDependencyOwnerStore.open({ rootPath: root, maxRecordBytes: 16384 });
  const workspace = { canonicalPath: "/TEST-original/workspace", dev: "1", ino: "42" };
  try {
    expect(() => claimDependencyConsumer(store,workspace,managed,id)).toThrow("unsupported");
    expect(store.read(workspace)).toBeNull();
    store.compareAndSwap(workspace,null,{ version: 2, workspace, revision: 1, epoch: 1, owner: null });
    expect(() => claimDependencyConsumer(store,workspace,managed,id)).toThrow("unsupported");
    expect(store.read(workspace)).toEqual({ version: 2, workspace, revision: 1, epoch: 1, owner: null });
    const ordinaryAttempt = claimDependencyConsumer(store,workspace,ordinary,id);
    expect(ordinaryAttempt.epoch).toBe(2);
    expect(assertDependencyConsumer(store,workspace,ordinaryAttempt,DependencyOwnerPhase.ExclusiveMutation).version).toBe(2);
  } finally { store.close(); rmSync(root,{ recursive: true, force: true }); }
});
