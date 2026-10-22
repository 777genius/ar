import { describe, expect, it } from "vitest";
import { captureHostedDependencyWarmLeafRequest } from "../hosted-dependency-warm-leaf-request";
// Regressions: caller accessors must never run, request aliases cannot escape
// the authored scope, and a deferred write cannot observe later caller bytes.
describe("warm authored leaf request data",()=>{
  it("rejects accessors without invoking them",()=>{
    let calls=0;
    for(const field of ["relativePath","bytes"]) {
      const input=field==="relativePath"?{bytes:new Uint8Array([1])}:{relativePath:"packages/live/src/value.ts"};
      Object.defineProperty(input,field,{enumerable:true,get(){calls++;throw new Error("caller getter");}});
      expect(()=>captureHostedDependencyWarmLeafRequest(input)).toThrow("warm_leaf_unsupported");
    }
    expect(calls).toBe(0);
  });
  it("rejects a proxy without running a trap",()=>{
    let calls=0;
    const input=new Proxy({relativePath:"packages/live/src/value.ts",bytes:new Uint8Array([1])},{ownKeys(){calls++;throw new Error("trap");}});
    expect(()=>captureHostedDependencyWarmLeafRequest(input)).toThrow("warm_leaf_unsupported");expect(calls).toBe(0);
  });
  it("copies an actual bounded view without consulting its iterator",()=>{
    let calls=0;const buffer=new Uint8Array(2*1024*1024),bytes=buffer.subarray(8,10);bytes.set([3,4]);
    Object.defineProperty(bytes,Symbol.iterator,{value(){calls++;throw new Error("caller iterator");}});
    const request=captureHostedDependencyWarmLeafRequest({relativePath:"packages/live/src/value.ts",bytes});
    buffer[8]=9;expect([...request.bytes]).toEqual([3,4]);expect(calls).toBe(0);
  });
  it("rejects traversal, hidden ancestors and extra authority-shaped fields",()=>{
    for(const relativePath of ["../value.ts","packages/live/../value.ts","packages/live/.git/value.ts","/packages/live/value.ts","packages//live/value.ts"]) {
      expect(()=>captureHostedDependencyWarmLeafRequest({relativePath,bytes:new Uint8Array([1])})).toThrow("warm_leaf_unsupported");
    }
    expect(()=>captureHostedDependencyWarmLeafRequest({relativePath:"packages/live/value.ts",bytes:new Uint8Array([1]),owner:{}})).toThrow("warm_leaf_unsupported");
  });
});
