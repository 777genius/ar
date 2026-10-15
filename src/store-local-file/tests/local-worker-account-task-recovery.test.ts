import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalFileWorkerAccountCapacityStore } from "../index";
import { WorkerAccountTaskRecoveryPhase, type WorkerAccountAcceptedResponse } from "../../worker-core";

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

  it("revokes an established same-key exemption after a later inconclusive response even without a quota classifier", async () => {
    const f = fixture(), first = f.recovery.consume(f.preparation, task, () => {});
    await first.bindCredential(credential()); first.accepted(response()); await settle(f);
    const next = f.recovery.consume(f.preparation, { ...task, startId: "next-native-task" }, () => {});
    await next.bindCredential(credential());
    expect(() => next.accepted(undefined)).toThrow("task_recovery_closed");
    expect(phase(f.rootDir)).toBe("failed");
    expect(() => f.recovery.prepareAdmission(demand)).toThrow("task_recovery_closed");
    expect(readFileSync(f.original.recordId)).toEqual(f.originalBytes);
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
