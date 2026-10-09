/** SOURCE proposal. Only the original private H1 reader may supply ReviewAuthority.
 * No launch capability; authentication/namespace integration remains mandatory. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, type BigIntStats } from "node:fs";
import { posix } from "node:path";
import { types } from "node:util";

export enum PythonEnvelopeKind { Directory="directory", Source="source", Elf="elf", Alias="alias", Data="data" }
enum EnvelopeLocation { SignedExtraction="signed-extraction", OriginalNamespace="original-namespace" }
export enum PythonBackend { OpenSsl3="openssl3", BuiltinSha256="builtin-sha256" }
export interface EnvelopeLimits { readonly entries:number; readonly bytes:number; readonly fileBytes:number; readonly depth:number; readonly elapsedMs:number; readonly catalogBytes:number }
export interface SignedPackage { readonly package:string; readonly version:string; readonly arch:"amd64"|"all"; readonly sha256:string; readonly size:number }
export interface EnvelopeEntry { readonly path:string; readonly kind:PythonEnvelopeKind; readonly mode:number; readonly bytes:number; readonly sha256:string; readonly target:string }
export interface PythonEnvelopeCatalog { readonly schemaVersion:1; readonly packages:readonly SignedPackage[]; readonly entries:readonly EnvelopeEntry[] }
export interface EnvelopeMeasurement { readonly entries:number; readonly bytes:number; readonly largestFile:number; readonly depth:number }
export interface ElfFacts { readonly needed:readonly string[]; readonly runpath:readonly string[]; readonly rpath:readonly string[]; readonly interpreter:string|null }
const roots=Object.freeze(["/usr/lib","/usr/lib64","/usr/bin/python3.12"]);
const search=Object.freeze(["/usr/lib/x86_64-linux-gnu","/usr/lib","/usr/lib64"]);
const hwcaps=Object.freeze(["x86-64-v2","x86-64-v3","x86-64-v4"]);
export const pythonEnvelopeCache="/run/TEST-full-outer-review/python-pycache-empty";
const guards=Object.freeze(["/etc/ld.so.preload","/etc/ld.so.cache","/etc/ld.so.conf","/etc/ld.so.conf.d",
  "/etc/ssl/openssl.cnf","/usr/lib/ssl/openssl.cnf","/usr/local/lib/python3.12","/usr/local/lib/python312.zip",
  "/usr/lib/python312.zip","/usr/bin/pyvenv.cfg","/usr/pyvenv.cfg","/usr/bin/python3.12._pth",
  "/usr/bin/python3._pth","/usr/bin/pybuilddir.txt","/usr/bin/Modules/Setup.local",
  "/proc/self/fd/pyvenv.cfg","/proc/self/pyvenv.cfg","/proc/self/fd/12._pth"]);
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const fail=(why:string):never=>{throw new Error("TEST H1 Python envelope Held: "+why);};
function requireThat(v:unknown,why:string):asserts v {if(!v)fail(why);}
function safePath(path:string):void {requireThat(path.startsWith("/") && path.length<=4096 && /^\/[A-Za-z0-9_+./@-]+$/.test(path) && !path.split("/").some(p=>p==="."||p==="..") && !path.includes("//") && !path.endsWith("/"),"noncanonical path");}
function noBytecodeArchive(path:string):void {requireThat(!/\.(?:pyc|pyo|zip)$/.test(path),"competing bytecode/archive");}
function under(path:string,root:string):boolean{return path===root||path.startsWith(root+"/");}
function member(path:string):boolean{return roots.some(root=>under(path,root));}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
 requireThat(value!==null && typeof value==="object" && !types.isProxy(value) && Object.getPrototypeOf(value)===Object.prototype,"data object");
 const descriptors=Object.getOwnPropertyDescriptors(value); requireThat(Reflect.ownKeys(descriptors).length===keys.length,"data keys");
 const result:Record<string,unknown>={};for(const key of keys){const d=descriptors[key];requireThat(d && d.enumerable && Object.hasOwn(d,"value"),"data descriptor");result[key]=d.value;}return result;
}
function integer(v:unknown):v is number{return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;}
function digest(v:unknown):v is string{return typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);}
function limits(v:EnvelopeLimits):void {for(const n of Object.values(v))requireThat(integer(n)&&n>0,"unmeasured limits");requireThat(v.fileBytes<=v.bytes,"file bound");}
function packageRows(rows:unknown):readonly SignedPackage[]{
 requireThat(Array.isArray(rows)&&!types.isProxy(rows)&&rows.length>0,"signed packages");let prior="";
 return Object.freeze(rows.map(value=>{const r=fields(value,["package","version","arch","sha256","size"]);
 requireThat(typeof r.package==="string"&&/^[a-z0-9][a-z0-9+.-]*$/.test(r.package)&&r.package>prior,"package order");prior=r.package;
 requireThat(typeof r.version==="string"&&/^[A-Za-z0-9+.:~_-]+$/.test(r.version)&&(r.arch==="amd64"||r.arch==="all")&&digest(r.sha256)&&integer(r.size)&&r.size>0,"package pin");
 return Object.freeze({package:r.package,version:r.version,arch:r.arch,sha256:r.sha256,size:r.size});}));
}
/** Trust comes from original review's exact independently issued digest, not this parser. */
export function parsePythonEnvelopeCatalog(bytes:Buffer,expectedSha256:string,bounds:EnvelopeLimits):PythonEnvelopeCatalog {
 limits(bounds);const started=process.hrtime.bigint();const tick=()=>requireThat(process.hrtime.bigint()-started<BigInt(bounds.elapsedMs)*1000000n,"catalog deadline");tick();requireThat(bytes.length<=bounds.catalogBytes,"catalog byte limit");requireThat(digest(expectedSha256)&&sha(bytes)===expectedSha256,"catalog commitment");
 // A bounded original reader must supply these bytes; entry bound additionally rejects huge JSON lists.
 tick();const parsed=JSON.parse(bytes.toString("utf8")) as unknown;tick();const r=fields(parsed,["schemaVersion","packages","entries"]);
 requireThat(r.schemaVersion===1&&Array.isArray(r.entries)&&r.entries.length>0&&r.entries.length<=bounds.entries,"catalog schema/count");
 requireThat(Array.isArray(r.packages)&&r.packages.length<=bounds.entries,"package count");const packages=packageRows(r.packages);let prior="",total=0;
 const entries=r.entries.map((value:unknown)=>{tick();const row=fields(value,["path","kind","mode","bytes","sha256","target"]);
 requireThat(typeof row.path==="string"&&member(row.path)&&row.path>prior,"catalog path order");safePath(row.path);noBytecodeArchive(row.path);prior=row.path;
 requireThat(Object.values(PythonEnvelopeKind).includes(row.kind as PythonEnvelopeKind)&&integer(row.mode)&&row.mode<=0o7777&&!(row.mode&0o022)&&integer(row.bytes)&&row.bytes<=bounds.fileBytes&&digest(row.sha256)&&typeof row.target==="string","catalog row");
 total+=row.bytes;requireThat(Number.isSafeInteger(total)&&total<=bounds.bytes,"catalog byte limit");
 if(row.kind===PythonEnvelopeKind.Alias){safePath(row.target);requireThat(member(row.target),"alias escape");}else requireThat(row.target==="","unexpected alias target");
 if(row.kind===PythonEnvelopeKind.Directory)requireThat(row.bytes===0&&row.sha256===sha(Buffer.alloc(0)),"directory catalog");
 return Object.freeze({path:row.path,kind:row.kind as PythonEnvelopeKind,mode:row.mode,bytes:row.bytes,sha256:row.sha256,target:row.target});});
 tick();return Object.freeze({schemaVersion:1,packages,entries:Object.freeze(entries)});
}
const tuple=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
function metadata(s:BigIntStats,device:bigint):void {requireThat(s.dev===device&&s.uid===0n&&s.gid===0n&&(s.isSymbolicLink()||!(s.mode&0o022n)),"metadata/mount/owner");if(!s.isDirectory())requireThat(s.nlink===1n,"hardlink");}
function boundedFile(path:string,before:BigIntStats,bound:number,tick:()=>void):Buffer {
 requireThat(before.isFile()&&before.size<=BigInt(bound),"file size/type");
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{requireThat(tuple(fstatSync(fd,{bigint:true}))===tuple(before),"open identity");
 const chunks:Buffer[]=[];let size=0;while(true){tick();const room=bound-size;const b=Buffer.alloc(Math.min(65536,room+1));const n=readSync(fd,b,0,b.length,null);tick();if(n===0)break;size+=n;requireThat(size<=bound,"complete file limit");chunks.push(b.subarray(0,n));}
 requireThat(size===Number(before.size)&&tuple(fstatSync(fd,{bigint:true}))===tuple(before)&&tuple(lstatSync(path,{bigint:true}))===tuple(before),"file replacement");tick();const bytes=Buffer.concat(chunks,size);tick();return bytes;
 }finally{closeSync(fd);}
}
export interface CapturedEnvelope { readonly catalog:PythonEnvelopeCatalog; readonly measurement:EnvelopeMeasurement; readonly elf:ReadonlyMap<string,ElfFacts> }
/** Read-only signed-extraction/live census. No executable or script is launched.
 * Physical prefix must already be exclusively owned; live use additionally needs authority below. */
