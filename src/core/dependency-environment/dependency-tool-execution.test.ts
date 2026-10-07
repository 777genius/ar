import { DependencyToolReadyProvenanceKind } from "./dependency-tool-ready-reader";
import { describe, it, expect } from "vitest";
import { DependencyToolExecutionBasis, DependencyToolQualificationKind, parseDependencyToolAdmissionQualification,
  parseDependencyToolBaselineExecution, parseDependencyToolUsableExecution, matchesDependencyToolExecution, dependencyToolAdmittedGuestConfig } from "./dependency-tool-execution";
import { DependencyToolOperation, DependencyToolProfileId, DependencyToolTransformCache, dependencyToolPins } from "./dependency-tool-profile";
const id="11111111-1111-1111-1111-111111111111";
function fixture() {
  const file=(n:number)=>({path:`/protected/file${n}`,sha256:"a".repeat(64)});
  return {version:2,basis:DependencyToolExecutionBasis.UsableUnverified,
    workspace:{canonicalPath:"/workspace",dev:"1",ino:"2"},tree:{dev:"1",ino:"3"},
    installationId:id,runtimeSha:"b".repeat(40),grantDigest:"c".repeat(64),bindingSha256:"d".repeat(64),
    startId:id,attemptId:id,epoch:1,receipt:{path:"/protected/unverified.json",identity:{dev:"1",ino:"4"},sha256:"e".repeat(64)},
    receiptRevision:2,currentInstallKey:"f".repeat(64),inputClosureDigest:"a".repeat(64),
    profile:{version:1,profileId:DependencyToolProfileId.ViteVitestConfigFreeV1,pins:dependencyToolPins,
      cache:{canonicalPath:"/cache",dev:"1",ino:"5"},node:file(8),helper:file(0),
      readonlyFiles:Array.from({length:7},(_,i)=>file(i)),testFiles:["x.test.ts"],optimizerDependencies:["vite"],
      transformCache:DependencyToolTransformCache.Persisted},
    capabilities:[DependencyToolOperation.Optimize,DependencyToolOperation.Test],sourceRoots:[],sourceLookupAncestors:[]};
}
describe("truthful usable tool facts",()=>{
  it("has no Ready or content attestation and retains actual current input identity",()=>{
    const execution=parseDependencyToolUsableExecution(fixture());
    const q=parseDependencyToolAdmissionQualification({version:2,kind:DependencyToolQualificationKind.UsableUnverifiedV2,execution});
    expect(dependencyToolAdmittedGuestConfig(q).tree).toEqual(execution.tree);
    expect(matchesDependencyToolExecution(execution,parseDependencyToolUsableExecution({...fixture(),currentInstallKey:"0".repeat(64)}))).toBe(false);
    expect(matchesDependencyToolExecution(execution,parseDependencyToolUsableExecution({...fixture(),tree:{dev:"1",ino:"6"}}))).toBe(false);
    for(const name of ["baseline","ready","manifestDigest","sourceBinding","measurement"])
      expect(()=>parseDependencyToolUsableExecution({...fixture(),[name]:{}})).toThrow("dependency_tool_execution_invalid");
    expect(()=>parseDependencyToolUsableExecution({...fixture(),basis:DependencyToolExecutionBasis.BaselineAuthenticated})).toThrow();
  });
  it("never reuses another attempt, committed history, or source lookup identity",()=>{
    const original=parseDependencyToolUsableExecution(fixture());
    const candidates=[{...fixture(),epoch:2},
      {...fixture(),receipt:{...fixture().receipt,sha256:"0".repeat(64)}},
      {...fixture(),sourceRoots:[{canonicalPath:"/workspace/local",identity:{dev:"1",ino:"7"}}]},
      {...fixture(),sourceLookupAncestors:[{canonicalPath:"/workspace",identity:{dev:"1",ino:"2"}}]}];
    for(const candidate of candidates)expect(matchesDependencyToolExecution(original,parseDependencyToolUsableExecution(candidate))).toBe(false);
    const legacy={version:1,kind:"n3-authenticated-tool-closure",installationId:id,runtimeSha:"b".repeat(40),
      grantDigest:"c".repeat(64),workspace:fixture().workspace,startId:id,attemptId:id,epoch:1,readyRevision:2,
      installKey:"f".repeat(64),tree:fixture().tree,manifestDigest:"a".repeat(64),profile:fixture().profile,
      measurement:{entries:1,bytes:"1",durationMs:0}};
    const decoded=parseDependencyToolAdmissionQualification(legacy);
    expect(decoded.version).toBe(1);
    expect(dependencyToolAdmittedGuestConfig(decoded)).toEqual({version:1,workspace:legacy.workspace,tree:legacy.tree,profile:legacy.profile});
  });
  it("rejects accessors without invoking them, including nested profile and root arrays",()=>{
    let calls=0;
    const top=fixture();Object.defineProperty(top,"tree",{enumerable:true,get(){calls++;return {};}});
    expect(()=>parseDependencyToolUsableExecution(top)).toThrow();
    const nested=fixture();Object.defineProperty(nested.profile,"readonlyFiles",{enumerable:true,get(){calls++;return [];}});
    expect(()=>parseDependencyToolUsableExecution(nested)).toThrow();
    const array=fixture();Object.defineProperty(array.capabilities,"0",{enumerable:true,get(){calls++;return DependencyToolOperation.Optimize;}});
    expect(()=>parseDependencyToolUsableExecution(array)).toThrow();
    expect(calls).toBe(0);
  });
});

