import { expect, it } from "vitest";
import { captureHostedDependencyColdCustodyPolicy } from "../hosted-dependency-cold-custody-intent";
// Regression: configuration capture must not execute caller code before the
// fixed producer can independently select installation and ownership.
it("refuses an accessor policy without invoking it",()=>{
  let calls=0;
  const policy=Object.defineProperty({},"jobId",{enumerable:true,get(){calls++;return "TEST-R";}});
  expect(()=>captureHostedDependencyColdCustodyPolicy(policy)).toThrow();expect(calls).toBe(0);
});
it("refuses proxy configuration before descriptor traps",()=>{
  let calls=0;const policy=new Proxy({}, {ownKeys(){calls++;return [];},getOwnPropertyDescriptor(){calls++;return undefined;}});
  expect(()=>captureHostedDependencyColdCustodyPolicy(policy)).toThrow();expect(calls).toBe(0);
});
it("does not evaluate an accessor readonly path or custom iterator",()=>{
  let calls=0;const paths:string[]=[];
  Object.defineProperty(paths,"0",{enumerable:true,get(){calls++;return "/source";}});paths.length=1;
  const policy={schemaVersion:1,jobId:"TEST-R",jobRootDir:"/root/job",workspacePath:"/root/job/workspace",
    runtimeSha:"a".repeat(40),runtimeManifestSha256:"b".repeat(64),issuerDeploymentDigest:"c".repeat(64),readonlyPaths:paths};
  expect(()=>captureHostedDependencyColdCustodyPolicy(policy)).toThrow();expect(calls).toBe(0);
  const iterated=["/source"];Object.defineProperty(iterated,Symbol.iterator,{value(){calls++;throw new Error("unexpected iterator");}});
  expect(()=>captureHostedDependencyColdCustodyPolicy({...policy,readonlyPaths:iterated})).toThrow();expect(calls).toBe(0);
});