export function capturePythonEnvelope(prefix:string,packages:readonly SignedPackage[],bounds:EnvelopeLimits):CapturedEnvelope {
 safePath(prefix);return captureEnvelope(EnvelopeLocation.SignedExtraction,prefix,packages,bounds);
}
function captureEnvelope(location:EnvelopeLocation,prefix:string,packages:readonly SignedPackage[],bounds:EnvelopeLimits):CapturedEnvelope {
 requireThat(location===EnvelopeLocation.SignedExtraction||location===EnvelopeLocation.OriginalNamespace,"root location");
 requireThat(location===EnvelopeLocation.OriginalNamespace?prefix==="":prefix!=="","root role");limits(bounds);if(prefix!=="")safePath(prefix);requireThat(packages.length<=bounds.entries,"package count");const base=lstatSync(prefix||"/",{bigint:true});requireThat(base.isDirectory()&&base.uid===0n&&base.gid===0n&&!(base.mode&0o022n),"prefix custody");const signed=packageRows(packages),device=base.dev;
 const start=process.hrtime.bigint();let count=0,total=0,largest=0,depth=0;const entries:EnvelopeEntry[]=[],elf=new Map<string,ElfFacts>();
 const tick=()=>requireThat(process.hrtime.bigint()-start<BigInt(bounds.elapsedMs)*1000000n,"census deadline");
 function walk(path:string,level:number):void {
 tick();requireThat(++count<=bounds.entries&&level<=bounds.depth,"census entry/depth limit");depth=Math.max(depth,level);safePath(path);noBytecodeArchive(path);
 const named=prefix+path,before=lstatSync(named,{bigint:true});metadata(before,device);const mode=Number(before.mode&0o7777n);
 if(before.isDirectory()){
  entries.push(Object.freeze({path,kind:PythonEnvelopeKind.Directory,mode,bytes:0,sha256:sha(Buffer.alloc(0)),target:""}));
  const fd=openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{
   requireThat(tuple(fstatSync(fd,{bigint:true}))===tuple(before),"directory open identity");const dir=opendirSync(process.platform==="linux"?`/proc/self/fd/${fd}`:named);try{for(let entry=dir.readSync();entry!==null;entry=dir.readSync()){tick();requireThat(/^[A-Za-z0-9_+@.-]+$/.test(entry.name)&&entry.name!=="."&&entry.name!=="..","directory entry");walk(path+"/"+entry.name,level+1);}}finally{dir.closeSync();}
   requireThat(tuple(fstatSync(fd,{bigint:true}))===tuple(before)&&tuple(lstatSync(named,{bigint:true}))===tuple(before),"directory replacement");
  }finally{closeSync(fd);}return;
 }
 if(before.isSymbolicLink()){
  const literal=readlinkSync(named);tick();const aliasBytes=Buffer.byteLength(literal);requireThat(aliasBytes<=4096&&aliasBytes<=bounds.fileBytes,"alias length/file limit");largest=Math.max(largest,aliasBytes);
  const target=literal.startsWith("/")?literal:posix.resolve(posix.dirname(path),literal);safePath(target);requireThat(member(target),"alias escape");
  requireThat(tuple(lstatSync(named,{bigint:true}))===tuple(before),"alias replacement");
  entries.push(Object.freeze({path,kind:PythonEnvelopeKind.Alias,mode:0o555,bytes:Buffer.byteLength(literal),sha256:sha(literal),target}));total+=Buffer.byteLength(literal);requireThat(total<=bounds.bytes,"total byte limit");return;
 }
 requireThat(before.isFile(),"special file");const size=Number(before.size);requireThat(Number.isSafeInteger(size)&&size<=bounds.fileBytes&&total+size<=bounds.bytes,"total/file byte limit");
 const bytes=boundedFile(named,before,bounds.fileBytes,tick);tick();total+=bytes.length;largest=Math.max(largest,bytes.length);
 let kind=path.endsWith(".py")?PythonEnvelopeKind.Source:PythonEnvelopeKind.Data;
 if(bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))){kind=PythonEnvelopeKind.Elf;elf.set(path,parsePythonEnvelopeElf(bytes));tick();}
 else requireThat(!/\.so(?:\.[A-Za-z0-9_.+-]+)?$/.test(path),"non-ELF extension");
 const hashed=sha(bytes);tick();entries.push(Object.freeze({path,kind,mode,bytes:bytes.length,sha256:hashed,target:""}));
 }
 for(const root of roots)walk(root,1); entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);requireThat(tuple(lstatSync(prefix||"/",{bigint:true}))===tuple(base),"prefix replacement");tick();
 return Object.freeze({catalog:Object.freeze({schemaVersion:1,packages:signed,entries:Object.freeze(entries)}),measurement:Object.freeze({entries:count,bytes:total,largestFile:largest,depth}),elf});
}
/** Narrow ELF64 little-endian x86-64 parser. Unsupported audited/config/filter/auxiliary code-selection routes refuse. */
export function parsePythonEnvelopeElf(bytes:Buffer):ElfFacts {
 requireThat(bytes.length>=64&&bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&bytes[4]===2&&bytes[5]===1&&bytes[6]===1&&bytes.readUInt16LE(18)===62,"ELF target");
 const number=(n:bigint)=>{requireThat(n<=BigInt(Number.MAX_SAFE_INTEGER),"ELF integer");return Number(n);};
 const range=(offset:number,size:number)=>requireThat(integer(offset)&&integer(size)&&offset+size<=bytes.length,"ELF range");
 const ph=number(bytes.readBigUInt64LE(32)),width=bytes.readUInt16LE(54),count=bytes.readUInt16LE(56);requireThat(width===56&&count>0&&count!==65535,"ELF program table");range(ph,width*count);
 const loads:{va:number;offset:number;size:number}[]=[],dynamic:{offset:number;size:number}[]=[];let interpreter:string|null=null;
 const text=(offset:number,max:number)=>{range(offset,max);const end=bytes.indexOf(0,offset);requireThat(end>=offset&&end<offset+max,"ELF string terminator");const raw=bytes.subarray(offset,end);requireThat(raw.every(b=>b>=0x20&&b<=0x7e),"ELF string encoding");return raw.toString("ascii");};
 for(let i=0;i<count;i++){const p=ph+i*width,type=bytes.readUInt32LE(p),offset=number(bytes.readBigUInt64LE(p+8)),va=number(bytes.readBigUInt64LE(p+16)),size=number(bytes.readBigUInt64LE(p+32));range(offset,size);
 if(type===1)loads.push({va,offset,size});if(type===2)dynamic.push({offset,size});if(type===3){requireThat(interpreter===null,"ELF multiple interpreters");interpreter=text(offset,size);requireThat(interpreter==="/lib64/ld-linux-x86-64.so.2","ELF interpreter escape");}}
 requireThat(dynamic.length<=1,"ELF dynamic table");if(dynamic.length===0)return Object.freeze({needed:Object.freeze([]),runpath:Object.freeze([]),rpath:Object.freeze([]),interpreter});
 const table=dynamic[0]!;requireThat(table.size%16===0,"ELF dynamic size");let strVa:number|undefined,strSize:number|undefined,ended=false;const rows:{tag:bigint;value:number}[]=[];
 for(let at=table.offset;at<table.offset+table.size;at+=16){const tag=bytes.readBigInt64LE(at),value=number(bytes.readBigUInt64LE(at+8));if(tag===0n){ended=true;break;}if(tag===5n){requireThat(strVa===undefined,"ELF duplicate strtab");strVa=value;}if(tag===10n){requireThat(strSize===undefined,"ELF duplicate strsize");strSize=value;}
 requireThat(![0x6ffffefan,0x6ffffefbn,0x6ffffefcn,0x7ffffffdn,0x7fffffffn].includes(tag),"ELF audit/filter/auxiliary route");rows.push({tag,value});}
 requireThat(ended&&strVa!==undefined&&strSize!==undefined&&strSize>0,"ELF dynamic completeness");const segments=loads.filter(s=>strVa!>=s.va&&strVa!+strSize!<=s.va+s.size);requireThat(segments.length===1,"ELF string mapping");const s=segments[0]!,base=s.offset+strVa-s.va;range(base,strSize);
 const values=(tag:bigint)=>rows.filter(r=>r.tag===tag).map(r=>{requireThat(r.value<strSize!,"ELF string offset");return text(base+r.value,strSize!-r.value);});
 const needed=values(1n);for(const name of [...needed,...values(14n)])requireThat(/^[A-Za-z0-9_+.-]+$/.test(name),"ELF dependency/soname escape");
 const paths=(tag:bigint)=>{const v=values(tag);requireThat(v.length<=1,"ELF duplicate search path");return v.length?v[0]!.split(":"):[];};
 return Object.freeze({needed:Object.freeze(needed),runpath:Object.freeze(paths(29n)),rpath:Object.freeze(paths(15n)),interpreter});
}
function aliasTarget(path:string,catalog:ReadonlyMap<string,EnvelopeEntry>):string {
 const seen=new Set<string>();while(true){requireThat(!seen.has(path),"alias cycle");seen.add(path);const row=catalog.get(path);requireThat(row,"missing alias target");if(row.kind!==PythonEnvelopeKind.Alias)return path;path=row.target;}
}
/** Complete alternatives, including active/future hwcaps, must all resolve inside signed set. */
export function validatePythonEnvelopeLoader(captured:CapturedEnvelope,backend:PythonBackend):ReadonlyMap<string,readonly string[]> {
 requireThat(backend===PythonBackend.OpenSsl3||backend===PythonBackend.BuiltinSha256,"unknown native backend");
 const catalog=new Map(captured.catalog.entries.map(row=>[row.path,row]));const graph=new Map<string,readonly string[]>();
 for(const row of captured.catalog.entries){noBytecodeArchive(row.path);if(row.kind===PythonEnvelopeKind.Alias){const canonical=aliasTarget(row.path,catalog),kind=catalog.get(canonical)?.kind;if(row.path.endsWith(".py"))requireThat(kind===PythonEnvelopeKind.Source,"source alias type");if(/\.so(?:\.[A-Za-z0-9_.+-]+)?$/.test(row.path))requireThat(kind===PythonEnvelopeKind.Elf,"extension alias type");}}
 for(const [path,facts] of captured.elf){
  const expand=(value:string)=>{requireThat(value!=="","ELF empty search path");const expanded=value.replace(/\$\{ORIGIN\}|\$ORIGIN/g,posix.dirname(path));requireThat(!expanded.includes("$"),"ELF unsupported token");safePath(expanded);requireThat(member(expanded)&&catalog.get(expanded)?.kind===PythonEnvelopeKind.Directory,"ELF RPATH/RUNPATH escape");return expanded;};
  const local=[...facts.rpath,...facts.runpath].map(expand),paths=[...local,...search];const targets=new Set<string>();
  for(const name of facts.needed){let matched=false;for(const dir of paths){for(const candidate of [dir+"/"+name,...hwcaps.map(level=>dir+"/glibc-hwcaps/"+level+"/"+name)]){
    if(!catalog.has(candidate))continue;const canonical=aliasTarget(candidate,catalog);requireThat(catalog.get(canonical)?.kind===PythonEnvelopeKind.Elf,"ELF noncode dependency");targets.add(canonical);matched=true;
  }}requireThat(matched,"unresolved ELF dependency");}
  if(facts.interpreter!==null){const canonical=aliasTarget("/usr/lib64/ld-linux-x86-64.so.2",catalog);requireThat(catalog.get(canonical)?.kind===PythonEnvelopeKind.Elf,"missing signed loader");targets.add(canonical);}
  graph.set(path,Object.freeze([...targets].sort()));
 }
 if(backend===PythonBackend.OpenSsl3){requireThat(catalog.get("/usr/lib/x86_64-linux-gnu/ossl-modules")?.kind===PythonEnvelopeKind.Directory,"uncovered OpenSSL provider domain");for(const row of captured.catalog.entries)if(under(row.path,"/usr/lib/x86_64-linux-gnu/ossl-modules")&&row.kind!==PythonEnvelopeKind.Directory)requireThat(row.kind===PythonEnvelopeKind.Elf||row.kind===PythonEnvelopeKind.Alias,"provider non-ELF candidate");}
 return graph;
}
/** Original reader owns retained namespace/mount/root/alias identities and authenticates
 * both catalog and build policy from independently issued protected review. No caller booleans. */
