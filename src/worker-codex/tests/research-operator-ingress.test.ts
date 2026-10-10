import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupResearchFixture, host, local, request, setupResearchFixture } from "./research-launch-fixture";
import { grantResearchLaunch, revokeResearchLaunch, revokeEnrolledResearchLaunch, startEnrolledResearchLaunch } from "../research-launch-owner";
import { cancelEnrolledResearchLaunch } from "../research-launch-lifecycle";
import { researchHash, researchRead } from "../research-launch-files";
import { parseResearchOperatorRequestEnvelope, ResearchOperatorKind, ResearchOperatorOperation } from "../../core/research-operator-request";
import { readResearchOperatorIngress } from "../../hosted-native-probe/research-operator-ingress";
import { routeProbeIngress } from "../../hosted-native-probe/ingress";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const envelope = () => ({ kind: ResearchOperatorKind.OwnedResearch, schemaVersion: 1,
  machineId: "a".repeat(32), projectId: "test-project", jobId: "test-job",
  operation: ResearchOperatorOperation.Start, bindingSha256: "b".repeat(64) });
const grantPath = () => join("/run/user/subscription-runtime-research-v1", researchHash(request().jobId), "grant.json");

it.each(["command", "argv", "env", "requestPath", "model", "allocationDigest"])("rejects caller-selected %s authority", key => {
  expect(() => parseResearchOperatorRequestEnvelope({ ...envelope(), [key]: "untrusted" })).toThrow();
});
it("accepts compact closed data but rejects enrollment as a remote operation", () => {
  expect(readResearchOperatorIngress(Buffer.from(JSON.stringify(envelope())))).toEqual(envelope());
  expect(() => parseResearchOperatorRequestEnvelope({ ...envelope(), operation: "enroll" })).toThrow();
});
it("preserves duplicate and escaped reserved-key evidence before routing", () => {
  const wire = JSON.stringify(envelope());
  expect(() => readResearchOperatorIngress(Buffer.from(wire.replace('"kind":', '"kind":"NativeProbe","kind":')))).toThrow();
  expect(() => readResearchOperatorIngress(Buffer.from(wire.replace('"kind":', '"k\\u0069nd":')))).toThrow();
  const reversed = wire.replace('"kind":"ResearchOperator"', '"kind":"ResearchOperator","kind":"other"');
  expect(readResearchOperatorIngress(Buffer.from(reversed))).toBeNull();
  expect(() => routeProbeIngress(Buffer.from(reversed))).toThrow();
  expect(readResearchOperatorIngress(Buffer.from('{"operation":"status","jobId":"ordinary"}'))).toBeNull();
});
it("does not submit with a replaced enrolled grant", () => {
  const r = request(); grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  const original = researchHash(researchRead(grantPath()));
  grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  expect(() => startEnrolledResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")), original)).toThrow();
  expect(host.calls.some(call => call.command === "/usr/bin/systemd-run" || call.command === "/usr/bin/mount")).toBe(false);
  expect(host.authReads).toBe(0);
});
it("makes exact-grant revocation idempotent without revoking a successor", () => {
  const r = request(); grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  const original = researchHash(researchRead(grantPath()));
  revokeEnrolledResearchLaunch(r.jobId, original); revokeEnrolledResearchLaunch(r.jobId, original);
  expect(existsSync(local(grantPath()))).toBe(false);
  grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  expect(() => revokeEnrolledResearchLaunch(r.jobId, original)).toThrow();
  expect(existsSync(local(grantPath()))).toBe(true);
  expect(host.authReads).toBe(0);
});
it("revokes queued enrollment before any active service without creating work", () => {
  const r = request(); grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  const grant = researchHash(researchRead(grantPath())), input = researchHash(researchRead("/TEST-operator/request.json"));
  expect(cancelEnrolledResearchLaunch(r.jobId, grant, input)).toEqual({ jobId: r.jobId, revoked: true });
  expect(cancelEnrolledResearchLaunch(r.jobId, grant, input)).toEqual({ jobId: r.jobId, revoked: true });
  expect(host.calls.some(call => call.command === "/usr/bin/systemd-run" || call.command === "/usr/bin/mount")).toBe(false);
});
it("cannot cancel successor active ownership even after its grant was revoked", () => {
  const r = request(); grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  const oldGrant = researchHash(researchRead(grantPath())), input = researchHash(researchRead("/TEST-operator/request.json"));
  grantResearchLaunch(r.jobId, r.jobRootDir, r.workspacePath);
  const successor = startEnrolledResearchLaunch("/TEST-operator/request.json", input, researchHash(researchRead(grantPath())));
  revokeResearchLaunch(r.jobId);
  const calls = host.calls.length;
  expect(() => cancelEnrolledResearchLaunch(r.jobId, oldGrant, input)).toThrow();
  expect(host.calls.length).toBe(calls);
  expect(existsSync(local(join("/run/user/subscription-runtime-research-v1", researchHash(r.jobId), "active.json")))).toBe(true);
  expect(host.units.get(successor.unit)?.active).toBe(true);
});
