import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DependencyInstallProfile } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLegacyComparisonRecipe } from "../../worker-core/dependency-environment/domain/dependency-legacy-comparison";
import { HostedDependencyReferenceKind, hostedDependencyJobRoot, parseHostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { parseReferenceResult } from "../hosted-dependency-legacy-reference-records";

// Wire-contract tests only. These inert records cannot authorize publication or
// admission. Recipe/profile/schema confusion or a placeholder source binding
// makes these red; native lifetime/physical/CAS qualification stays mandatory.
describe("strict legacy reference result dispatch",()=>{
  const digest="a".repeat(64);
  function registry() {
    const operationId=randomUUID(),generation=randomUUID(),installationId=randomUUID();
    const ref=(name:string)=>({path:`/TEST/${operationId}/${name}.json`,identity:{dev:"1",ino:"2"},sha256:digest});
    return {version:1,operationId,relation:ref("relation"),referenceStart:ref("start"),referenceEntry:ref("entry"),
      installKey:digest,inputSha256:digest,profileSha256:digest,reference:{workspace:{canonicalPath:"/TEST/reference",dev:"1",ino:"3"},
        generation,coverageRevision:digest,tree:{dev:"1",ino:"4"},manifestVersion:1,manifestDigest:digest,installationId,
        output:ref("output"),mapping:ref("mapping"),start:ref("installer-start"),creator:ref("creator"),completion:ref("completion"),terminal:ref("terminal")}};
  }
  function local() {
    const old=registry();return {...old,version:2,recipe:DependencyLegacyComparisonRecipe.NpmLocalNoLifecycleV1,
      profile:DependencyInstallProfile.TestNpmLocalNoLifecycleV1,closureDigest:digest,
      reference:{...old.reference,manifestVersion:2,sourceBinding:old.reference.mapping}};
  }
  it("keeps the reserved local binding closed to unknown purpose or kind",()=>{
    const jobId="TEST-n5-wire-local",jobRootDir=hostedDependencyJobRoot(jobId);
    const binding={version:3,jobId,jobRootDir,workspace:{canonicalPath:jobRootDir+"/workspace",dev:"1",ino:"3"},
      installationId:randomUUID(),runtimeSha:"a".repeat(40),grantDigest:digest,
      reference:{kind:HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1,operationId:randomUUID()}};
    expect(parseHostedDependencyBinding(binding)).toEqual(binding);
    expect(()=>parseHostedDependencyBinding({...binding,reference:{...binding.reference,kind:"arbitrary_reference"}})).toThrow();
    expect(()=>parseHostedDependencyBinding({...binding,purpose:"ordinary"})).toThrow();
    expect(()=>parseHostedDependencyBinding({...binding,reference:{...binding.reference,installKey:digest}})).toThrow();
  });
  it("preserves exact registry v1 and refuses local fields on it",()=>{
    const record=registry();expect(parseReferenceResult(record)).toEqual(record);
    expect(()=>parseReferenceResult({...record,closureDigest:digest})).toThrow();
    expect(()=>parseReferenceResult({...record,reference:{...record.reference,sourceBinding:record.reference.mapping}})).toThrow();
  });
  it("recognizes only the exact local schema and strict reference fields",()=>{
    const record=local();expect(parseReferenceResult(record)).toEqual(record);
    for (const bad of [{...record,version:3},{...record,recipe:DependencyLegacyComparisonRecipe.NpmRegistryNoScriptsV1},
      {...record,profile:DependencyInstallProfile.TestNpmQualification},{...record,inputSha256:"b".repeat(64)},
      {...record,reference:{...record.reference,manifestVersion:1}},
      {...record,reference:{...record.reference,sourceBinding:{completionSha256:digest}}},
      {...record,reference:{...record.reference,verified:true}}]) expect(()=>parseReferenceResult(bad)).toThrow();
  });
});
