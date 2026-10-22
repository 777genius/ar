import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "../index";
import { LocalWorkerAccountTaskRecovery as LegacyV1Recovery } from "./fixtures/legacy-v1-worker-account-task-recovery";
import { WorkerAccountTaskRecoveryPhase, WorkerAccountTaskRecoveryBackend, type WorkerAccountRecoveryReconciliationAuthority, type WorkerAccountAcceptedResponse } from "../../worker-core";

const demand = { provider: "codex", model: "mimo-v2.6-pro", reasoningEffort: "high", serviceTier: "default" };
const task = { jobId: "TEST-job", startId: "TEST-start", workerId: "TEST-worker", specSha256: "a".repeat(64), requestSha256: "b".repeat(64), runtimeArtifactSha256: "c".repeat(64) };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "TEST-mimo-task-recovery-")); roots.push(rootDir);
  const raw = new LocalFileWorkerAccountCapacityStore({ rootDir });
  const original = raw.observe({ accountId: "codex-provider:original", demand, observedAt: new Date(Date.now() - 10_000),
    capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(Date.now() - 5_000) }, retainExpiredForRecheck: true })!;
  const originalBytes = readFileSync(original.recordId);
  const store = new LocalFileWorkerAccountCapacityStore({ rootDir, restrictiveLegacyAccountIdPrefixes: ["codex-provider:"] });
  const recovery = store.originalTaskRecovery(), preparation = recovery.prepareAdmission(demand)!;
  return { rootDir, raw, original, originalBytes, store, recovery, preparation };
}
function credential(key = "d".repeat(64)) { return { credentialFingerprint: key, requestedModel: demand.model, assertCurrent: vi.fn() }; }
function response(key = "d".repeat(64)): WorkerAccountAcceptedResponse {
  return { credentialFingerprint: key, requestedModel: demand.model, requestSha256: "e".repeat(64), responseIdSha256: "f".repeat(64),
    completedResponses: 3, assertCurrent: vi.fn(), assertDisposed: vi.fn() };
}
async function settle(f: ReturnType<typeof fixture>, assertTerminal: () => void = vi.fn()) {
  await f.recovery.settle({ task, assertCurrent() {}, assertTerminal, withPublication: async effect => await effect() }, demand);
}
function phase(root: string) {
  const directory = join(root, "original-task-recovery");
  return JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")).phase;
}

