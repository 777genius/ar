import { afterEach, describe, expect, it } from "vitest";
import { realpathSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPreviousAdmissionDeniedStartTerminal, buildRepairedAdmission, exchangeAdmissionDirectories, parseRepairPlan, publishRepairedAdmission, finalizeRetainedAdmissionArchive, relocateAdmissionArchive, verifyAdmissionRepairStartRearmProof } from "../../../host-integration/runtime-admission/mimo-job-admission-repair.mjs";
import { materializeBuiltinWorkerLaunchSpec } from "../application/project-control/codex-goal-project-builtin-pre-start-admission";
import { parseWorkerLaunchSpec, parseWorkerLaunchState } from "../application/project-control/worker-launch-spec";
import { createBuiltinFixture, cleanupProjectPreStartAdmissionFixtures } from "../tests/codex-goal-project-pre-start-admission-fixture";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";

const roots: string[] = [];
afterEach(async () => { await cleanupProjectPreStartAdmissionFixtures(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await createBuiltinFixture();
  const manifest: CodexGoalJobManifest = { ...f.manifest, schemaVersion: 1, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" };
  return { contract: parseWorkerLaunchSpec(f.contract), state: parseWorkerLaunchState(f.state), manifest,
    receipt: { status: "validated_not_launched", validatorKind: "builtin" }, materialize: materializeBuiltinWorkerLaunchSpec };
}
async function artifactRoot() {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "TEST-mimo-admission-repair-"))); roots.push(base);
  const root = join(base, "job"), archiveRootDir = join(base, "archives");
  await mkdir(root); await mkdir(archiveRootDir); await mkdir(join(root, "pre-start-admission"));
  const old = Buffer.from('{"old":true}\n');
  for (const name of ["contract", "state", "receipt"]) await writeFile(join(root, "pre-start-admission", name + ".json"), old);
  return { root, old, archiveRootDir };
}
const operationSha256 = "a".repeat(64);
describe("never-started admission ownedPaths repair", () => {
  it("accepts a collected admission-denied Start only with empty process ownership and no queued job", () => {
    const unit = "owned-start.service", description = "owned description";
    const collected = { Id: unit, LoadState: "not-found", MainPID: "0", ControlGroup: "", Description: unit };
    expect(() => assertPreviousAdmissionDeniedStartTerminal(collected, unit, description, [])).not.toThrow();
    const loaded = { ...collected, LoadState: "loaded", ActiveState: "failed", Description: description };
    expect(() => assertPreviousAdmissionDeniedStartTerminal(loaded, unit, description, [])).not.toThrow();
    for (const state of [collected, loaded]) {
      expect(() => assertPreviousAdmissionDeniedStartTerminal(state, unit, description, [unit])).toThrow("previous_start_queued");
      for (const drift of [{ LoadState: "unknown" }, { Id: "other.service" }, { MainPID: "42" }, { ControlGroup: "/populated" }])
        expect(() => assertPreviousAdmissionDeniedStartTerminal({ ...state, ...drift }, unit, description, [])).toThrow("previous_start_not_terminal");
    }
    expect(() => assertPreviousAdmissionDeniedStartTerminal({ ...loaded, Description: "other" }, unit, description, [])).toThrow("previous_start_not_terminal");
    expect(() => assertPreviousAdmissionDeniedStartTerminal({ ...loaded, ActiveState: "activating" }, unit, description, [])).toThrow("previous_start_not_terminal");
  });
  it("rebinds canonical ownership work key and preserves every other contract/state field", async () => {
    const input = await fixture(), ownedPaths = ["src/WindowsNativeRunControl.hpp", "src/.task-reports/windows-run-control/"];
    const result = buildRepairedAdmission({ ...input, ownedPaths });
    const fields = ["kind", "format", "phaseId", "laneId", "baseSha", "phaseStartSha", "packetRevision", "inputPatchHash", "reviewKind", "ownedPaths", "revision", "merge"];
    const workKey = createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.map(field => [field, result.contract[field as keyof typeof result.contract]])))).digest("hex");
    expect(result.contract).toEqual({ ...input.contract, ownedPaths, workKey });
    expect(result.state).toEqual({ ...input.state, records: [{ ...input.state.records[0], workKey }] });
    expect(result.contract.workKey).not.toBe(input.contract.workKey);
  });
  it("rejects authorized history and path traversal before any publication", async () => {
    const input = await fixture();
    expect(() => buildRepairedAdmission({ ...input, ownedPaths: ["src/allowed.ts"], receipt: { status: "launch_authorized" } })).toThrow("never_authorized_required");
    for (const ownedPaths of [["../authority"], ["/etc/authority"], ["src/a", "src/a"]])
      expect(() => buildRepairedAdmission({ ...input, ownedPaths })).toThrow();
  });
  it("rejects a cold never-started/CAS failure without rewriting any artifact", async () => {
    const input = await fixture(), { root, old, archiveRootDir } = await artifactRoot();
    let exchanged = false;
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, archiveRootDir, operationSha256,
      assertCurrent: async () => { throw new Error("never_started_required"); }, exchange: () => { exchanged = true; } })).rejects.toThrow("never_started_required");
    expect(exchanged).toBe(false);
    for (const name of ["contract", "state", "receipt"]) expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
  });
  it("rechecks CAS after staging and retains exact old admission on drift", async () => {
    const input = await fixture(), { root, old, archiveRootDir } = await artifactRoot(); let checks = 0, exchanged = false;
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, archiveRootDir, operationSha256,
      assertCurrent: async () => { if (++checks === 2) throw new Error("admission_changed"); }, exchange: () => { exchanged = true; } })).rejects.toThrow("admission_changed");
    expect(checks).toBe(2); expect(exchanged).toBe(false);
    for (const name of ["contract", "state", "receipt"]) expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
    // A retained uncertain stage cannot be silently adopted on retry.
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, archiveRootDir, operationSha256,
      assertCurrent: async () => {}, exchange: () => {} })).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("retains the original triple and staged evidence when the exchange fails", async () => {
    const input = await fixture(), { root, old, archiveRootDir } = await artifactRoot();
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, archiveRootDir, operationSha256,
      assertCurrent: async () => {}, exchange: () => { throw new Error("exchange_failed"); } })).rejects.toThrow("exchange_failed");
    for (const name of ["contract", "state", "receipt"] as const) {
      expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
      expect(JSON.parse((await readFile(join(archiveRootDir, "job." + operationSha256, name + ".json"))).toString())).toEqual(input[name]);
    }
  });
  it("rejects an unreadable-size candidate before exchange or stage writes", async () => {
    const input = await fixture(), { root, old, archiveRootDir } = await artifactRoot();
    await expect(publishRepairedAdmission({ ...input, receipt: { status: "validated_not_launched", audit: "x".repeat(65536) },
      jobRootDir: root, archiveRootDir, operationSha256, assertCurrent: async () => {}, exchange: () => {} })).rejects.toThrow("artifact_size_limit");
    expect(await readFile(join(root, "pre-start-admission/receipt.json"))).toEqual(old);
  });
  it.runIf(process.platform === "linux")("exchanges a complete triple atomically and retains the exact previous triple", async () => {
    const input = await fixture(), { root, old, archiveRootDir } = await artifactRoot();
    const result = await publishRepairedAdmission({ ...input, jobRootDir: root, archiveRootDir, operationSha256,
      assertCurrent: async () => {}, exchange: exchangeAdmissionDirectories });
    for (const name of ["contract", "state", "receipt"] as const) {
      expect(JSON.parse((await readFile(join(root, "pre-start-admission", name + ".json"))).toString())).toEqual(input[name]);
      expect(await readFile(join(result.retainedPreviousAdmissionPath, name + ".json"))).toEqual(old);
    }
    expect(createHash("sha256").update(await readFile(join(root, "pre-start-admission/receipt.json"))).digest("hex")).toBe(result.receiptSha256);
    expect(await readdir(root)).toEqual(["pre-start-admission"]);
  });
  it("finalizes only the retained triple, preserves admission, and rejects drift before relocation", async () => {
    const { root, old, archiveRootDir } = await artifactRoot(), source = join(root, ".admission-repair-" + operationSha256), destination = join(archiveRootDir, "job." + operationSha256);
    await mkdir(source); for (const name of ["contract", "state", "receipt"]) await writeFile(join(source, name + ".json"), old);
    const priorHashes = { contract: operationSha256, state: operationSha256, receipt: operationSha256 };
    let checks = 0;
    await expect(finalizeRetainedAdmissionArchive({ source, destination, priorPlanSha256: operationSha256, priorHashes,
      assertCurrent: async () => { if (++checks === 2) throw new Error("first_effect_or_archive_changed"); }, move: () => {} })).rejects.toThrow("first_effect_or_archive_changed");
    expect(await readdir(root)).toContain(".admission-repair-" + operationSha256);
    await finalizeRetainedAdmissionArchive({ source, destination, priorPlanSha256: operationSha256, priorHashes,
      assertCurrent: async () => {}, move: (from, to) => { /* Same local atomic rename, no production host effect. */ renameSync(from, to); } });
    expect(await readdir(root)).toEqual(["pre-start-admission"]);
    for (const name of ["contract", "state", "receipt"]) {
      expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
      expect(await readFile(join(destination, name + ".json"))).toEqual(old);
    }
  });
  it("rejects operator plans that request authority/runtime overrides", () => {
    const plan = { schemaVersion: 1, projectId: "project", workstreamId: "stream", machineId: "b".repeat(32), jobId: "worker",
      expectedBindingSha256: operationSha256, expectedControllerManifestSha256: operationSha256, expectedManifestSha256: operationSha256,
      expectedContractSha256: operationSha256, expectedStateSha256: operationSha256, expectedReceiptSha256: operationSha256, ownedPaths: ["src/safe/"] };
    expect(parseRepairPlan(plan)).toEqual(plan);
    expect(() => parseRepairPlan({ ...plan, runtimeDirectory: "/untrusted" })).toThrow("plan_shape");
    for (const ownedPaths of [["../authority"], ["/etc/authority"], ["src/a\u0000b"], ["src/a", "src/a"]])
      expect(() => parseRepairPlan({ ...plan, ownedPaths })).toThrow();
  });
  it.runIf(process.platform === "linux")("relocates a retained directory atomically and refuses an existing destination", async () => {
    const { root, old, archiveRootDir } = await artifactRoot(), source = join(root, ".admission-repair-" + operationSha256), destination = join(archiveRootDir, "job." + operationSha256);
    await mkdir(source); await writeFile(join(source, "receipt.json"), old); await mkdir(destination);
    expect(() => relocateAdmissionArchive(source, destination)).toThrow();
    expect(await readFile(join(source, "receipt.json"))).toEqual(old);
    await rm(destination, { recursive: true }); relocateAdmissionArchive(source, destination);
    expect(await readdir(root)).toEqual(["pre-start-admission"]);
    expect(await readFile(join(destination, "receipt.json"))).toEqual(old);
  });
  it("accepts the finalizer proof only while binding, birth, directory and both first-effect pins remain unchanged", () => {
    const identity = { schemaVersion: 1 as const, machineId: "m", projectId: "p", workstreamId: "w", jobId: "j" };
    const previousStart = { ownerSha256: "o", requestSha256: "q", resultSha256: "r" };
    const bytes = Buffer.from("original"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = { path: "/job", device: 1, inode: 2 };
    const births = ["lexical", "physical"].map(name => ({ path: "/" + name, sha256, firstEffectPath: "/" + name + ".effect" }));
    const proof = { ...identity, previousStart: { ...previousStart, terminalVerified: true }, bindings: [{ path: "/prompt", sha256, witness: "same" }],
      directories: [directory], birthWitnesses: [0, 1].map(() => ({ directory, births })) };
    const ports = { readBytes: () => bytes, witness: () => "same", directoryIdentity: () => directory, absent: () => true };
    expect(() => verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, ports)).not.toThrow();
    for (const marker of ["/lexical.effect", "/physical.effect"])
      expect(() => verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, { ...ports, absent: path => path !== marker })).toThrow("rearm_first_effect_or_birth_changed");
    expect(() => verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, { ...ports, readBytes: path => path === "/prompt" ? Buffer.from("drift") : bytes })).toThrow("rearm_binding_changed");
    expect(() => verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, { ...ports, readBytes: path => path === "/physical" ? Buffer.from("drift") : bytes })).toThrow("rearm_first_effect_or_birth_changed");
    expect(() => verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, { ...ports, directoryIdentity: () => ({ ...directory, inode: 3 }) })).toThrow("rearm_directory_changed");
  });
});
