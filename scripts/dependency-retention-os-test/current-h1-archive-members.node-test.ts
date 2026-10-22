import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {closeSync,fsyncSync,mkdtempSync,openSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {assertFixedGnuRecordBytes,FixedGnuMemberKind,readFixedGnuBasicMembers,serializeFixedGnuMembers} from "./current-h1-archive-members-TEST.ts";
import {ToolInputArchitecture,type AcquiredSignedPackage} from "./current-h1-tool-inputs-package.ts";
import {ciIndexOperationalBytes} from "./current-h1-tool-inputs-ci-index.ts";
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const pkg:AcquiredSignedPackage={package:"util-linux",version:"2.39.3-9ubuntu6.6",arch:ToolInputArchitecture.Amd64,sha256:"08eb17ba3b83378ed1e73d8335d0ce03b429c0bbeb07e374f536234edab02465",size:1128326,filename:"pool/main/u/util-linux/util-linux_2.39.3-9ubuntu6.6_amd64.deb"};
function checksum(h:Buffer):void {h.fill(32,148,156);let sum=0;for(const b of h)sum+=b;h.write(sum.toString(8).padStart(6,"0")+"\0 ",148,"latin1");}
function member(name:string,type=48,payload=Buffer.alloc(0),link="",mode=0o644):Buffer {
 const h=Buffer.alloc(512);h.write(name,0,"latin1");for(const [at,value,len] of [[100,mode,8],[108,0,8],[116,0,8],[124,payload.length,12],[136,0,12]]){assert(at!==undefined&&value!==undefined&&len!==undefined);h.write(value.toString(8).padStart(len-1,"0")+"\0",at,"latin1");}
 h[156]=type;h.write(link,157,"latin1");Buffer.from([117,115,116,97,114,32,32,0]).copy(h,257);checksum(h);
 return Buffer.concat([h,payload,Buffer.alloc((512-payload.length%512)%512)]);
}
const end=Buffer.alloc(1024),valid=()=>Buffer.concat([member("./usr/bin/su",48,Buffer.from("abc"),"",0o4755),member("./usr/lib/python3.12/sitecustomize.py",50,Buffer.alloc(0),"/etc/python3.12/sitecustomize.py",0o777),member("./usr/lib64/ld-linux-x86-64.so.2",50,Buffer.alloc(0),"../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",0o777),member("./usr",53,Buffer.alloc(0),"",0o755),member("./usr",53,Buffer.alloc(0),"",0o755),end]);
const expected=(b:Buffer)=>({sha256:hash(b),bytes:b.length,archiveSha256:pkg.sha256,archiveBytes:pkg.size});
const decode=(b:Buffer)=>readFixedGnuBasicMembers(b,pkg,expected(b),performance.now()+10000);
test("GNU basic rows retain original privileged mode and absolute dotdot literals without namespace authority",()=>{
 const bytes=valid(),record=decode(bytes);assert.equal(record.rows.length,5);assert.equal(record.nativeQualified,false);
 assert.deepEqual(record.rows.map(r=>[r.ordinal,r.headerOffset,r.kind,r.mode]),[[1,0,FixedGnuMemberKind.Regular,0o4755],[2,1024,FixedGnuMemberKind.Symlink,0o777],[3,1536,FixedGnuMemberKind.Symlink,0o777],[4,2048,FixedGnuMemberKind.Directory,0o755],[5,2560,FixedGnuMemberKind.Directory,0o755]]);
 assert.equal(record.rows[0]?.payloadSha256,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
 assert.equal(Buffer.from(record.rows[1]?.linkBytesBase64??"","base64").toString("ascii"),"/etc/python3.12/sitecustomize.py");assert.equal(Buffer.from(record.rows[2]?.linkBytesBase64??"","base64").toString("ascii"),"../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");assert.equal(record.rows[0]?.payloadOffset,512);assert.equal(record.rows[0]?.payloadBytes,3);assert(Object.isFrozen(record.rows));
});
test("GNU basic profile drift and interpayload padding refuse before any row publication",()=>{
 const mutations:((bytes:Buffer)=>void)[]=[b=>{Buffer.from([117,115,116,97,114,0,48,48]).copy(b,257);},b=>{b[345]=48;},b=>{b[124]=128;},b=>{b[156]=49;},b=>{b[156]=76;},b=>{b[156]=120;},b=>{b[156]=83;},b=>{b[108]=49;},b=>{b[0]=255;},b=>{b[2]=10;},b=>{b[99]=65;},b=>{b[157]=65;},b=>{b.write("0001755\0",100,"latin1");}];
 for(const mutate of mutations){const b=valid();mutate(b);checksum(b.subarray(0,512));assert.throws(()=>decode(b));}
 const badPadding=valid();badPadding[515]=1;assert.throws(()=>decode(badPadding),/interpayload padding/);
 const noTail=valid().subarray(0,3072);assert.throws(()=>decode(noTail),/EOF/);
 const badChecksum=valid();badChecksum[1]=65;assert.throws(()=>decode(badChecksum),/EOF/);
 const emptyLink=Buffer.concat([member("link",50,Buffer.alloc(0),"",0o777),end]);assert.throws(()=>decode(emptyLink),/link role/);
 const wrongSu={...pkg,package:"unselected"};const b=valid();assert.throws(()=>readFixedGnuBasicMembers(b,wrongSu,expected(b),performance.now()+10000),/mode profile/);
});
test("GNU original stream package commitments and one absolute deadline veto stale results",()=>{
 const b=valid();for(const e of [{...expected(b),sha256:"0".repeat(64)},{...expected(b),bytes:b.length+1},{...expected(b),archiveSha256:"0".repeat(64)},{...expected(b),archiveBytes:pkg.size+1}])assert.throws(()=>readFixedGnuBasicMembers(b,pkg,e,performance.now()+10000));
 assert.throws(()=>readFixedGnuBasicMembers(b,pkg,expected(b),performance.now()),/deadline/);
 const large=Buffer.concat([member("large",48,Buffer.alloc(16*1024*1024)),end]),e=expected(large),deadline=performance.now()+1;assert(performance.now()<deadline);assert.throws(()=>readFixedGnuBasicMembers(large,pkg,e,deadline),/deadline/);
 const record=decode(b);assert.throws(()=>serializeFixedGnuMembers(record,performance.now()),/deadline/);
});
test("GNU complete DATA serialization has inclusive operational cap and exact owned readback",()=>{
 assert.doesNotThrow(()=>assertFixedGnuRecordBytes(ciIndexOperationalBytes));assert.throws(()=>assertFixedGnuRecordBytes(ciIndexOperationalBytes+1),/operational/);
 const dir=mkdtempSync(join(tmpdir(),"TEST-GNU-members-"));try{assert.throws(()=>assertFixedGnuRecordBytes(ciIndexOperationalBytes+1));assert.deepEqual(readdirSync(dir),[]);const serialized=serializeFixedGnuMembers(decode(valid()),performance.now()+10000),path=join(dir,"members.json");writeFileSync(path,serialized.bytes,{flag:"wx",mode:0o600});const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(dir,"r");try{fsyncSync(parent);}finally{closeSync(parent);}assert(readFileSync(path).equals(serialized.bytes));assert.equal(hash(readFileSync(path)),serialized.sha256);assert.equal(JSON.parse(readFileSync(path,"utf8")).rows.length,5);assert.throws(()=>writeFileSync(path,serialized.bytes,{flag:"wx"}),/EEXIST/);}finally{rmSync(dir,{recursive:true});}
});
