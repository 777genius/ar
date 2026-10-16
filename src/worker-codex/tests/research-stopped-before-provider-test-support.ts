import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { host, local } from "./research-launch-fixture";
import * as admission from "../research-launch-admission";
import * as files from "../research-launch-files";
import * as artifact from "../research-runtime-artifact";
import * as changes from "../codex-goal-workspace-changes";
import * as materialization from "../codex-goal-terminal-handoff-materialization";
import { cancelRegisteredResearchLaunch, releaseStoppedOwnedMimoWorkerBeforeProvider } from "../research-launch-lifecycle";
import { prepareResearchJobWriterObservation } from "../research-writer-observation";
import { researchMimoCodingBootstrapPaths } from "../research-mimo-coding-root";
import { PassThrough } from "node:stream";
import * as providerMaterial from "../../provider-codex/hosted-mimo-worker-material";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCodexProjectAdmissionSnapshot } from "../application/project-control/codex-goal-project-admission";
import { ProjectDebtReason } from "@vioxen/subscription-runtime/worker-core";

const ORIGINAL = "/opt/subscription-runtime/releases/2a9ca732123b8b0054dae1a38f754680272de77e";
const ORIGINAL_ARTIFACT = "ebaf4fd6ff74224d247b35f0f5630735cd6881ab663bdfcefcede3717d8bd69c";
type Native = ReturnType<typeof admission.researchCurrentStart> & { jobId:string;startId:string;specSha256:string;unit:string;provider:string;manifest:Parameters<typeof prepareResearchJobWriterObservation>[0] };
/** Genuine registered/native/binding creation and supported cancellation. Only
 * qualified historical artifact and kernel/service IO are labelled TEST ports;
 * no candidate or provider reservation is removed to manufacture eligibility. */
