import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveHeaderFormat, ArchiveSurveyStatus, surveyRawArchiveHeaders } from "./current-h1-archive-format-census.ts";
function member(name:Buffer,type=48,payload=Buffer.alloc(0),link=Buffer.alloc(0),gnu=false):Buffer {
 const h=Buffer.alloc(512);name.copy(h,0);h.write("0004755\0",100,"latin1");h.write("0000000\0",108,"latin1");h.write("0000000\0",116,"latin1");h.write(payload.length.toString(8).padStart(11,"0")+"\0",124,"latin1");h.write("00000000000\0",136,"latin1");h.fill(32,148,156);h[156]=type;link.copy(h,157);h.write(gnu?"ustar  \0":"ustar\0"+"00",257,"latin1");let checksum=0;for(const byte of h)checksum+=byte;h.write(checksum.toString(8).padStart(6,"0")+"\0 ",148,"latin1");return Buffer.concat([h,payload,Buffer.alloc((512-payload.length%512)%512)]);
}
const end=Buffer.alloc(1024);
test("raw tar survey preserves literal bytes, privileged mode and repeated hardlink observations without path authority",()=>{
 const name=Buffer.from([0x61,0x0a,0xff]),raw=Buffer.concat([member(name,48,Buffer.from("abc")),member(name),member(Buffer.from("other"),49,Buffer.alloc(0),name),end]);
 const dir=mkdtempSync(join(tmpdir(),"TEST-H1-raw-survey-")),path=join(dir,"stream.tar");try{writeFileSync(path,raw,{mode:0o600,flag:"wx"});const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}const survey=surveyRawArchiveHeaders(readFileSync(path));assert.equal(survey.status,ArchiveSurveyStatus.CompleteRawHeaders);assert.equal(survey.completeEffectiveMemberCensus,false);assert.equal(survey.headers.length,3);assert.equal(survey.headers[0]?.format,ArchiveHeaderFormat.Ustar);assert(Buffer.from(survey.headers[0]?.nameBase64??"","base64").subarray(0,3).equals(name));assert.equal(Buffer.from(survey.headers[0]?.modeEncodingBase64??"","base64").toString("latin1"),"0004755\0");assert.equal(survey.headers[0]?.payloadSha256,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");assert.deepEqual(survey.rawHardlinkOffsets,[1536]);assert.deepEqual(survey.rawRepeatedNonDirectoryNames.map(r=>r.offsets),[[0,1024]]);assert.equal(survey.zeroEndOffset,2048);assert.equal(survey.trailingBytes,0);assert(readFileSync(path).equals(raw));}finally{rmSync(dir,{recursive:true});}
});
test("GNU and PAX raw extensions preserve original bytes while effective member census stays unresolved",()=>{
 const literal=Buffer.from("literal\nname\0"),gnu=surveyRawArchiveHeaders(Buffer.concat([member(Buffer.from("././@LongLink"),76,literal,Buffer.alloc(0),true),member(Buffer.from("short"),48,Buffer.alloc(0),Buffer.alloc(0),true),end]));assert.equal(gnu.status,ArchiveSurveyStatus.CompleteRawHeaders);assert.equal(gnu.headers[0]?.format,ArchiveHeaderFormat.Gnu);assert.equal(gnu.headers[0]?.extensionPayloadBase64,literal.toString("base64"));assert.equal(gnu.completeEffectiveMemberCensus,false);
 const pax=surveyRawArchiveHeaders(Buffer.concat([member(Buffer.from("PaxHeader"),120,Buffer.from("13 size=9999\n")),member(Buffer.from("following")),end]));assert.equal(pax.status,ArchiveSurveyStatus.Held);assert.equal(pax.headers.length,1);assert.equal(pax.headers[0]?.offset,0);assert.equal(pax.zeroEndOffset,null);assert.equal(pax.completeEffectiveMemberCensus,false);assert.match(pax.reason,/qualified structured reader/);
});
test("unsupported size or checksum and incomplete raw EOF hold without guessing another header",()=>{
 const valid=member(Buffer.from("file")),binary=Buffer.from(valid);binary[124]=128;const unknown=surveyRawArchiveHeaders(Buffer.concat([binary,end]));assert.equal(unknown.status,ArchiveSurveyStatus.Held);assert.equal(unknown.headers.length,1);assert.equal(unknown.headers[0]?.payloadBytes,null);assert.equal(unknown.headers[0]?.headerBase64,binary.toString("base64"));assert.match(unknown.reason,/encoding/);
 const checksum=Buffer.from(valid);checksum[0]=120;assert.match(surveyRawArchiveHeaders(Buffer.concat([checksum,end])).reason,/checksum/);
 for(const bytes of [valid,Buffer.concat([valid,Buffer.alloc(512)]),Buffer.concat([valid,end,Buffer.from([1])]),valid.subarray(0,511)])assert.equal(surveyRawArchiveHeaders(bytes).status,ArchiveSurveyStatus.Held);
});

test("shared decoder adapters retain the CI scope and cannot turn expired/caller DATA into a native tool launch",async()=>{
 const {inspectRetainedOriginalDebFsys,inspectRetainedNativeDebFsys}=await import("./current-h1-archive-format-census.ts");
 let joins=0;const original={fd:-1,sha256:"a".repeat(64),size:1,rejoin(){joins++;},close(){}};
 const tool={fd:-1,actual:"/usr/bin/dpkg-deb",stamp:"invalid",sha256:"a".repeat(64)};
 await assert.rejects(inspectRetainedOriginalDebFsys(original,tool,0,"/nonexistent"));assert.equal(joins,0);
 await assert.rejects(inspectRetainedNativeDebFsys(original,{...tool,loader:{fd:-1,stamp:"invalid",sha256:"a".repeat(64)}},0));assert.equal(joins,0);
});
