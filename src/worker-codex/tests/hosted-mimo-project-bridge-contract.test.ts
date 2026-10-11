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
    for (const operation of [MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop])
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
