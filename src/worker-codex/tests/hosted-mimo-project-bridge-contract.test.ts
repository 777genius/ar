import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { readMimoProjectIngress } from "../../hosted-native-probe/mimo-project-ingress";
import { routeProbeIngress } from "../../hosted-native-probe/ingress";
import { describe, expect, it } from "vitest";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
const base = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-stream",
  operation: MimoProjectBridgeOperation.Create, jobId: "test-job", prompt: "Edit the TEST workspace", sourceCommit: "b".repeat(40) };
describe("finite root project MiMo bridge wire contract", () => {
  it.each([[true, "high"], [false, "none"]] as const)("normalizes thinking=%s to the retained reasoning effort", (thinking, reasoningEffort) => {
    const input = { ...base, thinking };
    const parsed = readMimoProjectIngress(Buffer.from(JSON.stringify(input)));
    expect(parsed).toEqual({ ...base, reasoningEffort });
    expect(parseMimoProjectBridgeRequest(parsed)).toEqual(parsed);
    expect(input).not.toHaveProperty("reasoningEffort");
  });
  it.each(["none", "minimal", "low", "medium", "high", "xhigh"] as const)("preserves legacy effort %s with semantically matching thinking", reasoningEffort => {
    expect(parseMimoProjectBridgeRequest({ ...base, reasoningEffort })).toEqual({ ...base, reasoningEffort });
    expect(parseMimoProjectBridgeRequest({ ...base, reasoningEffort, thinking: reasoningEffort !== "none" })).toEqual({ ...base, reasoningEffort });
  });
  it.each([{ thinking: true, reasoningEffort: "none" }, { thinking: false, reasoningEffort: "high" },
    { thinking: "true" }, { thinking: 1 }, { thinking: null }, { thinking: undefined },
    { thinking: true, reasoningEffort: "invalid" }])("refuses invalid or contradictory thinking %j", fields => {
    expect(() => parseMimoProjectBridgeRequest({ ...base, ...fields })).toThrow("mimo_project_bridge_request_invalid");
  });
  it.each([MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop,
    MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair])("never changes thinking through %s", operation => {
    const { prompt: _prompt, sourceCommit: _source, ...control } = base;
    expect(() => parseMimoProjectBridgeRequest({ ...control, operation, thinking: false })).toThrow("mimo_project_bridge_request_invalid");
  });
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

it("bounds and snapshots Create ownership without changing legacy thinking normalization", () => {
  const ownedPaths = ["src/feature/one.ts", "src/feature/nested/"];
  const parsed = parseMimoProjectBridgeRequest({ ...base, thinking: true, ownedPaths });
  ownedPaths.push("src/later.ts");
  expect(parsed.ownedPaths).toEqual(["src/feature/one.ts", "src/feature/nested/"]);
  expect(Object.isFrozen(parsed.ownedPaths)).toBe(true);
  expect(parsed.reasoningEffort).toBe("high");
  for (const paths of [[], ["x", "x"], ["../x"], ["/x"], ["x//y"], ["x/./y"],
    ["x/*"], ["x/?"], ["x/[ab]"], ["x/\\y"], ["x\0y"], ["x".repeat(4097)],
    Array.from({ length: 257 }, (_, i) => `src/${i}.ts`), Array.from({ length: 20 }, (_, i) => `${i}${"x".repeat(3000)}`)])
    expect(() => parseMimoProjectBridgeRequest({ ...base, ownedPaths: paths })).toThrow("request_invalid");
  const { prompt: _prompt, sourceCommit: _source, ...control } = base;
  for (const operation of [MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop,
    MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair])
    expect(() => parseMimoProjectBridgeRequest({ ...control, operation, ownedPaths: ["src/x"] })).toThrow("request_invalid");
});

it("rejects a combined prompt and ownership request exceeding the fixed ingress budget", () => {
  expect(() => parseMimoProjectBridgeRequest({ ...base, prompt: "x".repeat(32768),
    ownedPaths: Array.from({ length: 12 }, (_, i) => `${i}${"x".repeat(3000)}`) })).toThrow("request_invalid");
});

it("loads the actual isolated emitted MiMo ingress without worker packages or Zod", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-mimo-isolated-ingress-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const leaves = ["hosted-native-probe/mimo-project-ingress", "worker-codex/hosted-mimo-project-bridge-contract",
      "worker-codex/application/project-control/worker-launch-ownership"];
    for (const leaf of leaves) {
      const source = readFileSync(new URL(`../../${leaf}.ts`, import.meta.url), "utf8");
      const emitted = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
      const target = join(directory, leaf + ".js"); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, emitted);
    }
    const script = `
      import { readMimoProjectIngress } from ${JSON.stringify(pathToFileURL(join(directory, leaves[0] + ".js")).href)};
      const base = ${JSON.stringify(base)};
      const read = value => readMimoProjectIngress(Buffer.from(JSON.stringify(value)));
      const accepted = read({ ...base, thinking: true, ownedPaths: ["src/feature/one.ts", "src/feature/nested/"] });
      if (accepted.reasoningEffort !== "high" || accepted.ownedPaths.length !== 2) throw new Error("isolated Create mismatch");
      const { prompt, sourceCommit, ...control } = base;
      for (const value of [{ ...base, ownedPaths: ["../escape"] }, { ...control, operation: "start", ownedPaths: ["src/x"] }]) {
        let rejected = false;
        try { read(value); } catch (error) { if (error.message !== "mimo_project_bridge_request_invalid") throw error; rejected = true; }
        if (!rejected) throw new Error("isolated request not rejected");
      }
      console.log("isolated ingress PASS");
    `;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, encoding: "utf8", timeout: 10000 })).toBe("isolated ingress PASS\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