export interface ReviewAuthority {
 readonly catalogSha256:string; readonly packagesSha256:string; readonly limits:EnvelopeLimits; readonly backend:PythonBackend;
 readAuthenticatedCatalog(maxBytes:number):Buffer;
 assertOriginalReadonlyNamespace(paths:readonly string[]):void;
 assertOriginalAbsentPaths(paths:readonly string[]):void;
 assertOriginalEmptyReadonlyDirectory(path:string):void;
 assertOriginalUsrAliases():void;
 assertOriginalRetainedRoot():void;
 assertAuthenticatedBuildRoutes():void;
 revalidateOriginalCustody():void;
}
export interface ValidatedPythonEnvelope { readonly catalogSha256:string; readonly measurement:EnvelopeMeasurement; readonly sources:readonly string[]; readonly argv:readonly string[] }
/** No effects: on ANY uncertainty no result is returned to the original reader. */
export function validatePythonEnvelope(authority:ReviewAuthority):ValidatedPythonEnvelope {
 limits(authority.limits);const started=process.hrtime.bigint();const tick=()=>requireThat(process.hrtime.bigint()-started<BigInt(authority.limits.elapsedMs)*1000000n,"validation deadline");tick();requireThat(digest(authority.catalogSha256)&&digest(authority.packagesSha256),"review commitments");
 authority.revalidateOriginalCustody();tick();authority.assertAuthenticatedBuildRoutes();tick();authority.assertOriginalUsrAliases();tick();authority.assertOriginalRetainedRoot();tick();
 authority.assertOriginalReadonlyNamespace(roots);tick();authority.assertOriginalAbsentPaths(guards);tick();authority.assertOriginalEmptyReadonlyDirectory(pythonEnvelopeCache);tick();
 tick();const catalogBytes=authority.readAuthenticatedCatalog(authority.limits.catalogBytes);tick();const expected=parsePythonEnvelopeCatalog(catalogBytes,authority.catalogSha256,authority.limits);
 requireThat(sha(JSON.stringify(expected.packages))===authority.packagesSha256,"signed package origin commitment");
 tick();const actual=captureEnvelope(EnvelopeLocation.OriginalNamespace,"",expected.packages,authority.limits);tick();
 requireThat(JSON.stringify(actual.catalog)===JSON.stringify(expected),"complete signed candidate reconciliation");validatePythonEnvelopeLoader(actual,authority.backend);tick();
 authority.revalidateOriginalCustody();tick();authority.assertOriginalReadonlyNamespace(roots);tick();authority.assertOriginalAbsentPaths(guards);tick();authority.assertOriginalEmptyReadonlyDirectory(pythonEnvelopeCache);tick();
 tick();const result=Object.freeze({catalogSha256:authority.catalogSha256,measurement:actual.measurement,sources:Object.freeze(actual.catalog.entries.filter(e=>e.kind===PythonEnvelopeKind.Source||e.kind===PythonEnvelopeKind.Elf).map(e=>e.path)),argv:Object.freeze(["-I","-S","-B","-X","pycache_prefix="+pythonEnvelopeCache])});tick();return result;
}
