import {afterEach,expect,it,vi} from "vitest";
import * as fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {MAGIC,Role,assertRegularName,parseManifest,readRegularFrames,safeRelative,writeRegularBytes,sealRegularFile,type Manifest,type FrameRow} from "./stage-current-positive-public.mts";
const fault=vi.hoisted(()=>({error:undefined as Error|undefined}));
vi.mock("node:fs",async original=>{const actual=await original<typeof import("node:fs")>();return {...actual,fsyncSync(fd:number){if(fault.error)throw fault.error;actual.fsyncSync(fd);}};});
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const temporary:string[]=[];
afterEach(()=>{fault.error=undefined;for(const path of temporary.splice(0))fs.rmSync(path,{recursive:true,force:true});});
function temp(){const p=fs.mkdtempSync(join(tmpdir(),"TEST-public-frames-"));temporary.push(p);return p;}
const bytes=Buffer.from("TEST PUBLIC DATA only\n");
const frameRow:FrameRow={role:Role.Emitted,path:"dist/example.js",bytes:bytes.length,mode:0o644,sha256:hash(bytes)};
function framed(rows:{row:FrameRow;data:Buffer}[]){return Buffer.concat([MAGIC,...rows.flatMap(({row,data})=>{const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(row.bytes));return [n,data];})]);}
async function readFilePayload(value:Buffer,rows:FrameRow[]=[frameRow],guard=()=>{}){const path=join(temp(),"payload"),fd=fs.openSync(path,"wx+",0o600);fs.writeFileSync(fd,value);try{const out:Buffer[]=[];for await(const chunk of readRegularFrames(fd,rows,guard))out.push(chunk.bytes);return Buffer.concat(out);}finally{fs.closeSync(fd);}}
function manifestFixture():Manifest {
 const targets={tsserver:"../typescript/bin/tsserver",nanoid:"../nanoid/bin/nanoid.cjs",rolldown:"../rolldown/bin/cli.mjs",vitest:"../vitest/vitest.mjs","node-which":"../which/bin/node-which",tsc:"../typescript/bin/tsc",vite:"../vite/bin/vite.js","why-is-node-running":"../why-is-node-running/cli.js","anthropic-ai-sdk":"../@anthropic-ai/sdk/bin/cli"};
 const data=(path:string,role:Role):FrameRow=>({...frameRow,path,role});
 const {role:_role,...plainRow}=frameRow;const tracked=["package.json","package-lock.json","packages/agent-account-observability/package.json","packages/agent-account-observability/README.md"].sort().map(path=>({...plainRow,path,gitBlob:"a".repeat(40)}));
 const rows:FrameRow[]=[...Object.values(targets).map(t=>data("node_modules/"+t.slice(3),Role.Dependency)),data("packages/agent-account-observability/dist/index.js",Role.Emitted),...["package.json","README.md","dist/index.js"].map(p=>data("node_modules/@vioxen/agent-account-observability/"+p,Role.WorkspacePackage)),... ["bin/node","lib/node_modules/corepack/dist/corepack.js","lib/node_modules/npm/bin/npm-cli.js","lib/node_modules/npm/bin/npx-cli.js","lib/node_modules/npm/package.json"].map(p=>data(p,Role.Toolchain))].sort((a,b)=>{const key=(r:FrameRow)=>`${r.role===Role.Toolchain?"toolchain":"source"}/${r.path}`;return key(a)<key(b)?-1:1;});
 return {schemaVersion:1,kind:"FULL_POSITIVE_PUBLIC_PREPARATION_DATA_V1",sourceSha:"a".repeat(40),sourceTree:"b".repeat(40),bundle:{bytes:1,sha256:"c".repeat(64)},payload:{bytes:MAGIC.length+rows.reduce((n,r)=>n+8+r.bytes,0),sha256:"d".repeat(64)},producer:{inputReceiptSha256:"e".repeat(64),lockSha256:frameRow.sha256,packageSha256:frameRow.sha256,compilerReceiptSha256:"f".repeat(64),nodeArchiveSha256:"a".repeat(64),publicPackageImportAuditSha256:"b".repeat(64)},tracked,rows,links:[...Object.entries(targets).map(([name,target])=>({path:"source/node_modules/.bin/"+name,target,projection:"omit" as const})),{path:"source/node_modules/@vioxen/agent-account-observability",target:"../../packages/agent-account-observability",projection:"workspace_package"},{path:"toolchain/bin/corepack",target:"../lib/node_modules/corepack/dist/corepack.js",projection:"omit"},{path:"toolchain/bin/npm",target:"../lib/node_modules/npm/bin/npm-cli.js",projection:"omit"},{path:"toolchain/bin/npx",target:"../lib/node_modules/npm/bin/npx-cli.js",projection:"omit"}],toolchainDirectories:[]};
}
function parse(m:Manifest){const b=Buffer.from(JSON.stringify(m)+"\n");return parseManifest(b,hash(b));}
it("accepts the finite reviewed DATA projection without granting authority",()=>{const m=manifestFixture();expect(parse(m)).toEqual(m);});
it.each(["../escape","/absolute","x//y","x/../y","x/auth.json","x/.env","x/key.pem","x\\y"])("rejects unsafe path %s",p=>expect(()=>safeRelative(p)).toThrow());
it("rejects unreviewed manifest bytes",()=>expect(()=>parseManifest(Buffer.from("{}\n"),"a".repeat(64))).toThrow());
it("rejects unknown or retargeted aliases",()=>{for(const change of [(m:Manifest)=>{m.links[0]!.target="../../outside";},(m:Manifest)=>{m.links.push({path:"source/node_modules/nested/link",target:"../x",projection:"omit"});}]){const m=manifestFixture();change(m);expect(()=>parse(m)).toThrow();}});
it("rejects duplicate frames and tracked mismatches",()=>{const m=manifestFixture();m.rows.push(m.rows[0]!);expect(()=>parse(m)).toThrow();const n=manifestFixture();n.rows.push({...frameRow,path:"package.json",sha256:"0".repeat(64)});n.rows.sort((a,b)=>`${a.role}/${a.path}`.localeCompare(`${b.role}/${b.path}`));expect(()=>parse(n)).toThrow();});
it("rejects omitted workspace public rows and wrong source bytes",()=>{const m=manifestFixture();m.rows=m.rows.filter(r=>r.path!=="node_modules/@vioxen/agent-account-observability/README.md");expect(()=>parse(m)).toThrow();const n=manifestFixture();n.rows.find(r=>r.role===Role.WorkspacePackage)!.sha256="0".repeat(64);expect(()=>parse(n)).toThrow();});
it("roundtrips exact regular frames using a real retained file FD",async()=>expect(await readFilePayload(framed([{row:frameRow,data:bytes}]))).toEqual(bytes));
it("rejects truncation, a wrong frame size, corrupted content and trailing bytes",async()=>{const good=framed([{row:frameRow,data:bytes}]),size=Buffer.from(good);size.writeBigUInt64BE(999n,MAGIC.length);const corrupt=Buffer.from(good);const last=corrupt.at(-1);if(last===undefined)throw new Error("TEST framed payload has no final byte");corrupt[corrupt.length-1]=last^1;for(const b of [good.subarray(0,-1),size,corrupt,Buffer.concat([good,Buffer.from("x")])])await expect(readFilePayload(b)).rejects.toThrow();});
it("propagates cancellation/deadline before any payload read",async()=>{const error=new Error("TEST deadline"),guard=vi.fn(()=>{throw error;});await expect(readFilePayload(framed([{row:frameRow,data:bytes}]),[frameRow],guard)).rejects.toBe(error);expect(guard).toHaveBeenCalledOnce();});
it("refuses hardlinked payload custody",async()=>{const dir=temp(),path=join(dir,"payload");fs.writeFileSync(path,framed([{row:frameRow,data:bytes}]));fs.linkSync(path,join(dir,"alias"));const fd=fs.openSync(path,"r");try{await expect((async()=>{for await(const _ of readRegularFrames(fd,[frameRow],()=>{})){/* read */}})()).rejects.toThrow("payload_regular");}finally{fs.closeSync(fd);}});
it("detects held payload mutation across an async yield",async()=>{const path=join(temp(),"payload");fs.writeFileSync(path,framed([{row:frameRow,data:bytes}]));const fd=fs.openSync(path,"r+");try{await expect((async()=>{for await(const _ of readRegularFrames(fd,[frameRow],()=>{})){fs.writeSync(fd,Buffer.from("X"),0,1,0);}})()).rejects.toThrow("payload_changed");}finally{fs.closeSync(fd);}});
it("copies and seals through actual create-only FDs under umask077",async()=>{const dir=temp(),input=join(dir,"payload"),output=join(dir,"out");fs.writeFileSync(input,framed([{row:frameRow,data:bytes}]));const before=process.umask(0o077),source=fs.openSync(input,"r"),fd=fs.openSync(output,"wx+",0o600);try{for await(const chunk of readRegularFrames(source,[frameRow],()=>{}))writeRegularBytes(fd,chunk.bytes,()=>{});sealRegularFile(fd,frameRow,()=>{});expect(fs.fstatSync(fd).mode&0o777).toBe(0o644);expect(fs.readFileSync(output)).toEqual(bytes);expect(()=>fs.openSync(output,"wx+")).toThrow();}finally{fs.closeSync(source);fs.closeSync(fd);process.umask(before);}});
it("refuses to seal wrong output bytes and propagates finalization cancellation",()=>{const fd=fs.openSync(join(temp(),"out"),"wx+");try{fs.writeSync(fd,Buffer.alloc(bytes.length));expect(()=>sealRegularFile(fd,frameRow,()=>{})).toThrow("output_hash_eof");const error=new Error("TEST finalization deadline");expect(()=>sealRegularFile(fd,frameRow,()=>{throw error;})).toThrow(error);}finally{fs.closeSync(fd);}});

