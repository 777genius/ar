/** Read-only binary/member equality DATA. Genuine signed acquisition and the
 * original decoder/tool custody remain the caller's responsibility. Neither a
 * matching file nor this record authenticates compiler inputs or grants a slot. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fstatSync,readSync,type BigIntStats} from "node:fs";
import {readFixedGnuBasicMembers,FixedGnuMemberKind} from "./current-h1-archive-members-TEST.ts";
import type {inspectRetainedOriginalDebFsys} from "./current-h1-archive-format-census.ts";
import type {retainOriginalAcquiredArchive} from "./current-h1-tool-inputs-package.ts";
import type {H1SourceSelection} from "./current-h1-source-record-TEST.ts";

export enum H1RetainedMemberRole {HostNspawn="host_nspawn",HostLoader="host_loader",HostSharedObject="host_shared_object",StagedPython="staged_python",StagedSharedObject="staged_shared_object"}
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String);
interface Input {
 readonly role:H1RetainedMemberRole;
 readonly selection:H1SourceSelection;
 readonly original:ReturnType<typeof retainOriginalAcquiredArchive>;
 readonly decoded:Awaited<ReturnType<typeof inspectRetainedOriginalDebFsys>>;
 readonly memberPath:string;
 /** Already retained by the original parent; no caller pathname is opened. */
 readonly fileDescriptor:number;
 readonly deadline:number;
}
export function compareH1RetainedMemberData(input:Input){
 const tick=()=>{assert(Number.isFinite(input.deadline)&&performance.now()<input.deadline,"original member-join deadline");input.original.rejoin();};
 tick();assert(Object.values(H1RetainedMemberRole).includes(input.role));
 assert(/^usr\/(?:bin|lib|lib64)\/[A-Za-z0-9_+./-]+$/.test(input.memberPath)&&!input.memberPath.split("/").some(p=>p==="."||p===".."));
 const {selection,original,decoded}=input;
 assert.equal(selection.binary.sha256,original.sha256);assert.equal(selection.binary.size,original.size);
 assert.deepEqual(decoded.archive,{sha256:original.sha256,size:original.size});assert.equal(decoded.status,0);assert.equal(decoded.signal,null);
 assert.equal(selection.binaryIndex.origin,selection.sourceIndex.origin);assert.equal(selection.binaryIndex.releaseSha256,selection.sourceIndex.releaseSha256);
 assert(/^[a-f0-9]{64}$/.test(selection.binaryIndex.releaseSha256)&&/^[a-f0-9]{64}$/.test(selection.stanzaSha256));
 if(input.role===H1RetainedMemberRole.HostNspawn){assert.equal(input.memberPath,"usr/bin/systemd-nspawn");assert.equal(selection.binary.package,"systemd-container");assert.equal(selection.source.name,"systemd");}
 if(input.role===H1RetainedMemberRole.StagedPython){assert.equal(input.memberPath,"usr/bin/python3.12");assert.equal(selection.binary.package,"python3.12-minimal");assert.equal(selection.source.name,"python3.12");}
 // The original checked decoder owns .deb -> fsys bytes. Re-run the existing
 // complete GNU profile on those exact bytes; do not trust a selected-row DTO.
 const members=readFixedGnuBasicMembers(decoded.bytes,selection.binary,{sha256:decoded.survey.streamSha256,bytes:decoded.bytes.length,archiveSha256:original.sha256,archiveBytes:original.size},input.deadline);
 const rows=members.rows.filter(row=>Buffer.from(row.nameBytesBase64,"base64").equals(Buffer.from("./"+input.memberPath)));
 assert.equal(rows.length,1,"one exact package member required");const member=rows[0]!;assert.equal(member.kind,FixedGnuMemberKind.Regular);assert.equal(member.payloadBytes,member.size);
 const payload=decoded.bytes.subarray(member.payloadOffset,member.payloadOffset+member.size);assert.equal(payload.length,member.size);assert.equal(hash(payload),member.payloadSha256);tick();
 const before=fstatSync(input.fileDescriptor,{bigint:true});assert(before.isFile()&&before.size===BigInt(member.size)&&before.size<=32n*1024n*1024n);
 const buffer=Buffer.alloc(65536),digest=createHash("sha256");let at=0;
 for(;;){tick();const count=readSync(input.fileDescriptor,buffer,0,Math.min(buffer.length,member.size+1-at),at);tick();if(count===0)break;assert(at+count<=member.size);assert(buffer.subarray(0,count).equals(payload.subarray(at,at+count)),"retained file differs from exact package member");digest.update(buffer.subarray(0,count));at+=count;}
 assert.equal(at,member.size);assert.equal(digest.digest("hex"),member.payloadSha256);assert.deepEqual(stamp(fstatSync(input.fileDescriptor,{bigint:true})),stamp(before));tick();
 // Rejoin the decoded original too: caller-owned Buffer mutation cannot turn
 // an earlier member observation into later package-byte equality.
 assert.equal(hash(decoded.bytes),members.stream.sha256);assert.deepEqual(stamp(fstatSync(input.fileDescriptor,{bigint:true})),stamp(before));tick();
 return Object.freeze({purpose:"RETAINED_FILE_PACKAGE_MEMBER_EQUALITY_UNADMITTED",role:input.role,
  package:Object.freeze({...selection.binary}),source:Object.freeze({...selection.source}),binaryIndex:Object.freeze({...selection.binaryIndex}),sourceIndex:Object.freeze({...selection.sourceIndex}),sourceStanzaSha256:selection.stanzaSha256,
  decoder:Object.freeze({...decoded.tool}),streamSha256:members.stream.sha256,member:Object.freeze({path:input.memberPath,ordinal:member.ordinal,headerSha256:member.headerSha256,sha256:member.payloadSha256,bytes:member.size}),
  retained:Object.freeze({dev:String(before.dev),ino:String(before.ino),mode:String(before.mode),uid:String(before.uid),gid:String(before.gid),nlink:String(before.nlink),size:String(before.size),mtimeNs:String(before.mtimeNs),ctimeNs:String(before.ctimeNs)}),
  compiledInputEquality:false,sourceSemanticsReviewed:false,nativeQualified:false});
}
