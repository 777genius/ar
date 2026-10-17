/** Original runner orchestration with projected custody/issuer ports. The Linux
 * cases use real disposable tree effects and inventory files; no native proof. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DependencyOwnerKind, DependencyOwnerPhase } from "../../core/index";
const f=vi.hoisted(()=>({access:Symbol("TEST original lexical access"),selection:undefined as any,retired:undefined as any,
  quarantine:"",prefix:"",events:[] as string[],failure:"",released:false}));
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n"),hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
function pin(path:string){const bytes=readFileSync(path),st=lstatSync(path,{bigint:true});return {bytes,reference:{path,identity:{dev:String(st.dev),ino:String(st.ino)},sha256:hash(bytes)}};}
function fail(at:string){f.events.push(at);if(f.failure===at){f.failure="";throw Error("TEST crash:"+at);}}
vi.mock("../hosted-current-dependency-origin",()=>({assertOriginalHostedDependencyPhysicalRecordAccess:(a:symbol)=>{if(a!==f.access)throw Error("TEST foreign access");}}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation",()=>({assertHostedActivationFence:()=>{},withHostedActivationFence:(call:(v:unknown)=>unknown)=>call({held:true})}));
vi.mock("../hosted-dependency-preservation-operator",()=>({
  beginOriginalHostedDependencyPreservation:(_f:unknown,_job:string,recover:boolean)=>{fail(recover?"recover":"begin");return f.selection;},
  assertOriginalHostedDependencyPreservation:()=>{fail("owner-check");},
  readOriginalHostedDependencyPreservationRetired:()=>{fail("retired");return f.retired;},
  isOriginalHostedDependencyPreservationReleased:()=>f.released,
  readOriginalHostedDependencyPreservationDischargedUnits:()=>{fail("census");return ["TEST-old.service"];},
  releaseOriginalHostedDependencyPreservation:()=>{fail("release-before");f.released=true;fail("release-after");},
}));
vi.mock("../hosted-dependency-materialization",()=>({hostedDependencyObservationLimits:{maxEntries:128,maxTotalBytes:65536,maxManifestBytes:65536,maxDurationMs:30000}}));
vi.mock("../hosted-readonly-host-kernel",()=>({readHostedReadonlyHostInventory:()=>({units:[{controlGroup:"/TEST/projected"}]})}));
vi.mock("../hosted-dependency-reference-veto",()=>({DependencyReferenceEffect:{Eviction:"eviction"},assertHostedDependencyReferenceVeto:()=>{fail("reference-veto");}}));
vi.mock("../hosted-readonly-inputs",()=>({readHostedPrivateBytes:(path:string)=>existsSync(path)?readFileSync(path):null}));
vi.mock("../hosted-dependency-legacy-reference-records",()=>({encodeReference:(v:unknown)=>enc(v),pinReferenceFile:(path:string)=>pin(path)}));
vi.mock("../hosted-readonly-custody",()=>({createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>{
  const old=existsSync(path)?readFileSync(path):undefined;if(old&&!old.equals(bytes))throw Error("TEST immutable conflict");
  if(!old)writeFileSync(path,bytes,{mode:0o600,flag:"wx"});fail(path.endsWith(".prepared.json")?"prepared":path.endsWith(".committed.json")?"committed":"marker");
}}));
// Project protected record grammar here, not its authority. Real parsers and
// original issuer/index/owner admission have their separate composition tests.
vi.mock("../hosted-dependency-preservation",()=>({
  hostedDependencyQuarantineRoot:()=>f.quarantine,hostedDependencyPreservationPath:()=>f.prefix,
  readHostedDependencyPreparedPreservation:()=>({header:JSON.parse(readFileSync(f.prefix+".prepared.json","utf8")),reference:pin(f.prefix+".prepared.json").reference}),
  hostedDependencyPreservationCommit:(p:any)=>({version:1,prepared:p.reference,tree:p.header.trash.originalTree,inventoryDigest:p.header.inventory.digest}),
  readHostedDependencyCommittedPreservation:()=>{fail("mapping-check");return existsSync(f.prefix+".committed.json")?{kind:"TEST projected mapping"}:undefined;},
}));
vi.mock("../../worker-local/dependency-environment/dependency-tree-effects",async original=>{
  const actual=await original<typeof import("../../worker-local/dependency-environment/dependency-tree-effects")>();
  return {...actual,openDependencyTreePreservation:async(...args:Parameters<typeof actual.openDependencyTreePreservation>)=>{
    fail("open");const operation=await actual.openDependencyTreePreservation(...args);
    return {...operation,commit:(digest:string)=>{fail("rename-before");operation.commit(digest);fail("rename-after");},
      close:async()=>{const result=await operation.close();fail("closed");return result;}};
  }};
});
import { runOriginalHostedDependencyPreservation } from "../hosted-dependency-preservation-effect";
async function identity(path:string){const st=lstatSync(path,{bigint:true});return {canonicalPath:path,dev:String(st.dev),ino:String(st.ino)};}
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"TEST-original-preservation-runner-"))),workspace=join(root,"workspace"),tree=join(workspace,"node_modules");
  f.quarantine=join(root,"quarantine");await mkdir(workspace);await mkdir(tree);await mkdir(f.quarantine,{mode:0o700});
  await writeFile(join(tree,"unknown.js"),"authored unknown bytes");await symlink("missing-target",join(tree,"dangling"));await writeFile(join(workspace,"source"),"authored source");
  const operationId=randomUUID(),originalTree=await identity(tree);f.prefix=join(root,"mapping");f.events=[];f.failure="";f.released=false;
  f.selection={operationId,binding:{workspace:await identity(workspace)},destinationParent:await identity(f.quarantine),
    claimedOwner:{owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt:{operationId}}}};
  f.retired={receipt:{revision:3,tree:originalTree},reference:{path:"/TEST/projected-retired"}};
  return {root,workspace,tree,target:join(f.quarantine,"dependency-"+operationId),originalTree,async close(){await rm(root,{recursive:true,force:true});}};
}
it("rejects a foreign caller before original selection or filesystem effect",async()=>{
  f.events=[];await expect(runOriginalHostedDependencyPreservation("TEST",false,Symbol("copied"))).rejects.toThrow("foreign access");expect(f.events).toEqual([]);
});
it("original begin failure occurs before receipt/effect",async()=>{
  f.events=[];f.failure="begin";await expect(runOriginalHostedDependencyPreservation("TEST",false,f.access)).rejects.toThrow("crash:begin");
  expect(f.events).toEqual(["begin"]);
});
it("released replay still refuses absent committed mapping before opening or releasing an effect",async()=>{
  const x=await fixture();try{
    f.released=true;writeFileSync(f.prefix+".prepared.json",enc({inventory:{logicalBytes:"21",entries:1},trash:{destinationName:"TEST"}}));
    await expect(runOriginalHostedDependencyPreservation("TEST",true,f.access)).rejects.toThrow("preservation_effect_held");
    expect(f.events).toContain("mapping-check");expect(f.events).not.toContain("open");expect(f.events).not.toContain("release-before");
    expect(existsSync(x.tree)).toBe(true);expect(existsSync(x.target)).toBe(false);
  }finally{await x.close();}
});
describe.skipIf(process.platform!=="linux" || process.getuid?.()!==0)("original runner real disposable Linux effect (projected authority)",()=>{
  it("durably prepares then moves full inode before mapping, closes handles before release, and replays released result",async()=>{
    const x=await fixture();try{
      const result=await runOriginalHostedDependencyPreservation("TEST",false,f.access);
      expect(existsSync(x.tree)).toBe(false);expect(await identity(x.target)).toEqual({...x.originalTree,canonicalPath:x.target});
      expect(await readFile(join(x.target,"unknown.js"),"utf8")).toBe("authored unknown bytes");expect(await readlink(join(x.target,"dangling"))).toBe("missing-target");
      expect(await readFile(join(x.workspace,"source"),"utf8")).toBe("authored source");
      for(const [before,after] of [["retired","open"],["prepared","rename-before"],["rename-after","committed"],["committed","closed"],["closed","release-before"]])expect(f.events.indexOf(before!)).toBeLessThan(f.events.indexOf(after!));
      expect(f.released).toBe(true);const first=readFileSync(f.prefix+".prepared.json"),commit=readFileSync(f.prefix+".committed.json");f.events=[];
      expect(await runOriginalHostedDependencyPreservation("TEST",true,f.access)).toEqual(result);expect(f.events).not.toContain("open");
      expect(readFileSync(f.prefix+".prepared.json")).toEqual(first);expect(readFileSync(f.prefix+".committed.json")).toEqual(commit);
    }finally{await x.close();}
  });
  it.each(["prepared","rename-before","rename-after","committed","release-before","release-after"])("recovers original %s crash without replacing preserved bytes or releasing early",async phase=>{
    const x=await fixture();try{
      f.failure=phase;await expect(runOriginalHostedDependencyPreservation("TEST",false,f.access)).rejects.toThrow("crash:"+phase);
      const renamed=["rename-after","committed","release-before","release-after"].includes(phase);
      expect(existsSync(x.target)).toBe(renamed);expect(existsSync(x.tree)).toBe(!renamed);
      if(!["release-after"].includes(phase))expect(f.released).toBe(false);
      const prepared=readFileSync(f.prefix+".prepared.json"),result=await runOriginalHostedDependencyPreservation("TEST",true,f.access);
      expect(result.operationId).toBe(f.selection.operationId);expect(f.released).toBe(true);expect(existsSync(x.tree)).toBe(false);
      expect(readFileSync(f.prefix+".prepared.json")).toEqual(prepared);expect(await readFile(join(x.target,"unknown.js"),"utf8")).toBe("authored unknown bytes");
      expect(await identity(x.target)).toEqual({...x.originalTree,canonicalPath:x.target});
    }finally{await x.close();}
  });
  it("source-tree replacement fails before committed mapping and owner release",async()=>{
    const x=await fixture();try{
      await rename(x.tree,join(x.workspace,"retained-original"));await mkdir(x.tree);
      await writeFile(join(x.tree,"replacement.js"),"replacement bytes");
      await expect(runOriginalHostedDependencyPreservation("TEST",false,f.access)).rejects.toThrow();
      expect(existsSync(x.tree)).toBe(true);expect(existsSync(x.target)).toBe(false);expect(existsSync(f.prefix+".committed.json")).toBe(false);expect(f.released).toBe(false);
    }finally{await x.close();}
  });
});
