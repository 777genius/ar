/** Raw format observations only. No extraction, effective-path authority or HOST admission. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fstatSync, lstatSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import type { retainOriginalAcquiredArchive } from "./current-h1-tool-inputs-package.ts";
export enum ArchiveSurveyStatus { CompleteRawHeaders="complete-raw-headers-not-effective-members", Held="held-raw-format-counterexample" }
export enum ArchiveHeaderFormat { Ustar="ustar", Gnu="gnu-or-pre-posix", V7="v7", Unknown="unknown" }
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const streamCap=128*1024*1024,headerCap=20000;
export interface RawHeaderObservation {
 readonly offset:number;readonly headerSha256:string;readonly headerBase64:string;readonly magicBase64:string;readonly versionBase64:string;
 readonly type:number;readonly format:ArchiveHeaderFormat;readonly nameBase64:string;readonly prefixBase64:string;readonly linkBase64:string;
 readonly sizeEncodingBase64:string;readonly checksumEncodingBase64:string;readonly payloadBytes:number|null;
 readonly modeEncodingBase64:string;readonly uidEncodingBase64:string;readonly gidEncodingBase64:string;
 readonly payloadSha256:string|null;readonly extensionPayloadBase64:string|null;
}
export interface RawArchiveSurvey {
 readonly status:ArchiveSurveyStatus;readonly reason:string;readonly streamBytes:number;readonly streamSha256:string;
 readonly headers:readonly RawHeaderObservation[];readonly payloadBytes:number;readonly zeroEndOffset:number|null;
 readonly trailingBytes:number|null;readonly completeEffectiveMemberCensus:false;
 readonly rawRepeatedNonDirectoryNames:readonly Readonly<{rawNameKey:string;offsets:readonly number[]}>[];
 readonly rawHardlinkOffsets:readonly number[];
}
type MutableHeader={-readonly [Key in keyof RawHeaderObservation]:RawHeaderObservation[Key]};
function octal(b:Buffer):number|null {const s=b.toString("latin1");if(!/^ *[0-7]+[ \0]*$/.test(s))return null;const n=Number.parseInt(s.trim().replace(/\0.*$/,""),8);return Number.isSafeInteger(n)&&n>=0?n:null;}
/** Checked boundaries only. Extension semantics are never guessed. Full original
 * stream is retained separately even when this survey stops at a counterexample. */
