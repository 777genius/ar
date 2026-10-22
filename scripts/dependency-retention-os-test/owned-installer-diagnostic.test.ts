import assert from "node:assert/strict";
import { test } from "node:test";
import { closedInstallerUnitStates, correlateSyntheticInstallerRecords } from "./owned-installer-diagnostic.ts";
const id = "11111111-2222-3333-4444-555555555555", installerId = "22222222-2222-3333-4444-555555555555";
const attemptId = "33333333-2222-3333-4444-555555555555", profileSha = "c".repeat(64);
const parent = { startId: id, unit: `subscription-runtime-ordinary-${id}.service`, installationId: id, bootId: installerId,
  runtimeSha: "a".repeat(40), grantSha256: "b".repeat(64), workspacePath: "/TEST/workspace", workspaceDev: "7", workspaceIno: "8" };
// Preserve the actual V1 claim producer's field order, rather than parser order.
const attempt = { attemptId, epoch: 1, launch: { installationId: parent.installationId, bootId: parent.bootId,
  runtimeSha: parent.runtimeSha, grantDigest: parent.grantSha256, startId: id, unit: parent.unit } };
const mapping = { schemaVersion: 1, startId: installerId, unit: `subscription-runtime-installer-${installerId}.service`, attempt };
const start = { schemaVersion: 1, startId: installerId, unit: mapping.unit, recipe: "npm_registry_no_scripts_v1",
  workspace: { canonicalPath: parent.workspacePath, dev: parent.workspaceDev, ino: parent.workspaceIno }, attempt,
  inputSha256: "d".repeat(64), profileSha256: profileSha };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
test("only immutable installer records joined to the exact ordinary parent select a unit", () => {
  assert.deepEqual(correlateSyntheticInstallerRecords(attemptId, bytes(mapping), bytes(start), parent, profileSha),
    { startId: installerId, unit: mapping.unit });
  for (const patch of [{ startId: installerId }, { unit: mapping.unit }, { installationId: installerId }, { bootId: id },
    { runtimeSha: "e".repeat(40) }, { grantSha256: "e".repeat(64) }, { workspacePath: "/PRIVATE_CANARY" }, { workspaceDev: "9" }, { workspaceIno: "9" }]) {
    const result = correlateSyntheticInstallerRecords(attemptId, bytes(mapping), bytes(start), { ...parent, ...patch }, profileSha);
    assert.equal(result, undefined); assert(!JSON.stringify({ result }).includes("PRIVATE_CANARY"));
  }
  for (const patch of [{ unit: "PRIVATE_CANARY" }, { schemaVersion: 2 }, { private: "PRIVATE_CANARY" }])
    assert.equal(correlateSyntheticInstallerRecords(attemptId, bytes({ ...mapping, ...patch }), bytes(start), parent, profileSha), undefined);
  for (const patch of [{ unit: "PRIVATE_CANARY" }, { schemaVersion: 2 }, { private: "PRIVATE_CANARY" },
    { inputSha256: "PRIVATE_CANARY" }, { recipe: "PRIVATE_CANARY" }, { attempt: { ...attempt, epoch: 2 } }, { profileSha256: "e".repeat(64) }])
    assert.equal(correlateSyntheticInstallerRecords(attemptId, bytes(mapping), bytes({ ...start, ...patch }), parent, profileSha), undefined);
  assert.equal(correlateSyntheticInstallerRecords(id, bytes(mapping), bytes(start), parent, profileSha), undefined);
  assert.equal(correlateSyntheticInstallerRecords(attemptId, Buffer.from('{"private":"PRIVATE_CANARY"}\n'), bytes(start), parent, profileSha), undefined);
  assert.equal(correlateSyntheticInstallerRecords(attemptId, Buffer.from(bytes(mapping).toString().replace('"schemaVersion":', '"schemaVersion":0,"schemaVersion":')), bytes(start), parent, profileSha), undefined);
});
test("installer unit evidence retains only closed status values and numeric exit facts", () => {
  const result = closedInstallerUnitStates(`Id=${mapping.unit}\nResult=exit-code\nLoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=226\n`, mapping.unit);
  assert.deepEqual(result, { Result: "exit-code", LoadState: "loaded", ActiveState: "failed", SubState: "failed", ExecMainCode: "1", ExecMainStatus: "226" });
  const refused = closedInstallerUnitStates(`Id=${mapping.unit}\nPRIVATE_CANARY=loaded\nResult=PRIVATE_CANARY\nExecMainStatus=PRIVATE_CANARY\nSubState=PRIVATE_CANARY\n__proto__=PRIVATE_CANARY\ntoString=PRIVATE_CANARY\n`, mapping.unit);
  for (const text of ["Result=success\n", `Id=PRIVATE_CANARY\nResult=success\n`, `Id=${mapping.unit}\nId=${mapping.unit}\nResult=success\n`])
    assert.deepEqual(closedInstallerUnitStates(text, mapping.unit), {});
  assert.deepEqual(refused, {}); assert(!JSON.stringify(refused).includes("PRIVATE_CANARY"));
});
