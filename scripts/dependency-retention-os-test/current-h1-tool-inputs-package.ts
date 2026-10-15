/** Fixed acquisition data validation. No process, grant, install or target execution. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";

export enum ToolInputArchitecture { Amd64="amd64", All="all" }
export const exactH1PackageSeeds=Object.freeze([
 "python3.12-minimal:amd64=3.12.3-1ubuntu0.17",
 "libpython3.12-minimal:amd64=3.12.3-1ubuntu0.17",
 "libpython3.12-stdlib:amd64=3.12.3-1ubuntu0.17",
 "libc6:amd64=2.39-0ubuntu8.9",
 "util-linux:amd64=2.39.3-9ubuntu6.6",
]);
export interface AcquiredSignedPackage {
 readonly package:string;readonly version:string;readonly arch:ToolInputArchitecture;
 readonly sha256:string;readonly size:number;readonly filename:string;
}
const held=(why:string):never=>{throw new Error("TEST AcquireMeasure Held: "+why);};
function requireFact(value:unknown,why:string):asserts value {if(!value)held(why);}
function fields(text:string):ReadonlyMap<string,string> {
 requireFact(Buffer.byteLength(text)<=4*1024*1024&&!text.includes("\0"),"metadata bound");
 const result=new Map<string,string>();
 for(const line of text.split("\n")) {
  if(line===""||/^\s/.test(line))continue;
  const split=line.indexOf(": ");requireFact(split>0,"metadata line");
  const key=line.slice(0,split);requireFact(/^[A-Za-z][A-Za-z0-9-]*$/.test(key)&&!result.has(key),"duplicate metadata field");
  result.set(key,line.slice(split+2));
 }
 return result;
}
export function parseAcquiredPackageFields(text:string):Readonly<{package:string;version:string;arch:ToolInputArchitecture}> {
 requireFact(text.trimEnd().split("\n").length===3,"single exact deb control stanza");
 const row=fields(text),name=row.get("Package"),version=row.get("Version"),arch=row.get("Architecture");
 requireFact(row.size===3&&typeof name==="string"&&/^[a-z0-9][a-z0-9+.-]*$/.test(name),"deb package field");
 requireFact(typeof version==="string"&&/^[A-Za-z0-9+.:~_-]+$/.test(version),"deb version field");
 requireFact(arch===ToolInputArchitecture.Amd64||arch===ToolInputArchitecture.All,"deb architecture");
 return Object.freeze({package:name,version,arch});
}
/** The metadata bytes must originate from the original isolated authenticated apt
 * index. This function compares data; it cannot authenticate a caller's string. */
export function joinAcquiredSignedPackage(debFields:string,metadata:string,archive:Readonly<{sha256:string;size:number}>):AcquiredSignedPackage {
 const expected=parseAcquiredPackageFields(debFields);requireFact(Buffer.byteLength(metadata)<=4*1024*1024,"metadata bound");
 requireFact(/^[a-f0-9]{64}$/.test(archive.sha256)&&Number.isSafeInteger(archive.size)&&archive.size>0,"archive bytes");
 let joined:AcquiredSignedPackage|undefined;
 for(const stanza of metadata.trim().split(/\n\n+/)) {
  const row=fields(stanza);
  if(row.get("Package")!==expected.package||row.get("Version")!==expected.version||row.get("Architecture")!==expected.arch)continue;
  const hash=row.get("SHA256"),size=row.get("Size"),filename=row.get("Filename");
  requireFact(hash===archive.sha256&&size===String(archive.size),"signed stanza hash/size");
  requireFact(typeof filename==="string"&&/^pool\/(?:[A-Za-z0-9_+.-]+\/)+[A-Za-z0-9_+.%~-]+\.deb$/.test(filename)&&!filename.split("/").includes(".."),"signed archive filename");
  const current=Object.freeze({...expected,sha256:hash,size:archive.size,filename});
  requireFact(!joined||JSON.stringify(joined)===JSON.stringify(current),"conflicting signed stanza");joined=current;
 }
 requireFact(joined,"exact signed Package/Version/Architecture stanza absent");return joined;
}
export function assertExactH1PackageSeeds(packages:readonly AcquiredSignedPackage[]):void {
 requireFact(packages.length>0&&packages.length<200,"solver package count");
 const seen=new Set<string>();for(const row of packages){requireFact(!seen.has(row.package),"duplicate solver package");seen.add(row.package);}
 for(const seed of exactH1PackageSeeds) {
  const equal=seed.indexOf("="),colon=seed.indexOf(":"),name=seed.slice(0,colon),version=seed.slice(equal+1);
  requireFact(packages.some(row=>row.package===name&&row.arch===ToolInputArchitecture.Amd64&&row.version===version),"exact seed missing or substituted");
 }
}
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
/** Original root-owned private acquisition archive, never a live executable. */
export function retainOriginalAcquiredArchive(path:string,revalidate:()=>void):Readonly<{sha256:string;size:number;fd:number;rejoin():void;close():void}> {
 revalidate();const before=lstatSync(path,{bigint:true});
 requireFact(before.isFile()&&before.uid===0n&&before.gid===0n&&before.nlink===1n&&!(before.mode&0o022n)&&before.size>0n&&before.size<=32n*1024n*1024n,"acquired archive custody/size");
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let kept=false,closed=false;
 const rejoin=()=>{requireFact(!closed,"archive already closed");revalidate();requireFact(identity(fstatSync(fd,{bigint:true}))===identity(before)&&identity(lstatSync(path,{bigint:true}))===identity(before),"original archive identity changed");revalidate();};
 try {
  requireFact(identity(fstatSync(fd,{bigint:true}))===identity(before),"archive open identity");
  const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let size=0;
  for(;;){revalidate();const n=readSync(fd,buffer,0,buffer.length,null);revalidate();if(n===0)break;size+=n;requireFact(size<=Number(before.size),"archive grew");hash.update(buffer.subarray(0,n));}
  requireFact(size===Number(before.size)&&identity(fstatSync(fd,{bigint:true}))===identity(before)&&identity(lstatSync(path,{bigint:true}))===identity(before),"archive bytes changed");
  const sha256=hash.digest("hex");rejoin();kept=true;return Object.freeze({sha256,size,fd,rejoin,close:()=>{if(!closed){closed=true;closeSync(fd);}}});
 } finally {if(!kept)closeSync(fd);}
}
export function hashOriginalAcquiredArchive(path:string,revalidate:()=>void):Readonly<{sha256:string;size:number}> {
 const retained=retainOriginalAcquiredArchive(path,revalidate);
 try{return Object.freeze({sha256:retained.sha256,size:retained.size});}finally{retained.close();}
}
