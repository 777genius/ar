import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, markDependencyConsumerRunning, DependencyAdmissionError, DependencyAdmissionFailure,
  DependencyOwnerPhase, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind, DependencyInstallKeyError, DependencyInstallKeyFailure } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "../hosted-dependency-workspace";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import * as workspace from "../hosted-dependency-workspace";
import * as capture from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { NpmInputCaptureStatus, NpmInputCaptureReason } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { beginHostedDependencyInstallation, HostedDependencyInputCaptureError } from "../hosted-dependency-materialization-context";
import { prepareHostedManifestScratchTestFixture } from "./hosted-manifest-placement-installation-test-support";
import { projectCapturePath, retainCapturePath } from "./hosted-materialization-capture-test-projection";
import { materializeHostedDependencyAbsence } from "../hosted-dependency-materialization";
import { HostedDependencyInstaller } from "../hosted-dependency-installer";
import * as installerRecipe from "../hosted-dependency-installer-recipe";
import { HostedDependencyInstallerRevision, type HostedDependencyInstallerProfile } from "../hosted-dependency-installer-recipe";
import * as receipts from "../hosted-dependency-receipts";
import type { HostedOrdinaryStart, HostedOrdinaryReservation } from "../../worker-core/hosted-custody/domain/hosted-installation-activation";

function profile(): HostedDependencyInstallerProfile {
  return { schemaVersion: 1, recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127",
    platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    npmSha256: "b".repeat(64), npmVersion: "10.9.3", npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
    libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
    toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
    networkInputs: { hosts: "e".repeat(64), "resolv.conf": "f".repeat(64), "nsswitch.conf": "e".repeat(64) },
    privilegeDropper: { path: "/usr/bin/setpriv", sha256: "f".repeat(64), version: "2.39.3",
      libraries: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }] } };
}


/** Registers in the real ordinary installation fixture. Only filesystem/kernel
 * facts are projected; the actual fence, sole original-origin collector, owner
 * reader, byte capture and protected owner/receipt transport stay production. */
