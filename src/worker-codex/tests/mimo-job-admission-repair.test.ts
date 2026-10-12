import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepairedAdmission, exchangeAdmissionDirectories, parseRepairPlan, publishRepairedAdmission } from "../../../host-integration/runtime-admission/mimo-job-admission-repair.mjs";
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
  const root = await mkdtemp(join(tmpdir(), "TEST-mimo-admission-repair-")); roots.push(root);
  await mkdir(join(root, "pre-start-admission"));
  const old = Buffer.from('{"old":true}\n');
  for (const name of ["contract", "state", "receipt"]) await writeFile(join(root, "pre-start-admission", name + ".json"), old);
  return { root, old };
}
const operationSha256 = "a".repeat(64);
describe("never-started admission ownedPaths repair", () => {
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
    const input = await fixture(), { root, old } = await artifactRoot();
    let exchanged = false;
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, operationSha256,
      assertCurrent: async () => { throw new Error("never_started_required"); }, exchange: () => { exchanged = true; } })).rejects.toThrow("never_started_required");
    expect(exchanged).toBe(false);
    for (const name of ["contract", "state", "receipt"]) expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
  });
  it("rechecks CAS after staging and retains exact old admission on drift", async () => {
    const input = await fixture(), { root, old } = await artifactRoot(); let checks = 0, exchanged = false;
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, operationSha256,
      assertCurrent: async () => { if (++checks === 2) throw new Error("admission_changed"); }, exchange: () => { exchanged = true; } })).rejects.toThrow("admission_changed");
    expect(checks).toBe(2); expect(exchanged).toBe(false);
    for (const name of ["contract", "state", "receipt"]) expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
    // A retained uncertain stage cannot be silently adopted on retry.
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, operationSha256,
      assertCurrent: async () => {}, exchange: () => {} })).rejects.toMatchObject({ code: "EEXIST" });
  });
  it("retains the original triple and staged evidence when the exchange fails", async () => {
    const input = await fixture(), { root, old } = await artifactRoot();
    await expect(publishRepairedAdmission({ ...input, jobRootDir: root, operationSha256,
      assertCurrent: async () => {}, exchange: () => { throw new Error("exchange_failed"); } })).rejects.toThrow("exchange_failed");
    for (const name of ["contract", "state", "receipt"] as const) {
      expect(await readFile(join(root, "pre-start-admission", name + ".json"))).toEqual(old);
      expect(JSON.parse((await readFile(join(root, ".admission-repair-" + operationSha256, name + ".json"))).toString())).toEqual(input[name]);
    }
  });
  it("rejects an unreadable-size candidate before exchange or stage writes", async () => {
    const input = await fixture(), { root, old } = await artifactRoot();
    await expect(publishRepairedAdmission({ ...input, receipt: { status: "validated_not_launched", audit: "x".repeat(65536) },
      jobRootDir: root, operationSha256, assertCurrent: async () => {}, exchange: () => {} })).rejects.toThrow("artifact_size_limit");
    expect(await readFile(join(root, "pre-start-admission/receipt.json"))).toEqual(old);
  });
  it.runIf(process.platform === "linux")("exchanges a complete triple atomically and retains the exact previous triple", async () => {
    const input = await fixture(), { root, old } = await artifactRoot();
    const result = await publishRepairedAdmission({ ...input, jobRootDir: root, operationSha256,
      assertCurrent: async () => {}, exchange: exchangeAdmissionDirectories });
    for (const name of ["contract", "state", "receipt"] as const) {
      expect(JSON.parse((await readFile(join(root, "pre-start-admission", name + ".json"))).toString())).toEqual(input[name]);
      expect(await readFile(join(result.retainedPreviousAdmissionPath, name + ".json"))).toEqual(old);
    }
    expect(createHash("sha256").update(await readFile(join(root, "pre-start-admission/receipt.json"))).digest("hex")).toBe(result.receiptSha256);
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
});