/** A regression would accept an unrelated historical Ready/reference/key as
 * the same current baseline, or invoke a baseline accessor while decoding. */
describe("separate historical baseline tool facts",()=>{
  const baseline=()=>{
    const current=fixture(),readyReference={...current.receipt,path:"/protected/ready.json"};
    return {...current,basis:DependencyToolExecutionBasis.BaselineAuthenticated,receipt:readyReference,baseline:{
      ready:{workspace:current.workspace,coverageRevision:"coverage-v1",revision:current.receiptRevision,
        installKey:current.currentInstallKey,tree:current.tree,manifestDigest:"a".repeat(64),
        provenance:{kind:DependencyToolReadyProvenanceKind.RegistryCompleted}},readyReference,
      continuity:{path:"/protected/baseline.json",identity:{dev:"1",ino:"9"},sha256:"a".repeat(64)},
      measurement:{entries:12,bytes:"321",durationMs:8}}};
  };
  it("retains historical measurement independently from the current execution and guest projection",()=>{
    const execution=parseDependencyToolBaselineExecution(baseline()),q=parseDependencyToolAdmissionQualification({
      version:3,kind:DependencyToolQualificationKind.BaselineAuthenticatedV3,execution});
    expect(q.version).toBe(3);expect(execution.baseline.measurement).toEqual({entries:12,bytes:"321",durationMs:8});
    expect(dependencyToolAdmittedGuestConfig(q)).toEqual({version:1,workspace:execution.workspace,tree:execution.tree,profile:execution.profile});
    const other=parseDependencyToolBaselineExecution({...baseline(),baseline:{...baseline().baseline,
      continuity:{...baseline().baseline.continuity,sha256:"0".repeat(64)}}});
    expect(matchesDependencyToolExecution(execution,other)).toBe(false);
    expect(()=>parseDependencyToolUsableExecution(baseline())).toThrow();
  });
  it("refuses mismatched Ready history and baseline accessors before guest projection",()=>{
    const original=baseline();
    for(const candidate of [{...original,currentInstallKey:"0".repeat(64)},
      {...original,receiptRevision:3},{...original,tree:{dev:"1",ino:"99"}},
      {...original,baseline:{...original.baseline,readyReference:{...original.receipt,sha256:"0".repeat(64)}}}])
      expect(()=>parseDependencyToolBaselineExecution(candidate)).toThrow("dependency_tool_execution_invalid");
    let calls=0;const accessor=baseline();Object.defineProperty(accessor.baseline,"ready",{enumerable:true,get(){calls++;return {};}});
    expect(()=>parseDependencyToolBaselineExecution(accessor)).toThrow();expect(calls).toBe(0);
    expect(()=>parseDependencyToolAdmissionQualification({version:2,kind:DependencyToolQualificationKind.UsableUnverifiedV2,
      execution:original})).toThrow();
  });
});