export function registerMaterializationAttemptTest(input: {
  prepared: () => { binding: HostedDependencyBinding; retained: { start: HostedOrdinaryStart; reservation: HostedOrdinaryReservation } };
  local: (path: string) => string;
  fixture: { boot: string; manifestMountInfo: string; captureAncestry: boolean; captureDirectories: Map<number, string> };
}): void {
  describe.skipIf(process.platform !== "linux")("materialization attempt after async input capture", () => {
    it("five concurrent same-key owner claims finish one real cold materialization and return four Busy", async () => {
      // Real shared-core owner CAS plus original generic materializer. Core
      // Running is owner state, not permission for public/current task execution.
      // Only the installer boundary/profile and OS facts are synthetic; genuine
      // current-C admission/Absent restore/Running/hot reuse remain separate.
      // Configure storage BEFORE install so the original hook issues placement.
      // Never synthesize a placement or Ready receipt after installation.
      await prepareHostedManifestScratchTestFixture({ fixture:input.fixture,manifestScratch:"/mnt/TEST-private-manifests",local:input.local,
        put:(name,value)=>writeFileSync(input.local(join("/var/lib/subscription-runtime-host-policy",name)),JSON.stringify(value)+"\n",{mode:0o600}) },true);
      const p = input.prepared(), binding = p.binding, path = binding.workspace.canonicalPath;
      // Missing attempt records mean no installer only under an initialized
      // private namespace; the mocked installer launches no actual child.
      mkdirSync(input.local(installerRecipe.hostedDependencyInstallerRoot),{recursive:true,mode:0o700});
      expect(readdirSync(input.local(installerRecipe.hostedDependencyInstallerRoot))).toEqual([]);
      const packageBytes = Buffer.from(JSON.stringify({ name: "five-cold-TEST", version: "1.0.0" }));
      const lockBytes = Buffer.from(JSON.stringify({ name: "five-cold-TEST", version: "1.0.0", lockfileVersion: 3,
        packages: { "": { name: "five-cold-TEST", version: "1.0.0" } } }));
      writeFileSync(input.local(join(path,"package.json")),packageBytes,{mode:0o600});
      writeFileSync(input.local(join(path,"package-lock.json")),lockBytes,{mode:0o600});
      const sentinelPath=input.local(join(path,"TEST-concurrent-source"));writeFileSync(sentinelPath,"preserved original source\n",{mode:0o600});
      const absencePath=`/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`;
      mkdirSync(input.local(dirname(absencePath)),{recursive:true,mode:0o700});
      const absenceBytes=Buffer.from(JSON.stringify({version:1,workspace:binding.workspace,coverageRevision:receipts.dependencyCoverageRevision(binding)})+"\n");
      writeFileSync(input.local(absencePath),absenceBytes,{mode:0o600});
      vi.spyOn(installerRecipe,"readHostedDependencyInstallerProfile").mockImplementation(() => profile());
      const {DependencyReceiptState}=await import("../../worker-core/dependency-environment/domain/dependency-receipt");
      const {qualifyHostedDependencyInstallerInputs,HostedDependencyInstallerRecipe}=await import("../hosted-dependency-installer-inputs");
      const realFs=await vi.importActual<typeof import("node:fs")>("node:fs");
      // The outer fixture already projects root UID/GID. Keep the privileged
      // ownership syscall at that same boundary, never chown a runner's file
      // to host root; inventory/modes/bytes and Ready publication stay real.
      const projectedFs=await import("node:fs");
      // Async capture already projects this same logical ancestry. Its sync
      // revalidator must reopen those actual files through the same transport,
      // rather than walking the fixture root's unrelated physical layout.
      const fixtureOpen=projectedFs.openSync,fixtureLstat=projectedFs.lstatSync,
        fixtureRename=projectedFs.renameSync,fixtureClose=projectedFs.closeSync;
      const transport={captureAncestry:true,captureDirectories:new Map<number,string>()};
      const rawFd=(path:unknown):path is Buffer=>Buffer.isBuffer(path) &&
        /^\/proc\/self\/fd\/[0-9]+\//.test(path.subarray(0,64).toString("ascii"));
      const logical=(path:Parameters<typeof fixtureOpen>[0]):string|undefined=>{
        if(typeof path==="string")return path;
        if(!rawFd(path))return undefined;
        const text=path.toString("utf8");return Buffer.from(text).equals(path)?text:undefined;
      };
      const projected=(path:Parameters<typeof fixtureOpen>[0])=>{
        const text=logical(path);if(text===undefined)return path;
        const mapped=projectCapturePath(text,transport,input.local,"/mnt/TEST-private-manifests");
        return mapped===text?path:mapped;
      };
      const retain=(fd:number,path:Parameters<typeof fixtureOpen>[0])=>{
        const text=logical(path);if(text!==undefined)retainCapturePath(fd,text,transport);
      };
      const opened=vi.spyOn(projectedFs,"openSync").mockImplementation((path,flags,mode)=>{
        const mapped=projected(path),fd=rawFd(mapped)?realFs.openSync(mapped,flags,mode):fixtureOpen(mapped,flags,mode);
        retain(fd,path);return fd;
      });
      const named=vi.spyOn(projectedFs,"lstatSync").mockImplementation(((path,options)=>{
        const mapped=projected(path);if(!rawFd(mapped))return fixtureLstat(mapped,options);
        const stat=realFs.lstatSync(mapped,options);
        return stat===undefined?undefined:Object.assign(stat,{uid:options?.bigint?0n:0,gid:options?.bigint?0n:0});
      }) as typeof fixtureLstat);
      const renamed=vi.spyOn(projectedFs,"renameSync").mockImplementation((from,to)=>{
        if(rawFd(from)&&rawFd(to))realFs.renameSync(from,to);else fixtureRename(from,to);
      });
      const closed=vi.spyOn(projectedFs,"closeSync").mockImplementation(fd=>{
        try {return fixtureClose(fd);}finally {transport.captureDirectories.delete(fd);}
      });
      // Observer ancestry is Buffer-based; capture ancestry is string-based.
      // Both reopen actual mapped files; non-UTF8 names stay raw FD paths.
      const asyncFs=await import("node:fs/promises"),fixtureAsyncOpen=asyncFs.open,fixtureAsyncLstat=asyncFs.lstat;
      const asyncOpened=vi.spyOn(asyncFs,"open").mockImplementation(async(path,flags,mode)=>{
        const handle=await fixtureAsyncOpen(projected(path),flags,mode),fd=handle.fd,close=handle.close.bind(handle);
        retain(fd,path);handle.close=(async()=>{try {await close();}finally {transport.captureDirectories.delete(fd);}}) as typeof handle.close;
        return handle;
      });
      const asyncNamed=vi.spyOn(asyncFs,"lstat").mockImplementation(((path,options)=>
        fixtureAsyncLstat(projected(path),options)) as typeof fixtureAsyncLstat);
      vi.spyOn(projectedFs,"fchownSync").mockImplementation((fd,uid,gid)=>{
        expect([uid,gid]).toEqual([0,0]);
        expect(realFs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(input.local("/var/lib/subscription-runtime-host-policy/TEST-concurrent-installer-output")+"/")).toBe(true);
        const stat=realFs.fstatSync(fd);realFs.fchownSync(fd,stat.uid,stat.gid);
      });
      let enterInstaller!:()=>void,finishInstaller!:()=>void;
      let installerPhase:"not_entered"|"recipe"|"workspace"|"package"|"lock"|"waiting"|"output"="not_entered";
      const entered=new Promise<void>(resolve=>{enterInstaller=resolve;}),finish=new Promise<void>(resolve=>{finishInstaller=resolve;});
      const install=vi.spyOn(HostedDependencyInstaller.prototype,"install").mockImplementation(async request=>{
        installerPhase="recipe";if(!("packageBytes" in request))throw new Error("TEST unexpected local installer recipe");
        installerPhase="workspace";expect(request.workspace).toEqual(binding.workspace);
        installerPhase="package";expect(request.packageBytes).toEqual(packageBytes);
        installerPhase="lock";expect(request.lockBytes).toEqual(lockBytes);
        installerPhase="waiting";enterInstaller();await finish;installerPhase="output";
        const stage=input.local("/var/lib/subscription-runtime-host-policy/TEST-concurrent-installer-output"),tree=join(stage,"node_modules");
        realFs.mkdirSync(tree,{recursive:true,mode:0o700});realFs.writeFileSync(join(tree,"module.js"),"module.exports = 'one install';\n",{mode:0o600});
        const stat=realFs.lstatSync(tree,{bigint:true}),qualified=qualifyHostedDependencyInstallerInputs(packageBytes,lockBytes);
        const startId=randomUUID();return {recipe:HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1,lockName:qualified.lockName,
          startId,unit:`subscription-runtime-installer-${startId}.service`,inputSha256:qualified.sha256,profileSha256:"a".repeat(64),completionSha256:"b".repeat(64),
          output:{canonicalPath:tree,dev:String(stat.dev),ino:String(stat.ino)}};
      });
      // Pass through the original capture unchanged. Retain only its finite
      // result so a rejected setup cannot hide behind the barrier error.
      const captureFacts: { status: NpmInputCaptureStatus; reason?: NpmInputCaptureReason }[]=[];
      const realCapture=capture.captureNpmInstallInputs;
      vi.spyOn(capture,"captureNpmInstallInputs").mockImplementation(async request=>{
        const result=await realCapture(request);
        if(captureFacts.length<8)captureFacts.push(result.status===NpmInputCaptureStatus.Qualified ?
          {status:result.status}:{status:result.status,reason:result.reason});
        return result;
      });
      const readOwner=()=>{const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});try{return store.read(binding.workspace);}finally{store.close();}};
      const refused:unknown[]=[];let release!:()=>void;
      const start=new Promise<void>(resolve=>{release=resolve;});
      const withOwners=<T>(action:(store:LocalDependencyOwnerStore)=>T)=>withHostedActivationFence(()=>{
        const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
        try {return action(store);}finally {store.close();}
      });
      const materialize=async()=>{
        // Immutable installation/start/reservation came from original fixture
        // enrollment. The real materializer reauthenticates origin and owner.
        const attempt=withOwners(store=>claimDependencyConsumer(store,binding.workspace,{
          installationId:binding.installationId,bootId:p.retained.start.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,
          startId:p.retained.reservation.startId,unit:p.retained.reservation.unit},randomUUID()));
        await materializeHostedDependencyAbsence(binding,attempt);
        withOwners(store=>markDependencyConsumerRunning(store,binding.workspace,attempt));
        return attempt;
      };
      input.fixture.captureAncestry=true;
      const calls=Array.from({length:5},()=>start.then(materialize)
        .catch(error=>{refused.push(error);throw error;}));
      // Attach all rejection handlers before any admission starts.
      const completed=Promise.allSettled(calls);release();
      const failureFacts=(error:unknown)=>{
        // Never serialize unknown messages, paths or stacks. Source sites are
        // restricted to these reviewed production files plus numeric offsets.
        const sites=error instanceof Error ? [...(error.stack??"").slice(0,16384).matchAll(
          /\/(hosted-(?:dependency-admission|current-dependency-origin|dependency-current-facts|dependency-materialization(?:-context)?|dependency-local-materialization|dependency-staged-output)\.ts):(\d{1,6}):(\d{1,6})/g)]
          .slice(0,4).map(match=>({file:match[1],line:Number(match[2]),column:Number(match[3])})):[];
        if(error instanceof HostedDependencyInputCaptureError)return {kind:"input_capture",reason:error.reason,
          capture:{status:error.captureFailure.status,reason:error.captureFailure.reason},sites};
        if(error instanceof DependencyAdmissionError)return {kind:"admission",reason:
          Object.values(DependencyAdmissionFailure).includes(error.reason)?error.reason:"unknown",sites};
        if(error instanceof DependencyInstallKeyError)return {kind:"install_key",reason:
          Object.values(DependencyInstallKeyFailure).includes(error.reason)?error.reason:"unknown",sites};
        return {kind:error instanceof Error && error.message==="hosted_dependency_current_origin_unresolved" ?
          "current_origin_unresolved":"unknown",sites};
      };
      const diagnostic=()=>{
        let ownerPhase:DependencyOwnerPhase|"none"|"unreadable"="unreadable";
        let receiptState:(typeof DependencyReceiptState)[keyof typeof DependencyReceiptState]|"none"|"unreadable"="unreadable";
        try {ownerPhase=readOwner()?.owner?.phase??"none";}catch{/* Preserve the primary failure. */}
        try {receiptState=receipts.readHostedDependencyReceipt(binding)?.state??"none";}catch{/* Preserve the primary failure. */}
        return {installerCalls:install.mock.calls.length,installerPhase,refused:refused.slice(0,5).map(failureFacts),captureFacts,ownerPhase,receiptState};
      };
      try {
        await Promise.race([entered,completed.then(()=>{throw new Error("TEST owner/materializer operations ended before selected installer "+JSON.stringify(diagnostic()));})]);
        await expect.poll(()=>refused.length).toBe(4);
        expect(refused.every(error=>error instanceof DependencyAdmissionError && error.reason===DependencyAdmissionFailure.Busy)).toBe(true);
        expect(install).toHaveBeenCalledTimes(1);
        const held=readOwner();expect(held?.owner).toMatchObject({phase:DependencyOwnerPhase.ExclusiveMutation});
        const installing=receipts.readHostedDependencyReceipt(binding);expect(installing?.state).toBe(DependencyReceiptState.Installing);
        expect(existsSync(input.local(join(path,"node_modules")))).toBe(false);
        finishInstaller();const results=await completed;
        expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);
        expect(results.filter(row=>row.status==="rejected")).toHaveLength(4);expect(install).toHaveBeenCalledTimes(1);
        const ready=receipts.readHostedDependencyReceipt(binding);expect(ready?.state).toBe(DependencyReceiptState.Ready);
        if(ready?.state!==DependencyReceiptState.Ready || installing?.state!==DependencyReceiptState.Installing)throw new Error("TEST production Ready was not published");
        expect(ready.installKey).toBe(installing.requestedKey);expect(ready.generation).toBe(installing.generation);
        expect(ready.revision).toBe(installing.revision+1);expect(ready.provenance.kind).toBe("completed_install");
        const winner=results.find(row=>row.status==="fulfilled");expect(winner?.value.attemptId).toBe(ready.generation);
        expect(readOwner()?.owner).toMatchObject({phase:DependencyOwnerPhase.Running,attempt:{attemptId:ready.generation}});
        expect(readFileSync(input.local(join(path,"node_modules/module.js")),"utf8")).toBe("module.exports = 'one install';\n");
        expect(readFileSync(sentinelPath,"utf8")).toBe("preserved original source\n");expect(readFileSync(input.local(absencePath))).toEqual(absenceBytes);
      } catch(error) {
        // Subsequent assertion/materialization failures need the same finite
        // phase facts, while Vitest retains the original exception as primary.
        console.error("TEST_CONCURRENT_ADMISSION_FACTS "+JSON.stringify(diagnostic()));throw error;
      } finally {finishInstaller();await completed;asyncNamed.mockRestore();asyncOpened.mockRestore();closed.mockRestore();renamed.mockRestore();named.mockRestore();opened.mockRestore();transport.captureDirectories.clear();input.fixture.captureAncestry=false;input.fixture.captureDirectories.clear();}
    });
    it("rejects a replaced same-launch owner before Installing publication or installer launch", async () => {
      // Red if the final current-owner join accepts only launch identity: a
      // replacement owner has the same launch and a different epoch/attempt.
      const p = input.prepared(), binding = p.binding, path = binding.workspace.canonicalPath;
      const pkg = { name: "attempt-replacement-TEST", version: "1.0.0" };
      const packageBytes = Buffer.from(JSON.stringify(pkg));
      const lockBytes = Buffer.from(JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
      const sentinelBytes = Buffer.from("TEST original source bytes");
      for (const [name, bytes] of [["package.json",packageBytes],["package-lock.json",lockBytes],["TEST-source-sentinel",sentinelBytes]] as const)
        writeFileSync(input.local(join(path,name)),bytes,{mode:0o600});
      const absencePath = `/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`;
      const absenceBytes = Buffer.from(JSON.stringify({version:1,workspace:binding.workspace,coverageRevision:receipts.dependencyCoverageRevision(binding)})+"\n");
      mkdirSync(input.local(dirname(absencePath)),{recursive:true,mode:0o700});
      writeFileSync(input.local(absencePath),absenceBytes,{mode:0o600});
      let attempt!: DependencyAttempt, replacement: DependencyAttempt | undefined;
      const mutateOwner = (action: (owners: LocalDependencyOwnerStore) => void) => withHostedActivationFence(() => {
        const owners = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
        try { action(owners); } finally { owners.close(); }
      });
      mutateOwner(owners => { attempt = claimDependencyConsumer(owners,binding.workspace,{
        installationId:binding.installationId,bootId:p.retained.start.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,
        startId:p.retained.reservation.startId,unit:p.retained.reservation.unit},randomUUID()); });
      const realCapture = capture.captureNpmInstallInputs, statuses: NpmInputCaptureStatus[] = [];
      vi.spyOn(capture,"captureNpmInstallInputs").mockImplementationOnce(async request => {
        input.fixture.captureAncestry = true;
        let captured: Awaited<ReturnType<typeof realCapture>>;
        try { captured = await realCapture(request); }
        finally { input.fixture.captureAncestry = false; input.fixture.captureDirectories.clear(); }
        statuses.push(captured.status);
        mutateOwner(owners => {
          fenceDependencyConsumer(owners,binding.workspace,attempt);
          const fenced = owners.read(binding.workspace);
          if (!fenced || fenced.owner?.phase !== DependencyOwnerPhase.Fenced) throw new Error("TEST owner not fenced");
          owners.compareAndSwap(binding.workspace,fenced.revision,{...fenced,revision:fenced.revision+1,owner:null});
          replacement = claimDependencyConsumer(owners,binding.workspace,attempt.launch,randomUUID());
        });
        return captured;
      });
      // Pure key inputs only. No installer runs and no profile grants an origin.
      vi.spyOn(installerRecipe,"readHostedDependencyInstallerProfile").mockImplementation(() => profile());
      const observed = vi.spyOn(workspace,"readHostedDependencyAttempt");
      const publish = vi.spyOn(receipts,"publishHostedDependencyReceipt");
      const install = vi.spyOn(HostedDependencyInstaller.prototype,"install").mockRejectedValue(new Error("TEST unexpected installer launch"));
      const materialization = beginHostedDependencyInstallation(binding,attempt);
      await expect(materialization).rejects.toBeInstanceOf(DependencyAdmissionError);
      await expect(materialization).rejects.toMatchObject({reason:DependencyAdmissionFailure.StaleAttempt});
      expect(statuses).toEqual([NpmInputCaptureStatus.Qualified]);
      expect(replacement?.launch).toEqual(attempt.launch);
      expect(replacement?.attemptId).not.toBe(attempt.attemptId); expect(replacement?.epoch).toBe(attempt.epoch+1);
      expect(observed).toHaveReturnedWith(attempt); expect(observed).toHaveReturnedWith(replacement);
      expect(publish).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
      expect(receipts.readHostedDependencyReceipt(binding)).toBeNull();
      const historyRoot = input.local(receipts.hostedDependencyReceiptHistoryRoot);
      expect(existsSync(historyRoot) ? readdirSync(historyRoot) : []).toEqual([]);
      mutateOwner(owners => expect(owners.read(binding.workspace)?.owner).toMatchObject({phase:DependencyOwnerPhase.ExclusiveMutation,attempt:replacement}));
      for (const [name,bytes] of [["package.json",packageBytes],["package-lock.json",lockBytes],["TEST-source-sentinel",sentinelBytes]] as const)
        expect(readFileSync(input.local(join(path,name)))).toEqual(bytes);
      expect(readFileSync(input.local(absencePath))).toEqual(absenceBytes);
    });
  });
}