export function registeredStoppedBeforeProviderTests(input: {
  start():Promise<Native>;scope():ProjectAccessScope;setScope(s:ProjectAccessScope):void;
}):void {
  async function stopped(reserveProvider = false) {
    const entry=fs.readFileSync(join(process.cwd(),"host-integration/research-runtime-launch.mjs"));
    fs.mkdirSync(local(dirname(ORIGINAL)),{recursive:true,mode:0o700});fs.cpSync(local("/TEST-artifact"),local(ORIGINAL),{recursive:true});
    for(const path of researchMimoCodingBootstrapPaths(ORIGINAL)) {
      fs.mkdirSync(local(dirname(path)),{recursive:true,mode:0o700});fs.writeFileSync(local(path),path.endsWith("package.json")?'{"type":"module"}':"export {};",{mode:0o644});
    }
    fs.mkdirSync(local(join(ORIGINAL,"host-integration")),{recursive:true,mode:0o700});
    fs.writeFileSync(local(join(ORIGINAL,"host-integration/research-runtime-launch.mjs")),entry,{mode:0o644});
    const digest=files.researchArtifactDigest;
    vi.spyOn(files,"researchArtifactDigest").mockImplementation(path=>path===ORIGINAL?ORIGINAL_ARTIFACT:digest(path));
    host.legacyStoppedRoute=true;
    vi.mocked(artifact.assertQualifiedResearchRuntimeArtifact).mockImplementation((path,sha)=>{
      if(path===ORIGINAL)expect(sha).toBe(ORIGINAL_ARTIFACT);else {expect(path).toBe("/TEST-artifact");expect(digest(path)).toBe(sha);}
    });
    const current=await input.start(),historical=structuredClone(input.scope());
    expect(fs.readdirSync(local(join(current.directory,"providers")))).toEqual([]);
    expect(fs.existsSync(local(join(current.directory,"mimo-candidate.json")))).toBe(false);
    const identity={jobId:current.jobId,startId:current.startId,specSha256:current.specSha256,requestSha256:current.spec.requestSha256};
    let issuedProvider:string|undefined;
    if(reserveProvider) {
      // The immutable historical artifact is an explicit qualification port in
      // this offline fixture; all actual origin/factory/reservation logic runs.
      vi.spyOn(providerMaterial,"assertHostedMimoWorkerMaterial").mockImplementation((spec,directory)=>{
        expect(spec.runtimeDirectory).toBe(ORIGINAL);expect(spec.artifactSha256).toBe(ORIGINAL_ARTIFACT);expect(directory).toBe(current.directory);
      });
      host.group="/system.slice/"+current.unit;
      const home=join(current.spec.request.jobRootDir,"home/mimo-TEST/codex-home");fs.mkdirSync(local(home),{recursive:true,mode:0o700});
      files.researchPublish(join(current.directory,"mimo-home.json"),{schemaVersion:1,specSha256:current.specSha256,identity:files.researchDirectoryIdentity(home)});
      const child=admission.admitResearchProcessFactory(current.spec.request)({command:current.spec.request.codexBinaryPath,args:["app-server"],cwd:current.spec.request.workspacePath,env:{HOME:dirname(home),CODEX_HOME:home}});
      issuedProvider=fs.readdirSync(local(join(current.directory,"providers")))[0]!.slice(0,-5);
      for(const stream of [child.stdin,child.stdout,child.stderr])if(stream instanceof PassThrough)stream.destroy();
      host.group="/user.slice/TEST-operator.scope";
    }
    const scan=vi.spyOn(changes,"changedFilesFromWorkspace").mockResolvedValue({changedFiles:[]});
    vi.spyOn(materialization,"materializeReconciledTerminalCodexGoalHandoff").mockResolvedValue({handoff:null,artifacts:[],changedPaths:[],baseCommit:undefined});
    await cancelRegisteredResearchLaunch(identity);
    scan.mockRestore();
    if(issuedProvider) {
      const owner=JSON.parse(files.researchRead(join(current.directory,"binding.json")).toString());
      const group="/system.slice/"+issuedProvider;
      files.researchPublish(join(current.directory,"providers",issuedProvider+".owner.json"),{schemaVersion:1,
        process:{...owner.process,controlGroup:group},service:{...owner.service,unit:issuedProvider,controlGroup:group,
          description:`subscription-runtime-research-provider:${current.startId}:${issuedProvider}`}});
    }
    const progress=join(current.spec.request.jobRootDir,current.spec.request.taskId+".progress.json");
    fs.writeFileSync(local(progress),JSON.stringify({taskId:current.spec.request.taskId,status:"stopped",updatedAt:"2026-10-15T00:00:00Z"}),{mode:0o600});
    const stat=fs.lstatSync;
    vi.spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:fs.StatOptions)=>{
      if(String(path)===`/proc/${process.pid}`)throw Object.assign(Error("TEST original PID gone"),{code:"ENOENT"});
      return stat(path,options as fs.StatOptions & {bigint?:false});
    }) as typeof fs.lstatSync);
    host.legacyStoppedRoute=false;input.setScope({...historical,allowedAccountIds:[...historical.allowedAccountIds!,"TEST-account-tail"]});
    return {current,historical,identity,progress,issuedProvider};
  }
  describe("authenticated stopped-before-provider reservation release",()=>{
    it("releases only the reservation, preserves dirty source/stopped progress, and reads through current public writer",async()=>{
      const {current,historical,identity,progress}=await stopped();
      const dirty=join(current.spec.request.workspacePath,"TEST-existing-dirty.txt");
      const git=async(args:string[])=>await promisify(execFile)("git",["-C",current.spec.request.workspacePath,...args],{env:{PATH:process.env.PATH,
        GIT_AUTHOR_NAME:"iliya",GIT_AUTHOR_EMAIL:"iliyazelenkog@gmail.com",GIT_COMMITTER_NAME:"iliya",GIT_COMMITTER_EMAIL:"iliyazelenkog@gmail.com"}});
      await git(["init"]);fs.writeFileSync(dirty,"TEST baseline\n",{mode:0o600});await git(["add","TEST-existing-dirty.txt"]);
      for(const role of ["GIT_AUTHOR_IDENT","GIT_COMMITTER_IDENT"])expect((await git(["var",role])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
      await git(["commit","-m","test: seed stopped reservation workspace"]);fs.writeFileSync(dirty,"TEST preserved output debt\n",{mode:0o600});
      fs.chmodSync(local(current.spec.request.jobRootDir),0o701);
      const debt=async()=>{
        const m=current.manifest,workspaceDirty=(await changes.changedFilesFromWorkspace(m.workspacePath!,true)).changedFiles.length>0;
        const snapshot=await buildCodexProjectAdmissionSnapshot({registryRootDir:input.scope().registryRoot!,scope:input.scope(),deps:{
          listJobs:async()=>[{jobId:m.jobId,taskId:m.taskId,workspacePath:m.workspacePath!,promptPath:m.promptPath,accountNames:m.accounts,updatedAt:m.updatedAt,manifestPath:join(input.scope().registryRoot!,m.jobId,"job.json"),tags:[]}],
          readJob:async()=>m,prepareWriterObservation:prepareResearchJobWriterObservation,
          buildOverviewItems:async()=>[{ok:true,jobId:m.jobId,workspacePath:m.workspacePath,workspaceDirty,workerAlive:false,resultExists:false}],
        }});
        return snapshot.debt.filter(row=>row.reason===ProjectDebtReason.InactiveDirtyWorkspace);
      };
      const beforeDebt=await debt();expect(beforeDebt).toContainEqual(expect.objectContaining({severity:"blocking",subject:current.spec.request.workspacePath}));
      const rows=["spec.json","binding.json","closing.json"].map(name=>[join(current.directory,name),files.researchRead(join(current.directory,name))] as const);
      rows.push([progress,files.researchRead(progress,false)]);const calls=host.calls.length;
      expect(await releaseStoppedOwnedMimoWorkerBeforeProvider(identity,historical)).toEqual({jobId:current.jobId,startId:current.startId,reservationReleased:true});
      for(const [path,bytes] of rows)expect(files.researchRead(path,path!==progress)).toEqual(bytes);
      expect(fs.readFileSync(dirty,"utf8")).toBe("TEST preserved output debt\n");
      expect(fs.existsSync(local(join(current.directory,"mimo-candidate.json")))).toBe(false);
      expect(fs.existsSync(local(join(current.spec.request.jobRootDir,current.spec.request.taskId+".latest-result.json")))).toBe(false);
      expect(host.calls.slice(calls).some(call=>["stop","kill"].includes(call.args[0]??""))).toBe(false);
      const reader=await prepareResearchJobWriterObservation(current.manifest);expect(await reader()).toEqual({status:"released"});
      expect(await debt()).toEqual(beforeDebt);
      const providers=join(current.directory,"providers"),prior=join(current.directory,"TEST-prior-providers");
      fs.renameSync(providers,prior);fs.mkdirSync(providers,{mode:0o700});
      expect(await reader()).toEqual({status:"unknown"});fs.rmdirSync(providers);fs.renameSync(prior,providers);
      expect(await reader()).toEqual({status:"released"});
      fs.appendFileSync(local(progress)," ");expect(await reader()).toEqual({status:"unknown"});
    });
    it.each(["scope","permission","live","queued","candidate","new-start","provider-symlink","route-entry","result"] as const)("refuses %s without a complete release receipt",async fault=>{
      const {current,historical,identity}=await stopped();
      if(fault==="permission")input.setScope({...input.scope(),workspaceRoots:[]});
      if(fault==="live")host.units.get(current.unit)!.active=true;
      if(fault==="queued")host.jobs.add(current.unit);
      if(fault==="candidate")files.researchPublish(join(current.directory,"mimo-candidate.json"),{invalid:true});
      if(fault==="route-entry")fs.appendFileSync(local(join(ORIGINAL,"host-integration/research-runtime-launch.mjs")),"\nTEST drift");
      if(fault==="result")files.researchPublish(join(current.spec.request.jobRootDir,current.spec.request.taskId+".latest-result.json"),{status:"failed"});
      if(fault==="new-start")files.researchPublish(join(admission.researchJobAuthority(current.jobId),"active.json"),{schemaVersion:1,startId:current.startId,specSha256:current.specSha256});
      if(fault==="provider-symlink") {
        const providers=join(current.directory,"providers"),prior=join(current.directory,"TEST-prior-providers");
        fs.renameSync(providers,prior);fs.symlinkSync(local(prior),providers);
      }
      await expect(releaseStoppedOwnedMimoWorkerBeforeProvider(identity,fault==="scope"?{...historical,allowedAccountIds:["TEST-wrong"]}:historical)).rejects.toThrow();
      expect(fs.existsSync(local(join(current.directory,"stopped-before-provider-release.json")))).toBe(false);
    });
    it("refuses a genuinely issued retained provider reservation even after cold owner closure",async()=>{
      const {current,historical,identity,issuedProvider}=await stopped(true);
      expect(issuedProvider).toMatch(/^subscription-runtime-research-provider-/);
      expect(fs.existsSync(local(join(current.directory,"providers",issuedProvider+".json")))).toBe(true);
      await expect(releaseStoppedOwnedMimoWorkerBeforeProvider(identity,historical)).rejects.toThrow();
      expect(fs.existsSync(local(join(current.directory,"stopped-before-provider-release.json")))).toBe(false);
    });
    it("refuses an orphan receipt without creating its missing intent",async()=>{
      const {current,historical,identity}=await stopped();
      files.researchPublish(join(current.directory,"stopped-before-provider-release.json"),{schemaVersion:1,kind:"stopped-before-provider",intentSha256:"0".repeat(64)});
      await expect(releaseStoppedOwnedMimoWorkerBeforeProvider(identity,historical)).rejects.toThrow();
      expect(fs.existsSync(local(join(admission.researchJobAuthority(current.jobId),"stopped-before-provider-release-intent.json")))).toBe(false);
      expect(await(await prepareResearchJobWriterObservation(current.manifest))()).toEqual({status:"unknown"});
    });
    it("retains Unknown after receipt-rename crash and completes only the same intent",async()=>{
      const {current,historical,identity}=await stopped(),rename=fs.renameSync;
      const receipt=join(current.directory,"stopped-before-provider-release.json");
      const fail=vi.spyOn(fs,"renameSync").mockImplementation((a,b)=>{if(String(b)===receipt)throw Error("TEST receipt crash");return rename(a,b);});
      await expect(releaseStoppedOwnedMimoWorkerBeforeProvider(identity,historical)).rejects.toThrow("TEST receipt crash");
      expect(await (await prepareResearchJobWriterObservation(current.manifest))()).toEqual({status:"unknown"});
      const intent=files.researchRead(join(admission.researchJobAuthority(current.jobId),"stopped-before-provider-release-intent.json"));fail.mockRestore();
      await releaseStoppedOwnedMimoWorkerBeforeProvider(identity,historical);
      expect(files.researchRead(join(admission.researchJobAuthority(current.jobId),"stopped-before-provider-release-intent.json"))).toEqual(intent);
      const reader=await prepareResearchJobWriterObservation(current.manifest);expect(await reader()).toEqual({status:"released"});
      const unit="subscription-runtime-research-provider-11111111-1111-4111-8111-111111111111.service";
      files.researchPublish(join(current.directory,"providers",unit+".json"),{schemaVersion:1,unit,runtimeUnit:current.unit,specSha256:current.specSha256,description:`subscription-runtime-research-provider:${current.startId}:${unit}`});
      expect(await reader()).toEqual({status:"unknown"});
    });
  });
}
