/** Fixed installer prepare/complete adapter, real immutable records and one
 * owned local child. Permission/profile/systemd facts are explicitly projected;
 * this is not host-manager timeout, pidfd, queue, or descendant proof. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyNpmLockName,
  type DependencyAttempt, type DependencyWorkspaceIdentity } from "../../worker-core/index";
import type { HostedDependencyInstallerPhysicalFrame, HostedDependencyColdInstallerCapture } from "../hosted-dependency-installer";
import type { CurrentHostedDependencyOrigin } from "../hosted-current-dependency-origin";
import { HostedDependencyColdInstallerPhase } from "../hosted-dependency-cold-materialization-state";
const f=vi.hoisted(()=>({root:"",busy:false,submits:0,child:undefined as ChildProcess|undefined,
  capture:undefined as HostedDependencyColdInstallerCapture|undefined,frame:undefined as HostedDependencyInstallerPhysicalFrame|undefined,
  phase:"",workspace:undefined as DependencyWorkspaceIdentity|undefined,attempt:undefined as DependencyAttempt|undefined}));
vi.mock("../hosted-current-dependency-origin",()=>({requiresCurrentHostedDependencyRootPurpose:()=>false,
  assertOriginalHostedDependencyColdProducer:()=>{if(f.busy)throw new DependencyAdmissionError(DependencyAdmissionFailure.Busy);return {binding:{workspace:f.workspace},attempt:f.attempt};},
  readOriginalHostedDependencyColdInstallerState:()=>({installerCapture:f.capture,installerFrame:f.frame,installerPhase:f.phase}),
}));
vi.mock("../hosted-dependency-installer-recipe",()=>({get hostedDependencyInstallerRoot(){return f.root;},
  createHostedDependencyInstallerPlan:(startId:string)=>{const directory=join(f.root,startId),stagingDirectory=join(directory,"stage");mkdirSync(directory);mkdirSync(stagingDirectory);mkdirSync(join(stagingDirectory,"node_modules"));
    return {startId,directory,stagingDirectory,rootDirectory:directory,lockName:DependencyNpmLockName.PackageLock,inputSha256:"a".repeat(64),profile:{TEST:"projected protected tool profile"},recipe:"npm_registry_no_scripts_v1"};},
  assertHostedDependencyInstallerPlan:()=>{},
}));
vi.mock("../trusted-custody-systemd-launch",()=>({TrustedCustodyLaunchRole:{Installer:"installer"},hostedFdCustodySystemdLaunch:()=>({command:process.execPath,args:["-e","process.exitCode=7"]})}));
vi.mock("../../provider-codex/app-server/adapters/hosted-fd-observation",()=>({readHostedFdProfile:()=>({TEST:"projected native profile"})}));
vi.mock("../../provider-codex/app-server/adapters/hosted-fd-launch",()=>({HostedFdLaunchKind:{Installer:"installer"},
  spawnHostedFdChild:(command:string,args:string[])=>{f.submits++;const directories=readdirSync(f.root).filter(v=>!v.startsWith("attempt-")),directory=join(f.root,directories[0]!);
    writeFileSync(join(directory,"stage","node_modules","partial-output"),Buffer.from([0,255,17,10]));
    f.child=spawn(command,args,{stdio:"ignore"});return f.child;},
  hostedFdLaunch:()=>({invalidate:()=>{}}),
}));
vi.mock("../hosted-readonly-linux-collector",()=>({collectProcessBirth:(pid:string)=>"TEST-owned-child:"+pid,
  collectProcessCgroup:()=>`0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${f.attempt!.launch.unit}`,
}));
vi.mock("../hosted-readonly-custody",()=>({readonlySupervisorRoot:"/TEST-projected-host-policy",createReadonlyPrivateRecord:(path:string,bytes:Buffer)=>{
  if(existsSync(path)){if(!readFileSync(path).equals(bytes))throw Error("TEST immutable conflict");return;}writeFileSync(path,bytes,{flag:"wx",mode:0o600});
}}));
import { prepareOriginalHostedDependencyColdInstaller, completeOriginalHostedDependencyColdInstaller } from "../hosted-dependency-installer";
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"TEST-installer-start-state-")));f.root=join(root,"records");await mkdir(f.root,{mode:0o700});const workspacePath=join(root,"workspace");await mkdir(workspacePath);
  const stat=lstatSync(workspacePath,{bigint:true});f.workspace={canonicalPath:workspacePath,dev:String(stat.dev),ino:String(stat.ino)};
  const startId=randomUUID();f.attempt={attemptId:randomUUID(),epoch:1,launch:{installationId:randomUUID(),bootId:randomUUID(),startId,
    unit:`subscription-runtime-ordinary-${startId}.service`,runtimeSha:"a".repeat(40),grantDigest:"b".repeat(64)}};
  // Inputs/profile are projected permission/recipe enrollment, not output facts.
  f.capture={request:{workspace:f.workspace,attempt:f.attempt,lockName:DependencyNpmLockName.PackageLock,packageBytes:Buffer.from("{}"),lockBytes:Buffer.from("{}")},inputs:{} as HostedDependencyColdInstallerCapture["inputs"]};
  f.frame=undefined;f.phase=HostedDependencyColdInstallerPhase.Prepared;f.busy=false;f.submits=0;f.child=undefined;
  return {root,context:{} as CurrentHostedDependencyOrigin,fence:{} as Parameters<typeof prepareOriginalHostedDependencyColdInstaller>[1],access:Symbol("TEST original issuer"),
    async close(){if(f.child && f.child.exitCode===null){f.child.kill("SIGTERM");await new Promise<void>(resolve=>f.child!.once("close",()=>resolve()));}await rm(root,{recursive:true,force:true});}};
}
describe("installer durable start-state retention, projected original authority",()=>{
  // Regression: Busy is discovered only after installer record/birth, confusing
  // pre-launch refusal with uncertain launched installation.
  it("Busy before prepare creates no start, consumption, partial output or child",async()=>{
    const x=await fixture();try{f.busy=true;expect(()=>prepareOriginalHostedDependencyColdInstaller(x.context,x.fence,x.access)).toThrow("busy");
      expect(f.submits).toBe(0);expect(readdirSync(f.root)).toEqual([]);expect(f.child).toBeUndefined();
    }finally{await x.close();}
  });
  // Regression: an unsuccessful launched wait permits fresh attempt birth or
  // writes completion/Ready while discarding actual partial dependency bytes.
  it("unsuccessful owned child permanently consumes attempt and retains immutable start/creator/partial bytes",async()=>{
    const x=await fixture();try{
      const frame=prepareOriginalHostedDependencyColdInstaller(x.context,x.fence,x.access);f.frame=frame;
      expect(await frame.waited).toBe(false);expect(f.submits).toBe(1);
      const names=["start.json","consumed.json","creator.json"],before=names.map(name=>({name,bytes:readFileSync(join(frame.plan.directory,name)),stat:lstatSync(join(frame.plan.directory,name),{bigint:true})}));
      expect(JSON.parse(before[1]!.bytes.toString()).startId).toBe(frame.startId);
      expect(JSON.parse(before[2]!.bytes.toString()).pidBirth).toBe("TEST-owned-child:"+frame.child.pid);
      expect(()=>completeOriginalHostedDependencyColdInstaller(x.context,x.fence,x.access)).toThrow("dependency_installer_unresolved");
      // Even after losing volatile frame state, persisted attempt O_EXCL denies
      // re-enqueue; a fresh random startId cannot undo consumed history.
      f.frame=undefined;expect(()=>prepareOriginalHostedDependencyColdInstaller(x.context,x.fence,x.access)).toThrow();expect(f.submits).toBe(1);
      for(const old of before){const path=join(frame.plan.directory,old.name),now=lstatSync(path,{bigint:true});expect(readFileSync(path)).toEqual(old.bytes);expect([now.dev,now.ino,now.mode]).toEqual([old.stat.dev,old.stat.ino,old.stat.mode]);}
      expect(readFileSync(join(frame.plan.stagingDirectory,"node_modules","partial-output"))).toEqual(Buffer.from([0,255,17,10]));
      for(const name of ["creator-completion.json","terminal.json","revoked.json","ready.json"])expect(existsSync(join(frame.plan.directory,name))).toBe(false);
    }finally{await x.close();}
  });
});