async function revokedFixture() {
  const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
  await session.bindCredential(credential()); session.accepted(response()); await settle(f);
  const directory = join(f.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
  const settledBytes = readFileSync(path), rejectedTask = { ...task, startId: "historical-rejected-task" };
  const historicalBytes = Buffer.from(JSON.stringify({ ...JSON.parse(settledBytes.toString()), schemaVersion: 1 }) + "\n");
  // Reproduce exactly the former writer's v1 Exempted -> Failed transition.
  writeFileSync(path, JSON.stringify({ ...JSON.parse(historicalBytes.toString()), phase: "failed", rejectedTask }) + "\n", { mode: 0o600 });
  const failedBytes = readFileSync(path), hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const authority: WorkerAccountRecoveryReconciliationAuthority = {
    task, rejectedTask, failedRecordSha256: hash(failedBytes), exemptedRecordSha256: hash(historicalBytes),
    assertCurrent: vi.fn(), assertTerminal: vi.fn(), withPublication: async effect => await effect(),
    credential: { backend: WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan, credentialFingerprint: credential().credentialFingerprint,
      model: demand.model, demand, assertCurrent: vi.fn() },
  };
  return { ...f, path, settledBytes, failedBytes, authority };
}

describe("durable original MiMo task recovery", () => {
  it("leaves current-only restrictions to normal selection and refuses recovery when mixed with legacy", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "TEST-mimo-current-only-capacity-")); roots.push(rootDir);
    const raw = new LocalFileWorkerAccountCapacityStore({ rootDir });
    raw.observe({ accountId: "account-q", demand, observedAt: new Date(), capacity: {
      availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: new Date(Date.now() + 60_000),
    } });
    const store = new LocalFileWorkerAccountCapacityStore({ rootDir, restrictiveLegacyAccountIdPrefixes: ["codex-provider:"] });
    expect(store.prepareTaskRecovery({ demand, now: new Date() })).toBeUndefined();
    expect(store.read({ accountId: "account-q", demand })?.availability).toBe("quota_exhausted");
    expect(store.read({ accountId: "account-q", demand })?.reason).toBe("quota_limited");
    raw.observe({ accountId: "codex-provider:original", demand, observedAt: new Date(Date.now() - 10_000),
      capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(Date.now() - 5_000) }, retainExpiredForRecheck: true });
    expect(() => store.prepareTaskRecovery({ demand, now: new Date() })).toThrow("legacy_identity_unresolved");
  });

  it("prepares typed birth without ordinary availability, consumes exactly once across restart and TTL", () => {
    const f = fixture();
    expect(f.preparation.phase).toBe(WorkerAccountTaskRecoveryPhase.Prepared);
    expect(() => f.store.read({ accountId: "account-q", demand })).toThrow("legacy_identity_unresolved");
    f.recovery.consume(f.preparation, task, () => {});
    const restart = f.store.originalTaskRecovery();
    expect(() => restart.prepareAdmission(demand, new Date(Date.now() + 24 * 60 * 60_000))).toThrow("task_recovery_closed");
    expect(() => restart.consume(f.preparation, { ...task, startId: "different-start" }, () => {})).toThrow("task_recovery_closed");
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
  });

  it("keeps old restrictive bytes and only exempts the proven current key after real disposal and terminal publication", async () => {
    const f = fixture(), owner = vi.fn();
    const session = f.recovery.consume(f.preparation, task, owner), key = credential();
    const guard = await session.bindCredential(key);
    expect(session.store.read({ accountId: "account-q", demand })).toBeNull();
    session.accepted(response());
    expect(phase(f.rootDir)).toBe("accepted");
    const cold = vi.fn(); await settle(f, cold);
    expect(cold.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(phase(f.rootDir)).toBe("exempted");
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
    expect(() => f.store.read({ accountId: "account-q", demand })).toThrow("legacy_identity_unresolved");
    const later = f.recovery.consume(f.preparation, { ...task, startId: "next-original-task" }, () => {});
    await expect(later.bindCredential(credential("1".repeat(64)))).rejects.toThrow("task_recovery_closed");
    await expect(later.bindCredential(credential())).resolves.toBeTypeOf("function");
    expect(owner).toHaveBeenCalled();
    expect(() => guard()).toThrow(); // The old live task cannot dispatch after settlement.
  });

  it("never exempts absent, inconclusive or not-disposed response evidence", async () => {
    for (const proof of [undefined, { ...response(), assertDisposed: () => { throw Error("still serving"); } }]) {
      const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
      await session.bindCredential(credential());
      expect(() => session.accepted(proof)).toThrow();
      await settle(f);
      expect(phase(f.rootDir)).toBe("consumed");
      expect(() => f.recovery.consume(f.preparation, task, () => {})).toThrow();
    }
  });

  it("does not publish an exemption while native/provider closure is unproven", async () => {
    const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
    await session.bindCredential(credential()); session.accepted(response());
    await expect(settle(f, () => { throw Error("native still live"); })).rejects.toThrow("native still live");
    expect(phase(f.rootDir)).toBe("accepted");
    expect(() => f.recovery.prepareAdmission(demand)).toThrow();
  });

  it("records newer canonical quota without rewriting legacy and invalidates the live key/exemption", async () => {
    const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
    const guard = await session.bindCredential(credential());
    session.store.observe({ accountId: "account-q", observedAt: new Date(), capacity: { availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(Date.now() + 60_000) } });
    expect(() => guard()).toThrow("legacy_identity_unresolved");
    expect(() => session.accepted(response())).toThrow();
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
    expect(f.raw.readState({ accountId: "account-q", now: new Date() })?.capacity.reason).toBe("quota_limited");
  });

  it("legacy revision, extra restrictive row, key rotation and malformed custody each remain closed", async () => {
    const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {}), key = credential();
    const guard = await session.bindCredential(key);
    key.assertCurrent.mockImplementation(() => { throw Error("key rotated"); });
    expect(() => guard()).toThrow("key rotated");
    writeFileSync(f.original.recordId, "{bad", { mode: 0o600 });
    expect(() => f.recovery.prepareAdmission(demand)).toThrow("legacy_identity_unresolved");
    const g = fixture();
    g.raw.observe({ accountId: "codex-provider:another", observedAt: new Date(), capacity: { availability: "disabled", reason: "provider_session_invalid" } });
    expect(() => g.recovery.prepareAdmission(demand)).toThrow("legacy_identity_unresolved");
  });

  it("retains the settled original witness after a successor fails or lacks accepted response proof", async () => {
    for (const failure of ["task", "missing-proof", "not-disposed"] as const) {
      const f = fixture(), first = f.recovery.consume(f.preparation, task, () => {});
      await first.bindCredential(credential()); first.accepted(response()); await settle(f);
      const directory = join(f.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
      const settledBytes = readFileSync(path);
      const next = f.recovery.consume(f.preparation, { ...task, startId: "next-native-task" }, () => {});
      const nextGuard = await next.bindCredential(credential());
      const peer = f.recovery.consume(f.preparation, { ...task, startId: "parallel-native-task" }, () => {});
      const peerGuard = await peer.bindCredential(credential());
      if (failure === "task") next.failed();
      else expect(() => next.accepted(failure === "missing-proof" ? undefined : {
        ...response(), assertDisposed: () => { throw Error("still serving"); },
      })).toThrow();
      expect(() => nextGuard()).toThrow("task_recovery_closed");
      expect(() => next.store.read({ accountId: "account-q", demand })).toThrow("task_recovery_closed");
      expect(() => peerGuard()).not.toThrow();
      expect(readFileSync(path)).toEqual(settledBytes);
      const restarted = f.store.originalTaskRecovery();
      const successor = restarted.consume(restarted.prepareAdmission(demand)!, { ...task, startId: "following-native-task" }, () => {});
      await successor.bindCredential(credential());
      expect(successor.store.read({ accountId: "account-q", demand })).toBeNull();
      expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
    }
  });

  it("keeps a retained exemption fenced by current key, demand, legacy revision and newer quota", async () => {
    for (const change of ["key", "demand", "legacy", "quota"] as const) {
      const f = fixture(), first = f.recovery.consume(f.preparation, task, () => {});
      await first.bindCredential(credential()); first.accepted(response()); await settle(f);
      const next = f.recovery.consume(f.preparation, { ...task, startId: "failed-native-task" }, () => {});
      const key = credential(), guard = await next.bindCredential(key);
      if (change === "key") key.assertCurrent.mockImplementation(() => { throw Error("key rotated"); });
      if (change === "legacy") {
        const row = JSON.parse(f.originalBytes.toString());
        writeFileSync(f.original.recordId, JSON.stringify({ ...row, revision: "new-limit-revision" }), { mode: 0o600 });
      }
      if (change === "quota") next.store.observe({ accountId: "account-q", observedAt: new Date(), capacity: {
        availability: "cooldown", reason: "quota_limited", cooldownUntil: new Date(Date.now() + 60_000),
      } });
      if (change !== "demand") expect(() => guard()).toThrow();
      next.failed();
      expect(phase(f.rootDir)).toBe("exempted");
      if (change === "quota") expect(() => f.recovery.prepareAdmission(demand)).toThrow();
      else if (change === "legacy") expect(() => f.recovery.consume(f.preparation, { ...task, startId: "stale-revision-task" }, () => {})).toThrow("revision_changed");
      else if (change === "demand") {
        const different = { ...demand, model: "mimo-v2.6-flash" };
        expect(() => f.recovery.prepareAdmission(different)).toThrow("legacy_identity_unresolved");
      } else {
        const other = f.recovery.consume(f.recovery.prepareAdmission(demand)!, { ...task, startId: "rotated-key-task" }, () => {});
        await expect(other.bindCredential(credential("1".repeat(64)))).rejects.toThrow("task_recovery_closed");
      }
    }
  });

  it("does not reinterpret an original failure or a previously persisted failed witness as settled", async () => {
    const f = fixture(), first = f.recovery.consume(f.preparation, task, () => {});
    await first.bindCredential(credential()); first.failed(); await settle(f);
    expect(phase(f.rootDir)).toBe("failed");
    expect(() => f.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
    const g = fixture(), accepted = g.recovery.consume(g.preparation, task, () => {});
    await accepted.bindCredential(credential()); accepted.accepted(response()); await settle(g);
    const directory = join(g.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
    const previous = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...previous, schemaVersion: 1, phase: "failed", rejectedTask: { ...task, startId: "old-rejected-task" } }), { mode: 0o600 });
    await settle(g);
    expect(phase(g.rootDir)).toBe("failed");
    expect(() => g.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
  });

  it("reconciles exact historical settlement only under both cold owners and the proven current key", async () => {
    const f = await revokedFixture();
    await f.recovery.reconcileSettledExemption(f.authority, demand);
    expect(readFileSync(f.path)).toEqual(f.settledBytes);
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
    const next = f.recovery.consume(f.recovery.prepareAdmission(demand)!, { ...task, startId: "after-reconciliation" }, () => {});
    await next.bindCredential(credential());
    expect(next.store.read({ accountId: "account-q", demand })).toBeNull();
    await expect(f.recovery.reconcileSettledExemption(f.authority, demand)).rejects.toThrow("task_recovery_closed");
  });

  it("keeps failed history closed for mismatched witness, owners, key, demand, limits or physical closure", async () => {
    for (const mismatch of ["historical-hash", "failed-hash", "original", "rejected", "same-task", "key", "model", "demand", "rotated", "live", "quota", "legacy", "cas", "publication-crash"] as const) {
      const f = await revokedFixture(), original = f.authority;
      const authority = { ...original, credential: { ...original.credential } };
      if (mismatch === "historical-hash") authority.exemptedRecordSha256 = "0".repeat(64);
      if (mismatch === "failed-hash") authority.failedRecordSha256 = "0".repeat(64);
      if (mismatch === "original") authority.task = { ...task, startId: "unrelated-original" };
      if (mismatch === "rejected") authority.rejectedTask = { ...task, startId: "unrelated-rejected" };
      if (mismatch === "same-task") authority.rejectedTask = task;
      if (mismatch === "key") authority.credential.credentialFingerprint = "0".repeat(64);
      if (mismatch === "model") authority.credential.model = "mimo-v2.6-flash";
      if (mismatch === "demand") authority.credential.demand = { ...demand, reasoningEffort: "medium" };
      if (mismatch === "rotated") authority.credential.assertCurrent = () => { throw Error("key rotated"); };
      if (mismatch === "live") authority.assertTerminal = () => { throw Error("rejected provider still live"); };
      if (mismatch === "quota") f.raw.observe({ accountId: "account-q", demand, observedAt: new Date(), capacity: {
        availability: "quota_exhausted", reason: "quota_limited", cooldownUntil: new Date(Date.now() + 60_000),
      } });
      if (mismatch === "legacy") writeFileSync(f.original.recordId, JSON.stringify({
        ...JSON.parse(f.originalBytes.toString()), revision: "new-legacy-revision",
      }), { mode: 0o600 });
      if (mismatch === "publication-crash") authority.withPublication = async () => { throw Error("publication crashed before mutation"); };
      if (mismatch === "cas") authority.withPublication = async effect => {
        writeFileSync(f.path, f.failedBytes.toString() + " ", { mode: 0o600 });
        return await effect();
      };
      const legacyBytes = readFileSync(f.original.recordId);
      await expect(f.recovery.reconcileSettledExemption(authority, demand)).rejects.toThrow();
      expect(phase(f.rootDir)).toBe("failed");
      if (mismatch !== "cas") expect(readFileSync(f.path)).toEqual(f.failedBytes);
      expect(readFileSync(f.original.recordId)).toEqual(legacyBytes);
    }
  });

  it("retains the exact settled result when publication crashes after its atomic mutation", async () => {
    const f = await revokedFixture();
    const authority: WorkerAccountRecoveryReconciliationAuthority = { ...f.authority, withPublication: async effect => {
      await effect(); throw Error("publication crashed after mutation");
    } };
    await expect(f.recovery.reconcileSettledExemption(authority, demand)).rejects.toThrow("crashed after mutation");
    expect(readFileSync(f.path)).toEqual(f.settledBytes);
    await expect(f.recovery.reconcileSettledExemption(f.authority, demand)).rejects.toThrow("task_recovery_closed");
    expect(readFileSync(f.path)).toEqual(f.settledBytes);
  });

  it("fences the actual old v1 producer even if it prepared or consumed before reconciliation", async () => {
    const f = fixture();
    const legacy = new LegacyV1Recovery(Reflect.get(f.recovery, "input") as ConstructorParameters<typeof LegacyV1Recovery>[0]);
    const first = legacy.consume(f.preparation, task, () => {});
    await first.bindCredential(credential()); first.accepted(response());
    await legacy.settle({ task, assertCurrent() {}, assertTerminal() {}, withPublication: async effect => await effect() }, demand);
    const pending = legacy.prepareAdmission(demand)!;
    const oldHolder = legacy.consume(pending, { ...task, startId: "old-held-scope" }, () => {});
    const guard = await oldHolder.bindCredential(credential());
    const rejectedTask = { ...task, startId: "old-failed-scope" };
    const revoker = legacy.consume(pending, rejectedTask, () => {});
    const directory = join(f.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
    const historical = readFileSync(path); revoker.failed(); const failed = readFileSync(path);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    await f.recovery.reconcileSettledExemption({ task, rejectedTask,
      failedRecordSha256: hash(failed), exemptedRecordSha256: hash(historical),
      assertCurrent() {}, assertTerminal() {}, withPublication: async effect => await effect(),
      credential: { backend: WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan, credentialFingerprint: credential().credentialFingerprint,
        model: demand.model, demand, assertCurrent() {} },
    }, demand);
    const upgraded = readFileSync(path);
    expect(JSON.parse(upgraded.toString()).schemaVersion).toBe(2);
    expect(() => legacy.consume(pending, { ...task, startId: "old-pending-start" }, () => {})).toThrow("task_recovery_closed");
    expect(() => guard()).toThrow("task_recovery_closed");
    expect(() => oldHolder.failed()).toThrow("task_recovery_closed");
    expect(readFileSync(path)).toEqual(upgraded);
    expect(() => f.recovery.prepareAdmission(demand)).not.toThrow();
  });

  it("writes v2 only for fully proven settlements and rejects other v2 phases", async () => {
    const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
    await session.bindCredential(credential()); session.accepted(response()); await settle(f);
    const directory = join(f.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
    const settled = JSON.parse(readFileSync(path, "utf8"));
    expect(settled.schemaVersion).toBe(2);
    for (const changed of ["consumed", "accepted", "failed"]) {
      writeFileSync(path, JSON.stringify({ ...settled, phase: changed }), { mode: 0o600 });
      expect(() => f.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
    }
    const { responseIdSha256: _missing, ...incomplete } = settled;
    writeFileSync(path, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => f.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
  });

  it("rejects oversized private recovery state before parsing or admitting a successor", () => {
    const f = fixture(); f.recovery.consume(f.preparation, task, () => {});
    const directory = join(f.rootDir, "original-task-recovery"), path = join(directory, readdirSync(directory)[0]!);
    writeFileSync(path, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(() => f.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
  });

  it("rejects a revised same legacy row even when its timer is due", async () => {
    const f = fixture(), session = f.recovery.consume(f.preparation, task, () => {});
    const guard = await session.bindCredential(credential());
    const row = JSON.parse(f.originalBytes.toString());
    writeFileSync(f.original.recordId, JSON.stringify({ ...row, revision: "new-limit-revision" }), { mode: 0o600 });
    expect(() => guard()).toThrow("revision_changed");
    expect(() => session.accepted(response())).toThrow();
  });
});
