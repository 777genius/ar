/** Closed GNU-basic member DATA. No graph, extraction or native authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ArchiveSurveyStatus, readCheckedTarOctal, surveyRawArchiveHeaders } from "./current-h1-archive-format-census.ts";
import { ciIndexOperationalBytes } from "./current-h1-tool-inputs-ci-index.ts";
import type { AcquiredSignedPackage } from "./current-h1-tool-inputs-package.ts";

export enum FixedGnuMemberKind { Directory="directory", Regular="regular", Symlink="symlink-literal" }
export enum FixedGnuMemberProfile { Basic="fixed-gnu-basic-ascii-octal-v1" }
export interface FixedGnuStreamCommitment {
 readonly sha256:string;readonly bytes:number;readonly archiveSha256:string;readonly archiveBytes:number;
}
export interface FixedGnuMemberRow {
 readonly ordinal:number;readonly headerOffset:number;readonly headerSha256:string;readonly kind:FixedGnuMemberKind;
 readonly nameBytesBase64:string;readonly linkBytesBase64:string;readonly mode:number;readonly uid:number;readonly gid:number;
 readonly mtime:number;readonly size:number;readonly payloadOffset:number;readonly payloadBytes:number;readonly payloadSha256:string;
}
export interface FixedGnuArchiveMembers {
 readonly schemaVersion:1;readonly profile:FixedGnuMemberProfile;readonly package:Readonly<AcquiredSignedPackage>;
 readonly stream:Readonly<FixedGnuStreamCommitment>;readonly rows:readonly FixedGnuMemberRow[];readonly nativeQualified:false;
}
const hash=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const sha=/^[a-f0-9]{64}$/;
const tick=(deadline:number)=>assert(Number.isFinite(deadline)&&performance.now()<deadline,"original GNU member deadline");
function number(bytes:Buffer):number {
 const value=readCheckedTarOctal(bytes);assert(value!==null,"closed GNU octal field/integer");return value;
}
function literal(bytes:Buffer):Buffer {
 const end=bytes.indexOf(0);assert(end>=0&&bytes.subarray(end).every(byte=>byte===0),"closed GNU NUL tail");
 const value=bytes.subarray(0,end);assert(value.every(byte=>byte>=32&&byte<127),"closed GNU ASCII literal");return value;
}
/** Re-runs checked facts on the actual bytes, never accepts a survey DTO. A
 * package row alone is not signed origin; existing caller custody supplies it. */
export function readFixedGnuBasicMembers(bytes:Buffer,pkg:Readonly<AcquiredSignedPackage>,expected:Readonly<FixedGnuStreamCommitment>,deadline:number):FixedGnuArchiveMembers {
 tick(deadline);assert(sha.test(expected.sha256)&&sha.test(expected.archiveSha256));
 assert.equal(bytes.length,expected.bytes,"original stream size");assert.equal(pkg.sha256,expected.archiveSha256,"original package hash");assert.equal(pkg.size,expected.archiveBytes,"original package size");
 const survey=surveyRawArchiveHeaders(bytes);tick(deadline);assert.equal(survey.streamSha256,expected.sha256,"original stream hash");assert.equal(survey.status,ArchiveSurveyStatus.CompleteRawHeaders,"complete GNU raw EOF");
 const rows:FixedGnuMemberRow[]=[];
 for(const observed of survey.headers){
  tick(deadline);const h=bytes.subarray(observed.offset,observed.offset+512);
  assert(h.subarray(257,265).equals(Buffer.from([117,115,116,97,114,32,32,0])),"exact GNU basic magic");
  assert(h.subarray(345).every(byte=>byte===0),"zero GNU auxiliary area, never ustar prefix");
  assert(h.every(byte=>byte<128),"closed GNU ASCII header");const type=h[156];assert(type===48||type===50||type===53,"closed GNU member type");
  const kind=type===48?FixedGnuMemberKind.Regular:type===50?FixedGnuMemberKind.Symlink:FixedGnuMemberKind.Directory;
  const name=literal(h.subarray(0,100)),link=literal(h.subarray(157,257));assert(name.length>0,"nonempty GNU name");
  const mode=number(h.subarray(100,108)),uid=number(h.subarray(108,116)),gid=number(h.subarray(116,124)),size=number(h.subarray(124,136)),mtime=number(h.subarray(136,148));number(h.subarray(148,156));
  assert(uid===0&&gid===0,"original GNU owners");assert.equal(size,observed.payloadBytes);
  const su=kind===FixedGnuMemberKind.Regular&&mode===0o4755&&name.equals(Buffer.from("./usr/bin/su"))&&pkg.package==="util-linux"&&pkg.version==="2.39.3-9ubuntu6.6"&&pkg.arch==="amd64"&&pkg.sha256==="08eb17ba3b83378ed1e73d8335d0ce03b429c0bbeb07e374f536234edab02465";
  assert(kind===FixedGnuMemberKind.Directory?mode===0o755:kind===FixedGnuMemberKind.Symlink?mode===0o777:mode===0o644||mode===0o755||su,"original GNU type/mode profile");
  assert(kind===FixedGnuMemberKind.Symlink?link.length>0:link.length===0,"original GNU link role");assert(kind===FixedGnuMemberKind.Regular||size===0,"empty nonregular GNU payload");
  const payloadOffset=observed.offset+512,end=payloadOffset+size,paddedEnd=payloadOffset+Math.ceil(size/512)*512;
  assert(bytes.subarray(end,paddedEnd).every(byte=>byte===0),"zero GNU interpayload padding");assert(observed.payloadSha256!==null);
  rows.push(Object.freeze({ordinal:rows.length+1,headerOffset:observed.offset,headerSha256:observed.headerSha256,kind,nameBytesBase64:name.toString("base64"),linkBytesBase64:link.toString("base64"),mode,uid,gid,mtime,size,payloadOffset,payloadBytes:size,payloadSha256:observed.payloadSha256}));tick(deadline);
 }
 tick(deadline);return Object.freeze({schemaVersion:1,profile:FixedGnuMemberProfile.Basic,package:Object.freeze({...pkg}),stream:Object.freeze({...expected}),rows:Object.freeze(rows),nativeQualified:false});
}
/** Same operational DATA ceiling as existing publication, never a native cap. */
export function assertFixedGnuRecordBytes(bytes:number):void {
 assert(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=ciIndexOperationalBytes,"GNU member operational record ceiling");
}
export function serializeFixedGnuMembers(record:FixedGnuArchiveMembers,deadline:number):Readonly<{bytes:Buffer;sha256:string}> {
 tick(deadline);const text=JSON.stringify(record)+"\n";tick(deadline);assertFixedGnuRecordBytes(Buffer.byteLength(text));
 const bytes=Buffer.from(text),sha256=hash(bytes);tick(deadline);return Object.freeze({bytes,sha256});
}
