import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { HostedRemovalRetirementReferences } from "../../provider-codex/app-server/adapters/hosted-removal-retirement-mutex";
const state = vi.hoisted(() => ({ root: "", boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", paths: new Map<number,string>(),
  unknown: undefined as number | undefined, archiveCalls: 0, replacement: false, busy: false, archiveReplyLost: false, renamed:false, failArchiveSync:false, synced:[] as string[] }));
vi.mock("node:child_process", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...child, spawnSync: (_command:string,args:string[],options:{stdio:(string|number)[]}) => {
    if (options.stdio.length===4) return {status:0,signal:null,stdout:state.busy ? "busy\n" : "locked\n",stderr:""};
    state.archiveCalls++;
    const from=state.paths.get(Number(options.stdio[3]))!+"/"+args[3], to=state.paths.get(Number(options.stdio[4]))!+"/"+args[4];
    // Model syscall NOREPLACE, not kernel flock semantics (separate native probe).
    if(fs.existsSync(to))return {status:1,signal:null,stdout:"",stderr:"destination exists"};
    fs.renameSync(from,to);state.renamed=true;for(const [fd,path] of state.paths)if(path===from)state.paths.set(fd,to);
    if(state.replacement)fs.mkdirSync(from,{mode:0o700});
    return state.archiveReplyLost ? {status:1,signal:null,stdout:"",stderr:"lost acknowledgment"} : {status:0,signal:null,stdout:"archived\n",stderr:""};
  } };
});
vi.mock("node:fs", async () => {
  const fs=await vi.importActual<typeof import("node:fs")>("node:fs");
  const map=(p:import("node:fs").PathLike):import("node:fs").PathLike => {
    if(typeof p!=="string")return p;
    const fd=/^\/proc\/self\/fd\/([0-9]+)(.*)$/.exec(p);
    if(fd)return state.paths.get(Number(fd[1]))!+fd[2];
    if(["/","/var","/var/lib"].includes(p))return state.root;
    return p.startsWith("/var/lib/subscription-runtime-host-policy") ? state.root+p.slice("/var/lib/subscription-runtime-host-policy".length) : p;
  };
  const rooted=(s:import("node:fs").Stats|import("node:fs").BigIntStats) => Object.assign(Object.create(Object.getPrototypeOf(s)),s,
    {uid:typeof s.uid==="bigint" ? 0n : 0});
  return {...fs,
    fsyncSync:(fd:number)=>{const path=state.paths.get(fd)!;
      if(state.renamed && state.failArchiveSync && path===state.root){state.failArchiveSync=false;throw new Error("TEST_after_rename_parent_fsync_fault");}
      fs.fsyncSync(fd);state.synced.push(path);
    },
    openSync:(p:import("node:fs").PathLike,f:number,m?:number)=>{const actual=map(p),fd=fs.openSync(actual,f,m);if(typeof actual==="string")state.paths.set(fd,actual);return fd;},
    closeSync:(fd:number)=>{state.paths.delete(fd);fs.closeSync(fd);},
    fstatSync:(fd:number,o?:{bigint?:boolean})=>fd<=2 ? {isFIFO:()=>true,isSocket:()=>false} : rooted(fs.fstatSync(fd,o as {bigint:true})),
    lstatSync:(p:import("node:fs").PathLike,o?:{bigint?:boolean})=>rooted(fs.lstatSync(map(p),o as {bigint:true})),
    statSync:(p:import("node:fs").PathLike,o?:{bigint?:boolean})=>rooted(fs.statSync(map(p),o as {bigint:true})),
    mkdirSync:(p:import("node:fs").PathLike,o:import("node:fs").MakeDirectoryOptions)=>fs.mkdirSync(map(p),o),
    rmdirSync:(p:import("node:fs").PathLike)=>fs.rmdirSync(map(p)),
    statfsSync:()=>({type:0xef53n}),
    readlinkSync:()=>"initial-namespace",
    readdirSync:(p:import("node:fs").PathLike,o?:unknown)=>p==="/proc/self/fd" ? [...state.paths.keys(),...(state.unknown===undefined ? [] : [state.unknown])].map(String) : fs.readdirSync(map(p),o as undefined),
    readFileSync:(p:import("node:fs").PathOrFileDescriptor,o?:unknown)=>{
      if(p==="/proc/sys/kernel/random/boot_id")return state.boot;
      if(p==="/proc/self/uid_map")return "0 0 4294967295\n";
      if(typeof p==="string" && p.startsWith("/proc/self/fdinfo/")) {
        const s=fs.fstatSync(Number(p.split("/").at(-1)),{bigint:true});return `flags:\t02000000\nmnt_id:\t42\nino:\t${s.ino}\n`;
      }
      return fs.readFileSync(typeof p==="number" ? p : map(p),o as "utf8");
    },
  };
});
// Authenticated history/manager ports are finite TEST fixtures. The production
// archive proof and protected record pinning below remain real. Kernel bridge,
// Linux namespaces and uid are modeled; these are not native authority evidence.
const domain=vi.hoisted(()=>({owner:undefined as unknown,proof:undefined as unknown,history:undefined as unknown,idle:undefined as unknown,
  terminal:true,queueEmpty:true,cgroupEmpty:true,census:true,casLocked:false,pins:[] as {path:string;identity:{dev:string;ino:string};sha256:string}[]}));
