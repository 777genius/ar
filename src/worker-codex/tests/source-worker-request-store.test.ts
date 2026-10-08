import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceWorkerOperation, SourceWorkerState, SourceWorkerOutcome, ProjectAdmissionWorkerRole,
  type SourceWorkerBinding, type SourceWorkerQuiescenceProof, type SourceWorkerRequestRecord } from "@vioxen/subscription-runtime/worker-core";
import { decodeSourceWorkerEnvelope, normalizeSourceWorkerStart, sourceWorkerReadModel, sourceWorkerAcceptedBinding, type SourceWorkerStartEnvelope } from "../source-worker-request-codec";
import { SourceWorkerRequestStore } from "../source-worker-request-store";
const binding: SourceWorkerBinding = { installationId: "test-install", configSha256: "a".repeat(64),
  runtimeSha: "b".repeat(40), runtimeManifestSha256: "c".repeat(64), policySha256: "d".repeat(64), scopeSha256: "e".repeat(64) };
function envelope(): SourceWorkerStartEnvelope {
  return { schemaVersion: 1, operation: SourceWorkerOperation.Start, requestId: "test-request", workstreamId: "test-workstream",
    expectedMachineId: "test-machine", workerJobId: "test-worker", sourceSha: "f".repeat(40), expectedConfigSha256: binding.configSha256,
    deadlineMs: 2_000_000, refill: { sourceWorkspacePath: "/test/source", workspacePath: "/test/worktree", newBranch: "feat/test",
      promptBody: "TEST request prompt never returned by status", workerRole: ProjectAdmissionWorkerRole.Producer,
      reasoningEffort: "high", model: "gpt-6.1-sol", serviceTier: "default", executionMode: "sync", timeoutMs: 60_000,
      cleanupTimeoutMs: 10_000, preStartAdmission: { mode: "serial-builtin", contract: {
        kind: "worker-launch", format: 1, canonicalSha: "f".repeat(40), baseSha: "f".repeat(40), phaseStartSha: "f".repeat(40),
        packetRevision: "test-r1", controllerPacket: "controller.md", lanePacket: "lane.md", phaseId: "phase-01", laneId: "test",
        inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["src/test.ts"], mandatoryDocs: ["controller.md", "lane.md"],
        mandatoryScripts: [], mandatoryFixtures: [], requiredChecks: [{ id: "test", cwd: "test", command: "true" }],
        executionPolicy: { mode: "sandbox-only", sandboxRoot: "/test/sandbox", forbiddenRealProjects: ["/test/forbidden"] },
      } } } };
}
function identity() { return normalizeSourceWorkerStart(envelope(), binding); }
function proof(record: SourceWorkerRequestRecord): SourceWorkerQuiescenceProof {
  return { requestFingerprint: record.identity.fingerprint, runtimeStartId: record.runtimeStartId,
    receiptSha256: "1".repeat(64), operationSettled: true, ownerLossFenced: false, producersClosed: true,
    queuedSubmissions: 0, liveDescendants: 0, noDispatchProven: true };
}
async function fixture(effect: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "source-worker-TEST-"));
  try { await effect(root); } finally { await rm(root, { recursive: true, force: true }); }
}
describe("closed SOURCE request identity", () => {
  it("normalizes omitted sync/model defaults before fingerprinting, excluding object key order", () => {
    const explicit = envelope(), { executionMode: _mode, model: _model, serviceTier: _tier, ...refill } = explicit.refill;
    const decoded = decodeSourceWorkerEnvelope({ ...explicit, refill });
    expect(decoded.operation).toBe(SourceWorkerOperation.Start);
    expect(normalizeSourceWorkerStart(decoded as SourceWorkerStartEnvelope, binding)).toEqual(identity());
    const reordered = Object.fromEntries(Object.entries(explicit).reverse());
    expect(normalizeSourceWorkerStart(reordered as SourceWorkerStartEnvelope, binding).fingerprint).toBe(identity().fingerprint);
  });
  it("denies bounded/async, caller launch authority and nonordinary engines before acceptance", () => {
    for (const executionMode of ["bounded", "async"]) expect(() => decodeSourceWorkerEnvelope({ ...envelope(), refill: { ...envelope().refill, executionMode } })).toThrow();
    for (const override of [{ env: {} }, { executable: "/bin/true" }, { unit: "foreign.service" }, { registryRootDir: "/foreign" }, { childSlot: {} }, { engine: "mimo" }]) {
      expect(() => decodeSourceWorkerEnvelope({ ...envelope(), ...override })).toThrow();
    }
    expect(() => decodeSourceWorkerEnvelope({ ...envelope(), refill: { ...envelope().refill, model: "other" } })).toThrow();
  });
  it("binds business args and source/config deadlines while lookup cannot carry a replacement payload", () => {
    for (const changed of [{ ...envelope(), sourceSha: "9".repeat(40) }, { ...envelope(), deadlineMs: 3_000_000 },
      { ...envelope(), refill: { ...envelope().refill, promptBody: "different task" } }]) {
      expect(normalizeSourceWorkerStart(changed, binding).fingerprint).not.toBe(identity().fingerprint);
    }
    expect(() => normalizeSourceWorkerStart(envelope(), { ...binding, configSha256: "9".repeat(64) })).toThrow("source_worker_config_mismatch");
    expect(() => decodeSourceWorkerEnvelope({ schemaVersion: 1, operation: SourceWorkerOperation.Status, requestId: "test-request",
      workstreamId: "test-workstream", expectedMachineId: "test-machine", refill: envelope().refill })).toThrow();
  });
});
describe("durable SOURCE no-replay store", () => {
  it("allows one dispatch decision under concurrent same-ID accepts and preserves it across lost ACK/restart", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), request = identity();
    const results = await Promise.allSettled([store.accept(request), store.accept(request)]);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    expect(results.filter(result => result.status === "fulfilled" && result.value.created)).toHaveLength(1);
    const reopened = new SourceWorkerRequestStore(root);
    expect((await reopened.accept(request)).created).toBe(false);
    expect((await reopened.read(request.workstreamId, request.requestId))?.state).toBe(SourceWorkerState.Reserved);
    await expect(reopened.accept(normalizeSourceWorkerStart({ ...envelope(), refill: { ...envelope().refill, promptBody: "replacement" } }, binding))).rejects.toThrow("source_worker_request_conflict");
  }));
  it("lists original workstream records after restart, excludes foreign identities and refuses incomplete revisions", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), accepted = await store.accept(identity());
    await store.accept(normalizeSourceWorkerStart({ ...envelope(), requestId: "foreign-request", workstreamId: "foreign-workstream" }, binding));
    const reopened = new SourceWorkerRequestStore(root);
    expect((await reopened.list("test-workstream")).map(record => record.identity.requestId)).toEqual(["test-request"]);
    expect((await reopened.list("foreign-workstream")).map(record => record.identity.requestId)).toEqual(["foreign-request"]);
    const namespace = join(root, "source-worker-requests");
    let selected = "";
    for (const name of await readdir(namespace)) {
      const candidate = join(namespace, name);
      // A foreign record's presence cannot become authority for this workstream.
      if ((await readFile(join(candidate, "1.json"), "utf8")).includes('"test-request"')) selected = candidate;
    }
    await writeFile(join(selected, "3.json"), JSON.stringify({ ...accepted.record, revision: 3, state: SourceWorkerState.Uncertain }), { mode: 0o600 });
    await expect(reopened.list("test-workstream")).rejects.toThrow("source_worker_publication_uncertain");
    await rm(join(selected, "3.json")); await rm(join(selected, "1.json"));
    await expect(reopened.list("test-workstream")).rejects.toThrow("source_worker_publication_uncertain");
  }));
  it("retains terminal identity permanently and never exposes prompt/config/account data in the read model", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root, proof), { record } = await store.accept(identity());
    const terminal = await store.revise(record.identity.workstreamId, record.identity.requestId, 1, {
      ...record, state: SourceWorkerState.Terminal, outcome: SourceWorkerOutcome.FailedBeforeEffect, terminalReceiptSha256: "1".repeat(64),
    });
    expect(terminal.revision).toBe(2);
    const reopened = new SourceWorkerRequestStore(root, proof);
    const retry = await reopened.accept(identity());
    expect(retry.created).toBe(false); expect(retry.record.state).toBe(SourceWorkerState.Terminal);
    const original = normalizeSourceWorkerStart(envelope(), sourceWorkerAcceptedBinding(retry.record.identity));
    expect((await reopened.accept(original)).created).toBe(false);
    const changedConfig = { ...binding, configSha256: "2".repeat(64) };
    await expect(reopened.accept(normalizeSourceWorkerStart({ ...envelope(), expectedConfigSha256: changedConfig.configSha256 }, changedConfig))).rejects.toThrow("source_worker_request_conflict");
    const view = sourceWorkerReadModel(retry.record);
    expect(Object.keys(view).sort()).toEqual(["brokerEpochId", "deadlineMs", "fingerprint", "outcome", "requestId", "revision", "runtimeStartId", "sourceSpecSha256", "state", "terminalReceiptSha256", "terminationFenceSha256", "workerJobId", "workstreamId"].sort());
    expect(JSON.stringify(view)).not.toContain("TEST request prompt");
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 2, { ...terminal, state: SourceWorkerState.Starting, outcome: null, terminalReceiptSha256: null })).rejects.toThrow("source_worker_transition_denied");
  }));
  it("retains request fence/custody references and rejects stale revisions or reopening after stop", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), { record } = await store.accept(identity());
    const starting = await store.revise(record.identity.workstreamId, record.identity.requestId, 1, { ...record,
      state: SourceWorkerState.Starting, brokerEpochId: "test-epoch", runtimeStartId: "test-start", sourceSpecSha256: "3".repeat(64) });
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 1, { ...starting, state: SourceWorkerState.Running })).rejects.toThrow("source_worker_revision_conflict");
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 2, { ...starting, state: SourceWorkerState.Running,
      runtimeStartId: "foreign-start" })).rejects.toThrow("source_worker_correlation_changed");
    const stopped = await store.revise(record.identity.workstreamId, record.identity.requestId, 2, { ...starting,
      state: SourceWorkerState.StopRequested, terminationFenceSha256: "4".repeat(64) });
    const uncertain = await store.revise(record.identity.workstreamId, record.identity.requestId, 3, { ...stopped, state: SourceWorkerState.Uncertain });
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 4, { ...uncertain, state: SourceWorkerState.Running })).rejects.toThrow("source_worker_record_invalid");
    expect((await store.read(record.identity.workstreamId, record.identity.requestId))?.terminationFenceSha256).toBe("4".repeat(64));
  }));
  it("requires authenticated positive quiescence and independently denies queued/live debt or owner-loss completion", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), { record } = await store.accept(identity());
    const starting = await store.revise(record.identity.workstreamId, record.identity.requestId, 1, { ...record,
      state: SourceWorkerState.Starting, brokerEpochId: "test-epoch", runtimeStartId: "test-start", sourceSpecSha256: "3".repeat(64) });
    const running = await store.revise(record.identity.workstreamId, record.identity.requestId, 2, { ...starting, state: SourceWorkerState.Running });
    const terminal = { ...running, state: SourceWorkerState.Terminal, outcome: SourceWorkerOutcome.Completed, terminalReceiptSha256: "1".repeat(64) };
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 3, terminal, proof(terminal))).rejects.toThrow("source_worker_terminal_authority_required");
    for (const fault of [{ queuedSubmissions: 1 }, { liveDescendants: 1 }, { operationSettled: false, ownerLossFenced: true }, { runtimeStartId: "foreign-start" }]) {
      const unsafe = new SourceWorkerRequestStore(root, next => ({ ...proof(next), ...fault }));
      await expect(unsafe.revise(record.identity.workstreamId, record.identity.requestId, 3, terminal)).rejects.toThrow("source_worker_terminal_proof_required");
    }
    const valid = new SourceWorkerRequestStore(root, proof);
    expect((await valid.revise(record.identity.workstreamId, record.identity.requestId, 3, terminal)).outcome).toBe(SourceWorkerOutcome.Completed);
  }));
  it("requires positive no-dispatch proof for a before-effect outcome", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root, next => ({ ...proof(next), noDispatchProven: false }));
    const { record } = await store.accept(identity());
    await expect(store.revise(record.identity.workstreamId, record.identity.requestId, 1, { ...record, state: SourceWorkerState.Terminal,
      outcome: SourceWorkerOutcome.FailedBeforeEffect, terminalReceiptSha256: "1".repeat(64) })).rejects.toThrow("source_worker_terminal_proof_required");
  }));
  it("refuses a writable authority parent before a restarted broker can recreate erased permanent identities", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root); await store.accept(identity());
    await chmod(root, 0o777);
    await rename(join(root, "source-worker-requests"), join(root, "retained-authority"));
    await mkdir(join(root, "source-worker-requests"), { mode: 0o700 });
    expect(() => new SourceWorkerRequestStore(root)).toThrow("source_worker_storage_identity_invalid");
    await chmod(root, 0o700);
  }));
  it("does not reinterpret incomplete original publication or missing revision as a fresh generation", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), request = identity();
    await store.accept(request);
    const namespace = join(root, "source-worker-requests"), directory = join(namespace, (await readdir(namespace))[0]!);
    await rename(join(directory, "1.json"), join(directory, "1.retained"));
    const reopened = new SourceWorkerRequestStore(root);
    await expect(reopened.accept(request)).rejects.toThrow("source_worker_publication_uncertain");
    await rm(join(directory, "1.retained"));
    await expect(reopened.accept(request)).rejects.toThrow("source_worker_publication_uncertain");
  }));
  it("rejects replaced record/scope and symlink identities instead of acknowledging foreign state", async () => fixture(async root => {
    const store = new SourceWorkerRequestStore(root), request = identity(), accepted = await store.accept(request);
    const namespace = join(root, "source-worker-requests"), directory = join(namespace, (await readdir(namespace))[0]!);
    await rename(join(directory, "1.json"), join(root, "retained.json"));
    await writeFile(join(directory, "1.json"), JSON.stringify(accepted.record), { mode: 0o600 });
    await expect(store.read(request.workstreamId, request.requestId)).rejects.toThrow("source_worker_storage_identity_invalid");
    await rename(namespace, join(root, "retained-namespace"));
    await mkdir(namespace, { mode: 0o700 });
    await expect(store.read(request.workstreamId, request.requestId)).rejects.toThrow("source_worker_storage_identity_invalid");
    await rm(namespace, { recursive: true });
    await symlink(join(root, "retained-namespace"), namespace);
    expect(() => new SourceWorkerRequestStore(root)).toThrow("source_worker_storage_identity_invalid");
  }));
});
