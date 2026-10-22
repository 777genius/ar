import { describe, expect, it } from "vitest";
import { copyBoundedHostedByteInput } from "../hosted-bounded-byte-input";
import { captureManagedSessionArtifactFacts, captureManagedSessionMaterializationInput } from "../hosted-managed-dependency-session-artifact-facts";
import { DefaultRedactor, type SessionArtifact } from "@vioxen/subscription-runtime/core";
const artifact = ():SessionArtifact => ({kind:"json-file",providerId:"codex",formatVersion:"test",contentType:"application/json",bytes:new TextEncoder().encode("{}")});
// Red if an alternating getter or later caller byte mutation changes admitted auth data after its captured hash.
describe("captured managed session artifact facts", () => {
  it("rejects accessor/prototype artifacts without invoking an accessor", () => {
    let reads = 0; const value = artifact(); Object.defineProperty(value,"bytes",{get() { reads++; return new Uint8Array([1]); }});
    expect(() => captureManagedSessionArtifactFacts(value)).toThrow(); expect(reads).toBe(0);
    expect(() => captureManagedSessionArtifactFacts(Object.assign(Object.create({}),artifact()))).toThrow();
  });
  it("owns a stable byte snapshot and detects a later different artifact hash", () => {
    const value = artifact(), before = captureManagedSessionArtifactFacts(value); value.bytes[0] = 0;
    expect(new TextDecoder().decode(before.artifact.bytes)).toBe("{}");
    expect(captureManagedSessionArtifactFacts(value).hash).not.toBe(before.hash);
  });
});

// Red if caller-visible length/iterator/species is consulted before the true bytes are bounded/copied.
describe("intrinsic managed byte capture", () => {
  it("copies genuine view bytes without invoking overridden iterator or storage getters", () => {
    let calls = 0; const bytes = new Uint8Array([7,8]);
    for (const name of ["byteLength","byteOffset","buffer",Symbol.iterator]) Object.defineProperty(bytes,name,{get() { calls++; throw new Error("caller getter"); }});
    const value = {...artifact(),bytes};
    expect(Array.from(captureManagedSessionArtifactFacts(value).artifact.bytes)).toEqual([7,8]); expect(calls).toBe(0);
  });
  it("rejects true oversized storage view and remaining queue budget before iterator invocation", () => {
    let calls = 0; const bytes = new Uint8Array(1024*1024+1);
    Object.defineProperty(bytes,"byteLength",{value:1}); Object.defineProperty(bytes,Symbol.iterator,{value:() => { calls++; throw new Error("iterator must not run"); }});
    const value = {...artifact(),bytes}; expect(() => captureManagedSessionArtifactFacts(value)).toThrow();
    expect(() => copyBoundedHostedByteInput(bytes,1)).toThrow(); expect(calls).toBe(0);
  });
  it("copies bounded offset bytes independently without custom species", () => {
    let calls = 0;
    class Bytes extends Uint8Array { static get [Symbol.species]() { calls++; return Uint8Array; } }
    const original = new Bytes([1,2,3]), view = new Uint8Array(original.buffer,1,2), captured = copyBoundedHostedByteInput(view,2);
    original[1] = 9; expect(Array.from(captured)).toEqual([2,3]);
    expect(Array.from(copyBoundedHostedByteInput(original,3))).toEqual([1,9,3]); expect(calls).toBe(0);
    expect(() => copyBoundedHostedByteInput(view,1)).toThrow();
  });
  it("rejects proxy, shared, resizable and detached storage without caller traps", () => {
    let traps = 0; const proxy = new Proxy(new Uint8Array([1]),{get() { traps++; throw new Error("proxy get"); }});
    expect(() => copyBoundedHostedByteInput(proxy,1)).toThrow(); expect(traps).toBe(0);
    expect(() => copyBoundedHostedByteInput(new Uint8Array(new SharedArrayBuffer(1)),1)).toThrow();
    const resizable:ArrayBuffer = Reflect.construct(ArrayBuffer,[1,{maxByteLength:2}]);
    expect(() => copyBoundedHostedByteInput(new Uint8Array(resizable),1)).toThrow();
    const buffer = new ArrayBuffer(1), detached = new Uint8Array(buffer); structuredClone(buffer,{transfer:[buffer]});
    expect(() => copyBoundedHostedByteInput(detached,1,1)).toThrow();
  });
  it("rejects request and artifact proxies/accessors before callback reentry", () => {
    let calls = 0; const value = artifact(); const proxy = new Proxy(value,{getPrototypeOf() { calls++; return Object.prototype; }});
    expect(() => captureManagedSessionArtifactFacts(proxy)).toThrow();
    const input = {session:value,redactor:new DefaultRedactor()};
    Object.defineProperty(input,"sessionExecutionUse",{get() { calls++; throw new Error("reentry"); }});
    expect(() => captureManagedSessionMaterializationInput(input)).toThrow(); expect(calls).toBe(0);
  });
});