vi.mock("../hosted-current-dependency-origin",()=>({assertOriginalHostedDependencyPhysicalRecordAccess:()=>{}}));
vi.mock("../hosted-readonly-host-kernel",()=>({HostedReadonlyHostKernel:class{operatorSession(){return {};}}}));
vi.mock("../hosted-dependency-generation-native-census",()=>({readOriginalHostedDependencyOperatorNativeCensus:()=>domain.census}));
vi.mock("../hosted-dependency-removal-history",()=>({
  readOriginalHostedDependencyRemovalRetirement:()=>{
    if(!domain.terminal || !domain.queueEmpty || !domain.cgroupEmpty)throw new Error("TEST_fresh_retirement_veto");
    for(const ref of domain.pins)if(!encodeReference(pinReferenceFile(ref.path).reference).equals(encodeReference(ref)))throw new Error("TEST_source_pin_veto");
    return domain.proof;
  },readOriginalHostedDependencyRemovalIdle:()=>domain.idle,
}));
vi.mock("../hosted-dependency-transactions",async()=>{
  const actual=await vi.importActual<typeof import("../hosted-dependency-transactions")>("../hosted-dependency-transactions");
  return {...actual,readOriginalHostedDependencyRemovalCommittedHistoryWithFence:()=>domain.history};
});
vi.mock("../hosted-dependency-removal-lock-release",()=>({
  confirmOriginalHostedDependencyRemovalLockReleased:(_f:unknown,ref:{path:string})=>{
    if(raw.existsSync(state.root+ref.path.slice("/var/lib/subscription-runtime-host-policy".length)))throw new Error("TEST_original_lock_present");
  },unlinkOriginalHostedDependencyRemovalLock:()=>{throw new Error("TEST_archive_must_not_unlink_remover");},
}));
vi.mock("../../store-local-file/dependency-environment/local-dependency-owner-store",()=>({LocalDependencyOwnerStore:{open:()=>({
  read:()=>{if(domain.casLocked)throw new Error("TEST_owner_CAS_mutex_held");return domain.owner;},close:()=>{},
  compareAndSwap:()=>{throw new Error("TEST_archive_must_not_CAS");},
})}}));
import { DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { assertOriginalHostedCompletedRemovalArchive, tryReleaseOriginalHostedDependencyCompletedRemoval,
  acknowledgeOriginalHostedCompletedRemovalArchive } from "../hosted-dependency-removal-ownership";
import { HostedDependencyRemovalRecordKind } from "../hosted-dependency-removal-records";
import { HostedDependencyRemovalDisposition } from "../hosted-dependency-removal-effects";
import { pinReferenceFile, encodeReference } from "../hosted-dependency-legacy-reference-records";
import { withHostedActivationFence, withHostedRemovalRetirementFence, withHostedRemovalRetirementReconciliation,
  assertHostedActivationFence, assertHostedActivationProcessDescriptors } from "../../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedRemovalRetirementMutex } from "../../provider-codex/app-server/adapters/hosted-removal-retirement-mutex";
import * as actualFs from "node:fs";
const raw = await vi.importActual<typeof import("node:fs")>("node:fs");
const ref=(suffix:string)=>({path:"/var/lib/subscription-runtime-host-policy/dependency-transactions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"+suffix,
  identity:{dev:"1",ino:"2"},sha256:"c".repeat(64)});
const refs:HostedRemovalRetirementReferences={claim:ref(".removal-claim.json"),actor:ref(".removal-actor.json"),
  lock:ref(".remove.lock"),completion:ref(".removal-session-closed.json")};
const platformDescriptor=Object.getOwnPropertyDescriptor(process,"platform")!;
const canonical=()=>state.root+`/readonly-epoch.${state.boot}.lock`;
beforeEach(()=>{state.root=raw.mkdtempSync("/private/tmp/TEST-retirement-fence-contract-");state.paths.clear();state.archiveCalls=0;
  domain.terminal=true;domain.queueEmpty=true;domain.cgroupEmpty=true;domain.census=true;domain.casLocked=false;domain.pins=[];
  state.unknown=undefined;state.replacement=false;state.busy=false;state.archiveReplyLost=false;state.renamed=false;state.failArchiveSync=false;state.synced=[];Object.defineProperty(process,"platform",{...platformDescriptor,value:"linux"});
  vi.spyOn(process,"getuid").mockReturnValue(0);});
afterEach(()=>{for(const fd of state.paths.keys())raw.closeSync(fd);state.paths.clear();raw.rmSync(state.root,{recursive:true,force:true});vi.restoreAllMocks();Object.defineProperty(process,"platform",platformDescriptor);});

describe("finite witnessed activation lifecycle (kernel bridge mocked)",()=>{
  it("preserves unknown legacy empty directory without callback or archive",()=>{
    raw.mkdirSync(canonical(),{mode:0o700});const before=raw.statSync(canonical());let entered=false;
    expect(()=>withHostedRemovalRetirementReconciliation(()=>{entered=true;},()=>{})).toThrow();
    expect(entered).toBe(false);expect(raw.statSync(canonical()).ino).toBe(before.ino);expect(state.archiveCalls).toBe(0);
    expect(()=>withHostedActivationFence(()=>{})).toThrow();
  });
  it("commits witness before effects and never runs stale canonical cleanup after archive",()=>{
    state.replacement=true;let saved:Parameters<typeof assertHostedActivationFence>[0]|undefined;
    withHostedRemovalRetirementFence(fence=>{assertHostedActivationProcessDescriptors(fence);return refs;},fence=>{
      saved=fence;expect(JSON.parse(raw.readFileSync(canonical()+"/owner.json","utf8")).claim).toEqual(refs.claim);
      assertHostedActivationProcessDescriptors(fence);
    },()=>{});
    expect(raw.existsSync(canonical())).toBe(true);expect(raw.readdirSync(canonical())).toEqual([]);
    expect(raw.readdirSync(state.root+"/activation-fence-retired")).toHaveLength(1);
    expect(()=>assertHostedActivationFence(saved!)).toThrow();expect(state.paths.size).toBe(0);
  });
  it("failed archive-only proof preserves original witness and makes no namespace effect",()=>{
    expect(()=>withHostedRemovalRetirementFence(()=>refs,()=>{},()=>{throw new Error("fresh terminal/source/census veto");})).toThrow("fresh terminal");
    expect(raw.existsSync(canonical()+"/owner.json")).toBe(true);expect(state.archiveCalls).toBe(0);
    let replayed=false;
    expect(()=>withHostedRemovalRetirementReconciliation(()=>{replayed=true;},()=>{throw new Error("null owner is not archive proof");})).toThrow("null owner");
    expect(replayed).toBe(true);expect(state.archiveCalls).toBe(0);expect(raw.existsSync(canonical()+"/owner.json")).toBe(true);
  });
  it("rejects partial/foreign witness and Busy original OFD before completion effects",()=>{
    raw.mkdirSync(canonical(),{mode:0o700});raw.writeFileSync(canonical()+"/owner.json","{",{mode:0o600});let effects=0;
    expect(()=>withHostedRemovalRetirementReconciliation(()=>effects++,()=>{})).toThrow();expect(effects).toBe(0);
    raw.writeFileSync(canonical()+"/owner.json",JSON.stringify({version:1,purpose:"foreign"}),{mode:0o600});
    expect(()=>withHostedRemovalRetirementReconciliation(()=>effects++,()=>{})).toThrow();expect(effects).toBe(0);
    state.busy=true;expect(()=>HostedRemovalRetirementMutex.open(state.boot,true)).toThrow("busy");expect(effects).toBe(0);
  });
  it("permits only actual held adapter directory FDs and rejects an unrelated one",()=>{
    withHostedRemovalRetirementFence(()=>refs,fence=>{
      assertHostedActivationProcessDescriptors(fence);
      const unknown=actualFs.openSync(state.root,actualFs.constants.O_RDONLY|actualFs.constants.O_DIRECTORY);
      try {expect(()=>assertHostedActivationProcessDescriptors(fence)).toThrow();}finally{actualFs.closeSync(unknown);}
    },()=>{});
  });
  it("rejects a delayed old-inode contender after replacement before any callback",()=>{
    expect(()=>withHostedRemovalRetirementFence(()=>refs,()=>{},()=>{throw new Error("hold");})).toThrow("hold");
    const old=HostedRemovalRetirementMutex.open(state.boot,true);state.replacement=true;
    try {withHostedRemovalRetirementReconciliation(()=>{},()=>{});expect(()=>old.check()).toThrow();
      expect(raw.readdirSync(canonical())).toEqual([]);}finally{old.close();}
  });
  it("rejects asynchronous archive proof before namespace release",()=>{
    expect(()=>withHostedRemovalRetirementFence(()=>refs,()=>{},()=>Promise.resolve())).toThrow("synchronous_fence_required");
    expect(state.archiveCalls).toBe(0);expect(raw.existsSync(canonical()+"/owner.json")).toBe(true);
  });
  it("joins uncertain archive reply to original inode without touching replacement generation",()=>{
    state.archiveReplyLost=true;state.replacement=true;
    withHostedRemovalRetirementFence(()=>refs,()=>{},()=>{});
    expect(state.archiveCalls).toBe(1);expect(raw.readdirSync(canonical())).toEqual([]);
    expect(raw.readdirSync(state.root+"/activation-fence-retired")).toHaveLength(1);
  });

});

// Removing any production witness/null/idle/fresh-retirement/census/store join
// makes at least one of these archive-veto cases red. A null owner on its own
// cannot authorize namespace retirement, even after completion's early return.
describe("actual owner-null archive proof with finite TEST history ports",()=>{
  function completed() {
    const op="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",workspace={canonicalPath:"/TEST-retirement/workspace",dev:"1",ino:"3"};
    const claimed=parseDependencyOwner({version:2,workspace,revision:21,epoch:5,owner:{kind:DependencyOwnerKind.Maintenance,
      phase:DependencyOwnerPhase.ExclusiveMutation,attempt:{operationId:op,epoch:5,host:{installationId:state.boot,bootId:state.boot,
        supervisorId:"100:200",runtimeSha:"b".repeat(40),inventoryDigest:"d".repeat(64),grantDigest:"c".repeat(64)}}}});
    if(!claimed.owner)throw new Error("TEST_owner_fixture");
    const fenced=parseDependencyOwner({...claimed,revision:22,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}),
      next=parseDependencyOwner({...fenced,revision:23,owner:null}),policy="/var/lib/subscription-runtime-host-policy/dependency-transactions/";
    raw.mkdirSync(state.root+"/dependency-transactions",{mode:0o700});
    const record=(suffix:string,value:unknown)=>{const path=policy+op+suffix;
      raw.writeFileSync(state.root+path.slice("/var/lib/subscription-runtime-host-policy".length),encodeReference(value),{mode:0o600});
      return pinReferenceFile(path).reference;};
    const claim=record(".removal-claim.json",{purpose:"TEST_authenticated_claim_boundary"}),actor=record(".removal-actor.json",{purpose:"TEST_authenticated_actor_boundary"}),
      retirement=record(".removal-retirement.json",{purpose:"TEST_authenticated_retirement_boundary"}),lock=record(".remove.lock",{purpose:"TEST_original_remover_lock"}),
      sourceClosed=record(".source-closed.json",{purpose:"TEST_original_SourceClosed"}),absentPin=record(".absent.json",{purpose:"TEST_original_Absent"}),
      completion=record(".removal-session-closed.json",{version:1,kind:HostedDependencyRemovalRecordKind.SessionClosed,claim,actor,disposition:HostedDependencyRemovalDisposition.Removed,removedEntries:7}),
      binding={workspace},absent={receipt:{operationId:op},reference:absentPin},selectedClaim={claimed,binding,absent,sourceClosed};
    raw.unlinkSync(state.root+lock.path.slice("/var/lib/subscription-runtime-host-policy".length));
    const idlePin=record(".TEST-idle.json",{claim,retirement,completion,fenced,released:next});
    domain.owner=next;domain.proof={selected:{reference:claim,claim:selectedClaim},actorReference:actor,retirement,lock};
    domain.history={actual:{binding},committed:absent};domain.pins=[claim,actor,retirement,sourceClosed,absentPin,idlePin];
    const idle={previous:next,claim:selectedClaim,retirement,priorAbsent:absent,removedEntries:7,attempt:claimed.owner.attempt};domain.idle=idle;
    const originals={claim,actor,lock,completion};
    // Completion may already return on null. Archive still has independent proof.
    withHostedActivationFence(f=>expect(tryReleaseOriginalHostedDependencyCompletedRemoval(f,"TEST-retirement",12,Symbol("TEST"))).toMatchObject({removedEntries:7}));
    expect(()=>withHostedRemovalRetirementFence(()=>originals,()=>{},()=>{throw new Error("TEST_parent_died_before_archive");})).toThrow("TEST_parent_died");
    const archive=()=>withHostedRemovalRetirementReconciliation(()=>{},(f,w)=>assertOriginalHostedCompletedRemovalArchive(f,w,"TEST-retirement",12,Symbol("TEST")));
    return {archive,next,idle,originals,sourceClosed,absentPin,completion,lock};
  }
  it("archives exact completed deterministic null with fresh proof, without owner CAS",()=>{
    const f=completed();f.archive();expect(state.archiveCalls).toBe(1);expect(domain.owner).toEqual(f.next);expect(raw.existsSync(canonical())).toBe(false);
  });
  for(const fault of ["null_only","null_revision","idle_stage","idle_claim","idle_retirement","completion","terminal","queue","cgroup","source","Absent","native_census","CAS_mutex","remover_lock"] as const)
    it(`retains witnessed original for ${fault} veto after completion's null early return`,()=>{
      const f=completed();
      if(fault==="null_only")domain.idle=undefined;
      if(fault==="null_revision")domain.owner={...f.next,revision:24};
      if(fault==="idle_stage")domain.idle={...f.idle,previous:{...f.next,revision:24}};
      if(fault==="idle_claim")domain.idle={...f.idle,claim:{...f.idle.claim,claimed:f.next}};
      if(fault==="idle_retirement")domain.idle={...f.idle,retirement:{...f.idle.retirement,sha256:"f".repeat(64)}};
      if(fault==="terminal")domain.terminal=false;if(fault==="queue")domain.queueEmpty=false;if(fault==="cgroup")domain.cgroupEmpty=false;
      if(fault==="native_census")domain.census=false;if(fault==="CAS_mutex")domain.casLocked=true;
      const changed=fault==="source" ? f.sourceClosed : fault==="Absent" ? f.absentPin : fault==="completion" ? f.completion : undefined;
      if(changed)raw.writeFileSync(state.root+changed.path.slice("/var/lib/subscription-runtime-host-policy".length),"TEST changed original bytes\n");
      if(fault==="remover_lock")raw.writeFileSync(state.root+f.lock.path.slice("/var/lib/subscription-runtime-host-policy".length),"TEST unresolved remover\n",{mode:0o600});
      expect(()=>f.archive()).toThrow();expect(state.archiveCalls).toBe(0);expect(raw.existsSync(canonical()+"/owner.json")).toBe(true);
      // Recovery capability must be cleared even when the proof fails.
      domain.casLocked=false;expect(state.paths.size).toBe(0);
    });
  it("rejoins only original archived inode under a fresh common fence after process death",()=>{
    const f=completed();state.failArchiveSync=true;expect(()=>f.archive()).toThrow("TEST_after_rename");
    expect(raw.existsSync(canonical())).toBe(false);state.synced=[];const names=raw.readdirSync(state.root+"/activation-fence-retired"),path=state.root+"/activation-fence-retired/"+names[0],ino=raw.statSync(path).ino;
    withHostedActivationFence(fence=>{const currentInode=raw.statSync(canonical()).ino;
      acknowledgeOriginalHostedCompletedRemovalArchive(fence,"TEST-retirement",12,Symbol("TEST"));
      expect(raw.statSync(canonical()).ino).toBe(currentInode);expect(raw.readdirSync(canonical())).toEqual([]);
    });
    expect(raw.statSync(path).ino).toBe(ino);expect(state.archiveCalls).toBe(1);expect(state.paths.size).toBe(0);
    expect(state.synced).toEqual(expect.arrayContaining([path,state.root,state.root+"/activation-fence-retired"]));
  });
  it("fresh archive acknowledgement veto never touches canonical replacement or old archive",()=>{
    const f=completed();f.archive();domain.queueEmpty=false;const before=raw.readdirSync(state.root+"/activation-fence-retired");
    withHostedActivationFence(fence=>{const currentInode=raw.statSync(canonical()).ino;
      expect(()=>acknowledgeOriginalHostedCompletedRemovalArchive(fence,"TEST-retirement",12,Symbol("TEST"))).toThrow();
      expect(raw.statSync(canonical()).ino).toBe(currentInode);
    });expect(raw.readdirSync(state.root+"/activation-fence-retired")).toEqual(before);expect(state.archiveCalls).toBe(1);
  });
});
