import { describe, expect, it } from "vitest";
import { DependencyConsumerLaunchKind } from "../../core/dependency-environment/dependency-custody-evidence";
import { assertHostedManagedProviderFailureCreator, parseHostedManagedProviderFailureReceipt } from "../hosted-managed-provider-failure-recovery";
import { HostedManagedProviderResult, HostedManagedProviderWaitKind } from "../hosted-managed-provider-terminal-facts";

const root = "/var/lib/subscription-runtime-host-policy";
const parent = "00000000-0000-4000-8000-000000000001", provider = "00000000-0000-4000-8000-000000000002";
const unit = `subscription-runtime-hosted-${provider}.service`, invocationId = "a".repeat(32);
const reference = (path: string) => ({path,identity:{dev:"1",ino:"42"},sha256:"b".repeat(64)});
const attempt = {attemptId:"00000000-0000-4000-8000-000000000003",epoch:3,launch:{
  installationId:parent,bootId:parent,runtimeSha:"c".repeat(40),grantDigest:"d".repeat(64),startId:parent,
  unit:`subscription-runtime-outer-${parent}.service`,kind:DependencyConsumerLaunchKind.ManagedReadonlyLocalV1,
  association:reference(root+"/readonly-dependency-bindings/1-42.json"),origin:reference(root+`/readonly-dependency-starts/${parent}.json`)}};
const receipt = (kind = HostedManagedProviderWaitKind.Exited,status = 143,waitStatus = status) => ({
  schemaVersion:1,parentAttempt:attempt,unit,providerStartId:provider,providerReference:reference(root+`/dependency-managed-provider-starts/${provider}.json`),
  invocationId,proxyBirth:"123:456",waitStatus,terminal:{unit,invocationId,kind,status,
    result:kind === HostedManagedProviderWaitKind.Killed ? HostedManagedProviderResult.Signal : HostedManagedProviderResult.ExitCode}});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value)+"\n");

// Red if captured failed wait143/exit1 is confused with signal255, if absent or
// foreign terminal facts become proof, or a copied held:true can reach file IO.
// These are DATA codec positives, not genuine producer/native qualification.
describe("captured managed provider failure receipt", () => {
  it("preserves exact failed exit and distinct signal exception255", () => {
    for (const value of [receipt(),receipt(HostedManagedProviderWaitKind.Exited,1),receipt(HostedManagedProviderWaitKind.Killed,15,255)]) {
      const parsed = parseHostedManagedProviderFailureReceipt(bytes(value));
      expect(parsed.waitStatus).toBe(value.waitStatus);
      expect(parsed.terminal).toEqual(value.terminal);
      expect(parsed.parentAttempt).toEqual(attempt);
    }
    expect(() => parseHostedManagedProviderFailureReceipt(bytes(receipt(HostedManagedProviderWaitKind.Killed,15,143)))).toThrow();
  });
  it("refuses missing, forged, foreign and ordinary completion claims", () => {
    const value = receipt();
    for (const changed of [{waitStatus:0},{waitStatus:256},{waitStatus:1.5},{waitStatus:"143"},
      {terminal:null},{terminal:{...value.terminal,status:1}},{terminal:{...value.terminal,invocationId:"e".repeat(32)}},
      {terminal:{...value.terminal,unit:`subscription-runtime-hosted-${parent}.service`}},
      {terminal:{...value.terminal,kind:3}},{terminal:{...value.terminal,result:HostedManagedProviderResult.Success}},
      {unit:`subscription-runtime-outer-${provider}.service`},{providerStartId:provider+"\n"},{proxyBirth:"123:456\n"},
      {providerReference:reference(root+`/dependency-managed-provider-starts/${parent}.json`)},
      {parentAttempt:{...attempt,epoch:0}},{generation:7},{waitCompleted:true},{approved:true}]) {
      expect(() => parseHostedManagedProviderFailureReceipt(bytes({...value,...changed}))).toThrow();
    }
    expect(() => parseHostedManagedProviderFailureReceipt(bytes({schemaVersion:1,startId:provider,unit,creatorId:provider,waitCompleted:true,waitStatus:0}))).toThrow();
  });
  it("refuses malformed UTF8, noncanonical bytes and the fixed byte cap", () => {
    const value = bytes(receipt());
    for (const malformed of [Buffer.from([0xff]),Buffer.concat([value,Buffer.from("\n")]),
      Buffer.from(JSON.stringify(receipt())),Buffer.alloc(16385,32)]) {
      expect(() => parseHostedManagedProviderFailureReceipt(malformed)).toThrow();
    }
  });
  it("rejects a copied fence before the fixed reader can open an absent predecessor", () => {
    // The genuine WeakSet fence check runs first. No assertion/FS/classifier is
    // mocked, and a nonexistent policy namespace cannot turn this into ENOENT.
    expect(() => assertHostedManagedProviderFailureCreator(Object.freeze({held:true}),provider)).toThrow("hosted_custody_common_fence_required");
  });
});
