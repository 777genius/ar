import { readMimoProjectIngress } from "../../hosted-native-probe/mimo-project-ingress";
import { routeProbeIngress } from "../../hosted-native-probe/ingress";
import { describe, expect, it } from "vitest";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
const base = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-stream",
  operation: MimoProjectBridgeOperation.Create, jobId: "test-job", prompt: "Edit the TEST workspace", sourceCommit: "b".repeat(40) };
describe("finite root project MiMo bridge wire contract", () => {
  it("admits finite create data and control-only same-job requests", () => {
    expect(parseMimoProjectBridgeRequest(base)).toEqual(base);
    const { prompt: _prompt, sourceCommit: _source, ...control } = base;
    for (const operation of [MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.FinalizeAdmissionRepair])
      expect(parseMimoProjectBridgeRequest({ ...control, operation })).toMatchObject({ operation, jobId: base.jobId });
  });
  it.each([{ argv: ["/bin/sh"] }, { env: { TEST: "override" } }, { registryRootDir: "/etc" }, { controllerJobId: "other" },
    { workspacePath: "/srv/foreign" }, { authRootDir: "/root" }, { projectId: "../foreign" }, { workstreamId: "a/b" },
    { jobId: "../job" }, { machineId: "unknown" }, { sourceCommit: "main" }, { operation: "exec" },
    { prompt: "x".repeat(32769) }])("refuses caller authority or unbounded data %j", fields => {
    expect(() => parseMimoProjectBridgeRequest({ ...base, ...fields })).toThrow("mimo_project_bridge_request_invalid");
  });
  it("rejects mutation fields on a status request", () => {
    expect(() => parseMimoProjectBridgeRequest({ ...base, operation: MimoProjectBridgeOperation.Status })).toThrow();
  });
  it("accepts only identity data for the fixed repair finalizer", () => {
    const { prompt: _prompt, sourceCommit: _commit, ...identity } = base;
    const finalizer = { ...identity, operation: MimoProjectBridgeOperation.FinalizeAdmissionRepair };
    expect(readMimoProjectIngress(Buffer.from(JSON.stringify(finalizer)))).toEqual(finalizer);
    for (const fields of [{ repairPlan: {} }, { runtimeDirectory: "/opt/foreign" }, { planPath: "/etc/foreign" }, { archivePath: "/srv/foreign" },
      { artifactSha256: "a".repeat(64) }, { argv: ["/bin/sh"] }, { prompt: "TEST" }, { reasoningEffort: "none" }])
      expect(() => parseMimoProjectBridgeRequest({ ...finalizer, ...fields })).toThrow("mimo_project_bridge_request_invalid");
  });
  it("admits only an exact same-job bounded repair plan and snapshots its paths", () => {
    const { prompt: _prompt, sourceCommit: _commit, ...identity } = base;
    const repairPlan = { schemaVersion: 1, machineId: base.machineId, projectId: base.projectId, workstreamId: base.workstreamId, jobId: base.jobId,
      expectedBindingSha256: "c".repeat(64), expectedControllerManifestSha256: "d".repeat(64), expectedManifestSha256: "e".repeat(64),
      expectedContractSha256: "f".repeat(64), expectedStateSha256: "0".repeat(64), expectedReceiptSha256: "1".repeat(64), ownedPaths: ["src/WindowsNativeRunControl.hpp", "src/.task-reports/windows-run-control/"] };
    const repair = { ...identity, operation: MimoProjectBridgeOperation.RepairAdmission, repairPlan };
    expect(readMimoProjectIngress(Buffer.from(JSON.stringify(repair)))).toEqual(repair);
    const parsed = parseMimoProjectBridgeRequest(repair);
    repairPlan.ownedPaths.push("TEST changed caller path");
    expect(parsed.repairPlan?.ownedPaths).toHaveLength(2);
    for (const fields of [{ projectId: "other" }, { workstreamId: "other" }, { jobId: "other" }, { machineId: "f".repeat(32) },
      { expectedBindingSha256: "main" }, { ownedPaths: [] }, { ownedPaths: ["x\0y"] }, { runtimeDirectory: "/opt/foreign" }, { planPath: "/etc/foreign" }])
      expect(() => parseMimoProjectBridgeRequest({ ...repair, repairPlan: { ...repairPlan, ...fields } })).toThrow("mimo_project_bridge_request_invalid");
    expect(() => parseMimoProjectBridgeRequest({ ...repair, argv: ["/bin/sh"] })).toThrow("mimo_project_bridge_request_invalid");
    expect(() => parseMimoProjectBridgeRequest({ ...repair, operation: MimoProjectBridgeOperation.Status })).toThrow("mimo_project_bridge_request_invalid");
  });
});

describe("actual restricted ingress MiMo kind routing", () => {
  it("routes compact MiMo bytes before the NativeProbe reserved-kind reader", () => {
    const bytes = Buffer.from(JSON.stringify(base));
    expect(readMimoProjectIngress(bytes)).toEqual(base);
    expect(() => routeProbeIngress(bytes)).toThrow();
  });
  it.each([
    '{"kind":"NativeProbe","kind":"MimoProject"}',
    '{"kind":"MimoProject","kind":"NativeProbe"}',
    '{"\\u006bind":"NativeProbe","operation":"start"}',
    '{"kind":"MimoProject","allocationDigest":"test"}',
  ])("never reroutes malformed reserved original bytes %s", text => {
    const bytes = Buffer.from(text);
    expect(() => { const mimo = readMimoProjectIngress(bytes); if (!mimo) routeProbeIngress(bytes); }).toThrow();
  });
});
