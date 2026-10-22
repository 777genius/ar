import { matchFullBackingStorageMountData } from "./hosted-full-backing-mount-data";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, existsSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from "node:fs";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { assertFullParentProcFiles, fullProcBirth, fullRetainedFilesystemType } from "./hosted-full-backing-proc";
import { live, hash, encoded, check, object, procIdentity, protectedJson, originalPair,
  readOriginalHostedDependencyBackingStage } from "./hosted-full-backing-stage";
export { FullBackingInstallationContract, readOriginalHostedDependencyBackingStage,
  assertOriginalFullBackingPreparation, type FullBackingStage } from "./hosted-full-backing-stage";

function freshHostPulse(fence:HostedActivationFence,current:ReturnType<typeof originalPair>,backingBytes:Buffer):void {
  const nonce=randomUUID(),requestPath="/run/TEST-full-flow-outbox/current-full-pulses/"+nonce+".json";
  const request=encoded({schemaVersion:1,nonce,parentInvocationId:current.pair.parentInvocationId,pairSha256:hash(current.pairFile.bytes),invocationSealSha256:hash(current.invocationFile.bytes),backingSha256:hash(backingBytes)});
  const directory=lstatSync("/run/TEST-full-flow-outbox/current-full-pulses");check(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid===0 && directory.gid===0 && (directory.mode&0o7777)===0o700);
  assertHostedActivationFence(fence);assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);
  const pending=requestPath.slice(0,requestPath.lastIndexOf("/"))+"/.pending-"+nonce;
  const fd=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,request);fsyncSync(fd);}finally{closeSync(fd);}linkSync(pending,requestPath);unlinkSync(pending);
  const responsePath=live+"/seals/current-full-pulse-"+nonce+".json",deadline=process.hrtime.bigint()+30000000000n;
  while(!existsSync(responsePath) || lstatSync(responsePath).nlink!==1){
    check(process.hrtime.bigint()<deadline);assertHostedActivationFence(fence);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  const bytes=protectedJson(responsePath),response=object(bytes.value,"schemaVersion,nonce,requestSha256,pairSha256,invocationSealSha256,backingSha256,factsSha256");
  check(response.schemaVersion===1 && response.nonce===nonce && response.requestSha256===hash(request) && response.pairSha256===hash(current.pairFile.bytes) && response.invocationSealSha256===hash(current.invocationFile.bytes) && response.backingSha256===hash(backingBytes) && typeof response.factsSha256==="string" && /^[a-f0-9]{64}$/.test(response.factsSha256));
  assertHostedActivationFence(fence);assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);
}
/** Private conjunct under the ORIGINAL activation fence. The seal is produced
 * once by the actual parent collector; it is not a REVIEW, lease or grant.
 * Dead original proc objects revoke the interval, including on PID reuse. */
export function assertOriginalHostedDependencyFullBackingInterval(fence: HostedActivationFence, access: symbol): void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const stage=readOriginalHostedDependencyBackingStage();if(stage.schemaVersion===1)return;
  const current=originalPair();check(current.pair.sourceSha===stage.runtimeSha);
  const file=protectedJson(live+"/seals/current-full-backing.json"),row=object(file.value,"schemaVersion,pairSha256,invocationSealSha256,guest,image,storageMount,storageIdentity,loopRdev,factsSha256");
  check(row.schemaVersion===1 && row.pairSha256===hash(current.pairFile.bytes) && row.invocationSealSha256===hash(current.invocationFile.bytes));
  const guest=object(row.guest,"pid,birth,invocationId,group,rootDev,rootIno,mnt,pidNamespace,listenerInode,socketDev,socketIno");
  check(guest.rootDev===current.pair.rootDev && guest.rootIno===current.pair.rootIno && guest.invocationId===current.invocation.guestInvocationId &&
    guest.mnt===readlinkSync("/proc/1/ns/mnt") && guest.pidNamespace===readlinkSync("/proc/1/ns/pid"));
  check(fullProcBirth(readFileSync("/proc/1/stat","utf8")).startTicks===guest.birth);
  const storage=matchFullBackingStorageMountData(row.storageMount,readFileSync("/proc/self/mountinfo","utf8"));
  // Mount IDs differ in cloned service namespaces. Rejoin the actual named
  // storage FD/device/inode against this namespace's unique mount instead.
  const target=procIdentity(row.storageIdentity),storageFd=openSync(String(storage.point),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const s=fstatSync(storageFd,{bigint:true}),named=lstatSync(String(storage.point),{bigint:true});check(String(s.dev)===target.dev && String(s.ino)===target.ino && s.dev===named.dev && s.ino===named.ino && fullRetainedFilesystemType(storageFd)===0xef53n);
    const info=readFileSync(`/proc/self/fdinfo/${storageFd}`,"utf8");check(/^mnt_id:\s+([1-9][0-9]*)$/m.exec(info)?.[1]===storage.mountId);
  }finally{closeSync(storageFd);}
  check(protectedJson(live+"/seals/current-full-backing.json").bytes.equals(file.bytes) && protectedJson(live+"/seals/current-full-pair.json").bytes.equals(current.pairFile.bytes) && protectedJson(live+"/seals/current-full-pair-invocation.json").bytes.equals(current.invocationFile.bytes));
  freshHostPulse(fence,current,file.bytes);
  assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);assertHostedActivationFence(fence);
}
