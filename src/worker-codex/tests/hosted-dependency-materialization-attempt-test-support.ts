import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimDependencyConsumer, fenceDependencyConsumer, DependencyAdmissionError, DependencyAdmissionFailure,
  DependencyOwnerPhase, type DependencyAttempt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { LocalDependencyOwnerStore } from "../../store-local-file/dependency-environment/local-dependency-owner-store";
import { hostedDependencyOwnerRoot, type HostedDependencyBinding } from "../hosted-dependency-workspace";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import * as workspace from "../hosted-dependency-workspace";
import * as capture from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { beginHostedDependencyInstallation } from "../hosted-dependency-materialization-context";
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
  fixture: { captureAncestry: boolean; captureDirectories: Map<number, string> };
}): void {
  describe.skipIf(process.platform !== "linux")("materialization attempt after async input capture", () => {
    it("five concurrent same-key cold admissions publish one Ready and refuse four before another installer", async () => {
      // Real ordinary-origin admission, owner/receipt CAS and materializer.
      // Only the selected installer boundary/profile is synthetic: no child or
      // current-v2/native qualification is claimed by this v1 adapter fixture.
      const p = input.prepared(), binding = p.binding, path = binding.workspace.canonicalPath;
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
      const {admitHostedDependencyConsumer}=await import("../hosted-dependency-admission");
      const {DependencyReceiptState}=await import("../../worker-core/dependency-environment/domain/dependency-receipt");
      const {qualifyHostedDependencyInstallerInputs,HostedDependencyInstallerRecipe}=await import("../hosted-dependency-installer-inputs");
      const realFs=await vi.importActual<typeof import("node:fs")>("node:fs");
      // The outer fixture already projects root UID/GID. Keep the privileged
      // ownership syscall at that same boundary, never chown a runner's file
      // to host root; inventory/modes/bytes and Ready publication stay real.
      const projectedFs=await import("node:fs");
      vi.spyOn(projectedFs,"fchownSync").mockImplementation((fd,uid,gid)=>{
        expect([uid,gid]).toEqual([0,0]);
        expect(realFs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(input.local("/var/lib/subscription-runtime-host-policy/TEST-concurrent-installer-output")+"/")).toBe(true);
        const stat=realFs.fstatSync(fd);realFs.fchownSync(fd,stat.uid,stat.gid);
      });
      let enterInstaller!:()=>void,finishInstaller!:()=>void;
      const entered=new Promise<void>(resolve=>{enterInstaller=resolve;}),finish=new Promise<void>(resolve=>{finishInstaller=resolve;});
      const install=vi.spyOn(HostedDependencyInstaller.prototype,"install").mockImplementation(async request=>{
        if(!("packageBytes" in request))throw new Error("TEST unexpected local installer recipe");
        expect(request.workspace).toEqual(binding.workspace);expect(request.packageBytes).toEqual(packageBytes);expect(request.lockBytes).toEqual(lockBytes);
        enterInstaller();await finish;
        const stage=input.local("/var/lib/subscription-runtime-host-policy/TEST-concurrent-installer-output"),tree=join(stage,"node_modules");
        realFs.mkdirSync(tree,{recursive:true,mode:0o700});realFs.writeFileSync(join(tree,"module.js"),"module.exports = 'one install';\n",{mode:0o600});
        const stat=realFs.lstatSync(tree,{bigint:true}),qualified=qualifyHostedDependencyInstallerInputs(packageBytes,lockBytes);
        const startId=randomUUID();return {recipe:HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1,lockName:qualified.lockName,
          startId,unit:`subscription-runtime-installer-${startId}.service`,inputSha256:qualified.sha256,profileSha256:"a".repeat(64),completionSha256:"b".repeat(64),
          output:{canonicalPath:tree,dev:String(stat.dev),ino:String(stat.ino)}};
      });
      const readOwner=()=>{const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});try{return store.read(binding.workspace);}finally{store.close();}};
      const refused:unknown[]=[];let release!:()=>void;
      const start=new Promise<void>(resolve=>{release=resolve;});
      const config={taskId:binding.jobId,jobId:binding.jobId,jobRootDir:binding.jobRootDir,workspacePath:path};
      input.fixture.captureAncestry=true;
      const calls=Array.from({length:5},()=>start.then(()=>admitHostedDependencyConsumer(config as Parameters<typeof admitHostedDependencyConsumer>[0]))
        .catch(error=>{refused.push(error);throw error;}));
      // Attach all rejection handlers before any admission starts.
      const completed=Promise.allSettled(calls);release();
      try {
        await Promise.race([entered,completed.then(()=>{throw new Error("TEST admissions ended before selected installer");})]);
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
        expect(readOwner()?.owner).toMatchObject({phase:DependencyOwnerPhase.Running,attempt:{attemptId:ready.generation}});
        expect(readFileSync(input.local(join(path,"node_modules/module.js")),"utf8")).toBe("module.exports = 'one install';\n");
        expect(readFileSync(sentinelPath,"utf8")).toBe("preserved original source\n");expect(readFileSync(input.local(absencePath))).toEqual(absenceBytes);
      } finally {finishInstaller();await completed;input.fixture.captureAncestry=false;input.fixture.captureDirectories.clear();}
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