export function surveyRawArchiveHeaders(bytes:Buffer):RawArchiveSurvey {
 assert(bytes.length<=streamCap,"fixed CI fsys stream ceiling");
 const headers:RawHeaderObservation[]=[],repeated=new Map<string,number[]>(),hardlinks:number[]=[];let payloadBytes=0,zeroEndOffset:number|null=null,trailingBytes:number|null=null;
 const finish=(status:ArchiveSurveyStatus,reason:string):RawArchiveSurvey=>Object.freeze({status,reason,streamBytes:bytes.length,streamSha256:hash(bytes),headers:Object.freeze(headers.map(o=>Object.freeze(o))),payloadBytes,zeroEndOffset,trailingBytes,completeEffectiveMemberCensus:false,rawRepeatedNonDirectoryNames:Object.freeze([...repeated].filter(([,offsets])=>offsets.length>1).map(([rawNameKey,offsets])=>Object.freeze({rawNameKey,offsets:Object.freeze(offsets)}))),rawHardlinkOffsets:Object.freeze(hardlinks)});
 let at=0;
 while(at<bytes.length){
  if(at+512>bytes.length)return finish(ArchiveSurveyStatus.Held,"truncated header");
  const h=bytes.subarray(at,at+512);
  if(h.every(b=>b===0)){zeroEndOffset=at;if(at+1024>bytes.length||!bytes.subarray(at+512,at+1024).every(b=>b===0))return finish(ArchiveSurveyStatus.Held,"missing second zero end record");trailingBytes=bytes.length-at-1024;return bytes.length%512===0&&bytes.subarray(at+1024).every(b=>b===0)?finish(ArchiveSurveyStatus.CompleteRawHeaders,"raw header boundaries and complete zero-padded EOF"):finish(ArchiveSurveyStatus.Held,"nonzero or unaligned trailing data");}
  if(headers.length>=headerCap)return finish(ArchiveSurveyStatus.Held,"fixed raw header ceiling");
  const size=octal(h.subarray(124,136)),checksum=octal(h.subarray(148,156)),magic=h.subarray(257,263),version=h.subarray(263,265),type=h[156];assert(type!==undefined);
  const format=magic.equals(Buffer.from("ustar\0"))&&version.equals(Buffer.from("00"))?ArchiveHeaderFormat.Ustar:magic.equals(Buffer.from("ustar "))&&version.equals(Buffer.from(" \0"))?ArchiveHeaderFormat.Gnu:magic.every(b=>b===0)&&version.every(b=>b===0)?ArchiveHeaderFormat.V7:ArchiveHeaderFormat.Unknown;
  const observation:MutableHeader={offset:at,headerSha256:hash(h),headerBase64:h.toString("base64"),magicBase64:magic.toString("base64"),versionBase64:version.toString("base64"),type,format,nameBase64:h.subarray(0,100).toString("base64"),prefixBase64:h.subarray(345,500).toString("base64"),linkBase64:h.subarray(157,257).toString("base64"),sizeEncodingBase64:h.subarray(124,136).toString("base64"),checksumEncodingBase64:h.subarray(148,156).toString("base64"),modeEncodingBase64:h.subarray(100,108).toString("base64"),uidEncodingBase64:h.subarray(108,116).toString("base64"),gidEncodingBase64:h.subarray(116,124).toString("base64"),payloadBytes:size,payloadSha256:null,extensionPayloadBase64:null};
  headers.push(observation);
  if(size===null||checksum===null)return finish(ArchiveSurveyStatus.Held,"unsupported size/checksum encoding");
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i]??0;if(sum!==checksum)return finish(ArchiveSurveyStatus.Held,"raw header checksum mismatch");
  if(format===ArchiveHeaderFormat.Unknown)return finish(ArchiveSurveyStatus.Held,"unknown raw header magic/version");
  if([49,50,53].includes(type)&&size!==0)return finish(ArchiveSurveyStatus.Held,"nonregular raw size has unknown boundary semantics");
  const end=at+512+size,next=at+512+Math.ceil(size/512)*512;if(!Number.isSafeInteger(next)||next>bytes.length)return finish(ArchiveSurveyStatus.Held,"truncated payload/padding");
  const payload=bytes.subarray(at+512,end);observation.payloadSha256=hash(payload);payloadBytes+=size;
  if(type===76||type===75||type===120||type===103){if(size<=4096)observation.extensionPayloadBase64=payload.toString("base64");
   // PAX can override the next raw header's size, so no guessed next boundary.
   if(type===120||type===103)return finish(ArchiveSurveyStatus.Held,"PAX semantics require a qualified structured reader; remaining original stream retained");
  } else if(type===0||type===48||type===49||type===50){const key=observation.format+":"+observation.prefixBase64+":"+observation.nameBase64;const offsets=repeated.get(key)??[];offsets.push(at);repeated.set(key,offsets);if(type===49)hardlinks.push(at);}
  // GNU sparse and unknown types may have out-of-band records: stop, do not skip.
  if(![0,48,49,50,53,76,75].includes(type))return finish(ArchiveSurveyStatus.Held,"unsupported raw type/extension boundary");
  at=next;
 }
 return finish(ArchiveSurveyStatus.Held,"missing zero end records");
}
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
/** Same disposable ROOT CI DATA tool policy as acquisition; no HOST TCB claim. */
export async function inspectRetainedOriginalDebFsys(original:ReturnType<typeof retainOriginalAcquiredArchive>,tool:Readonly<{fd:number;actual:string;stamp:string;sha256:string}>,parentDeadline:number,ownScratch:string):Promise<Readonly<{bytes:Buffer;survey:RawArchiveSurvey;tool:Readonly<{path:string;sha256:string;identity:string}>;archive:Readonly<{sha256:string;size:number}>;stderr:Readonly<{bytes:number;sha256:string}>;status:0;signal:null}>> {
 assert(process.platform==="linux"&&process.getuid?.()===0&&process.geteuid?.()===0&&process.env.CI==="true"&&process.env.GITHUB_ACTIONS==="true","existing ROOT CI DATA scope");
 const deadline=Math.min(parentDeadline,performance.now()+30000);assert(Number.isFinite(deadline));const scratch=lstatSync(ownScratch,{bigint:true});assert(scratch.isDirectory()&&scratch.uid===0n&&scratch.gid===0n&&(scratch.mode&0o7777n)===0o700n);const scratchIdentity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode].map(String).join(":");const tick=()=>{assert(performance.now()<deadline,"one remaining CI survey deadline");assert.equal(scratchIdentity(lstatSync(ownScratch,{bigint:true})),scratchIdentity(scratch));};tick();original.rejoin();
 const path=realpathSync("/usr/bin/dpkg-deb");assert.equal(path,tool.actual);const before=fstatSync(tool.fd,{bigint:true});assert(before.isFile()&&before.uid===0n&&before.nlink>0n&&!(before.mode&0o022n)&&(before.mode&0o111n)&&before.size<=64n*1024n*1024n);
 const rejoinTool=()=>{tick();assert.equal(stamp(fstatSync(tool.fd,{bigint:true})),tool.stamp);assert.equal(stamp(lstatSync(path,{bigint:true})),tool.stamp);};rejoinTool();
 const toolHash=createHash("sha256"),chunk=Buffer.alloc(65536);let toolSize=0;for(;;){tick();const n=readSync(tool.fd,chunk,0,chunk.length,toolSize);tick();if(n===0)break;toolSize+=n;assert(toolSize<=Number(before.size));toolHash.update(chunk.subarray(0,n));}assert.equal(toolSize,Number(before.size));const toolSha=toolHash.digest("hex");assert.equal(toolSha,tool.sha256,"original CI tool hash BEFORE execution");rejoinTool();original.rejoin();
 const result=await new Promise<{bytes:Buffer;stderr:Buffer}>((resolve,reject)=>{
  const child=spawn("/proc/self/fd/3",["--fsys-tarfile","/proc/self/fd/4"],{argv0:"/usr/bin/dpkg-deb",shell:false,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",TZ:"UTC",HOME:ownScratch,TMPDIR:ownScratch},stdio:["ignore","pipe","pipe",tool.fd,original.fd]});
  assert(child.stdout&&child.stderr);const stdout=child.stdout,stderr=child.stderr,out:Buffer[]=[],err:Buffer[]=[];let outBytes=0,errBytes=0,outEnd=false,errEnd=false,failure:Error|undefined;
  const stop=(error:Error)=>{if(!failure){failure=error;try{child.kill("SIGKILL");}catch{failure=new Error("own CI child signal/drain unproven",{cause:error});}finally{stdout.destroy();stderr.destroy();}}};
  const receive=(part:Buffer,diagnostic:boolean)=>{if(failure)return;try{tick();assert(Buffer.isBuffer(part));if(diagnostic){errBytes+=part.length;assert(errBytes<=16384,"fixed CI stderr diagnostic ceiling");}else{outBytes+=part.length;assert(outBytes<=streamCap,"fixed CI stdout stream ceiling");}assert(outBytes+errBytes<=streamCap,"combined CI survey output ceiling");(diagnostic?err:out).push(part);}catch(error){stop(error instanceof Error?error:new Error("fixed CI stream refused"));}};
  stdout.on("data",(part:Buffer)=>receive(part,false));stderr.on("data",(part:Buffer)=>receive(part,true));stdout.once("end",()=>{outEnd=true;});stderr.once("end",()=>{errEnd=true;});stdout.once("error",stop);stderr.once("error",stop);child.once("error",stop);
  const timer=setTimeout(()=>stop(new Error("one remaining CI survey deadline")),Math.max(1,Math.floor(deadline-performance.now())));
  child.once("close",(code,signal)=>{clearTimeout(timer);try{if(failure)throw failure;tick();assert(code===0&&signal===null&&outEnd&&errEnd,"fixed CI fsys stream exit and both EOFs");resolve({bytes:Buffer.concat(out,outBytes),stderr:Buffer.concat(err,errBytes)});}catch(error){reject(error);}});
 });
 rejoinTool();original.rejoin();const survey=surveyRawArchiveHeaders(result.bytes);tick();original.rejoin();return Object.freeze({bytes:result.bytes,survey,tool:Object.freeze({path,sha256:toolSha,identity:tool.stamp}),archive:Object.freeze({sha256:original.sha256,size:original.size}),stderr:Object.freeze({bytes:result.stderr.length,sha256:hash(result.stderr)}),status:0,signal:null});
}