it("detects named substitution while keeping the original retained file open",()=>{const dir=temp(),path=join(dir,"payload");fs.writeFileSync(path,bytes);const fd=fs.openSync(path,"r");try{assertRegularName(fd,path);fs.renameSync(path,join(dir,"original"));fs.writeFileSync(path,bytes);expect(()=>assertRegularName(fd,path)).toThrow("regular_name_substitution");expect(fs.readFileSync(fd)).toEqual(bytes);}finally{fs.closeSync(fd);}});

it("propagates fsync failure and preserves the partial owned output",()=>{const path=join(temp(),"out"),fd=fs.openSync(path,"wx+");try{writeRegularBytes(fd,bytes,()=>{});const error=new Error("TEST fsync failure");fault.error=error;expect(()=>sealRegularFile(fd,frameRow,()=>{})).toThrow(error);expect(fs.readFileSync(path)).toEqual(bytes);}finally{fault.error=undefined;fs.closeSync(fd);}});

it("accepts an explicitly reviewed prod alias subset without inventing dev links",()=>{const m=manifestFixture();m.links=m.links.filter(l=>l.path.startsWith("toolchain/")||l.path==="source/node_modules/.bin/anthropic-ai-sdk");expect(parse(m).links).toEqual(m.links);});

// Metadata parser regressions only: no allocation/read of a 334MiB fixture and
// no claim that these declared digest/size cells qualify actual package bytes.
const measuredDependencyBytes=334715184,dependencyMaximum=512*1024**2;
function addSizedFrame(m:Manifest,role:Role,path:string,size:number):void {
 m.rows.push({...frameRow,role,path,bytes:size,mode:0o755});
 m.rows.sort((a,b)=>{const key=(r:FrameRow)=>`${r.role===Role.Toolchain?"toolchain":"source"}/${r.path}`;return key(a)<key(b)?-1:1;});
 m.payload.bytes=MAGIC.length+m.rows.reduce((n,r)=>n+8+r.bytes,0);
}
it("admits the measured334715184-byte Dependency metadata leaf and exact512MiB ceiling",()=>{
 for(const size of [measuredDependencyBytes,dependencyMaximum]){const m=manifestFixture();addSizedFrame(m,Role.Dependency,"node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",size);expect(parse(m)).toEqual(m);}
});
it("refuses Dependency leaves beyond512MiB",()=>{const m=manifestFixture();addSizedFrame(m,Role.Dependency,"node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",dependencyMaximum+1);expect(()=>parse(m)).toThrow(/PUBLIC_STAGE_HOLD:row$/);});
it("keeps128MiB tracked emitted workspace toolchain and bundle leaf bounds",()=>{
 for(const [role,path]of [[Role.Emitted,"dist/large.js"],[Role.WorkspacePackage,"node_modules/@vioxen/agent-account-observability/dist/large.js"],[Role.Toolchain,"bin/large-tool"]]as const){const m=manifestFixture();addSizedFrame(m,role,path,measuredDependencyBytes);expect(()=>parse(m)).toThrow(/PUBLIC_STAGE_HOLD:row$/);}
 const tracked=manifestFixture();tracked.tracked[0]!.bytes=measuredDependencyBytes;expect(()=>parse(tracked)).toThrow(/PUBLIC_STAGE_HOLD:row$/);
 const bundle=manifestFixture();bundle.bundle.bytes=measuredDependencyBytes;expect(()=>parse(bundle)).toThrow("bundle_leaf");
});
it("requires exact Dependency role and allowed path before its larger allowance",()=>{
 for(const path of ["dist/claude","node_modules/.bin/claude","node_modules/@vioxen/agent-account-observability/claude"]){const m=manifestFixture();addSizedFrame(m,Role.Dependency,path,measuredDependencyBytes);expect(()=>parse(m)).toThrow("dependency_path");}
 const unknown=manifestFixture();addSizedFrame(unknown,"unknown_dependency" as Role,"node_modules/example/claude",measuredDependencyBytes);expect(()=>parse(unknown)).toThrow(/PUBLIC_STAGE_HOLD:role$/);
});
it("keeps the whole projection1GiB bound even when individual Dependency leaves pass",()=>{
 const m=manifestFixture();addSizedFrame(m,Role.Dependency,"node_modules/large-first/cli",dependencyMaximum);addSizedFrame(m,Role.Dependency,"node_modules/large-second/cli",dependencyMaximum);
 // Keep the payload declaration within its own pin limit to exercise the
 // independent whole tracked+frame aggregate, which now exceeds 1GiB.
 m.payload.bytes=1024**3;expect(()=>parse(m)).toThrow("whole_bounds");
});
