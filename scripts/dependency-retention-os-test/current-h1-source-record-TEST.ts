/** Authenticated archive association DATA only; no extraction, build or native authority. */
import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,lstatSync,openSync,readdirSync,readSync,type BigIntStats} from "node:fs";
import {joinAcquiredSignedPackage,type AcquiredSignedPackage} from "./current-h1-tool-inputs-package.ts";
import {assertCiPublicEvidenceBasename,assertCompleteUbuntuIndex,ciIndexOperationalBytes,type CiSignedIndexRow} from "./current-h1-tool-inputs-ci-index.ts";

export const h1SourceLimits=Object.freeze({artifactBytes:64*1024*1024,totalBytes:128*1024*1024,dscBytes:256*1024,artifacts:16});
export interface H1SourceIdentity {readonly name:string;readonly version:string}
export interface H1SourceIndexOrigin extends CiSignedIndexRow {readonly origin:string;readonly releaseSha256:string}
export interface H1SourceArtifact {readonly name:string;readonly sha256:string;readonly size:number}
export interface H1SourceSelection {
 readonly source:H1SourceIdentity;readonly binary:AcquiredSignedPackage;
 readonly binaryIndex:H1SourceIndexOrigin;readonly sourceIndex:H1SourceIndexOrigin;
 readonly stanzaSha256:string;readonly directory:string;readonly artifacts:readonly H1SourceArtifact[];
}
const hash=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const held=():never=>{throw new Error("TEST H1 source association Held");};
function need(v:unknown):asserts v {if(!v)held();}
const version=(v:string)=>/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~_-]*$/.test(v)&&v.length<=256;
const packageName=(v:string)=>/^[a-z0-9][a-z0-9+.-]+$/.test(v)&&v.length<=128;
function text(bytes:Buffer,maximum:number):string {
 need(bytes.length>0&&bytes.length<=maximum&&!bytes.includes(0)&&!bytes.includes(13));
 const value=bytes.toString("utf8");need(Buffer.from(value).equals(bytes));return value;
}
function fields(raw:string):ReadonlyMap<string,string> {
 need(Buffer.byteLength(raw)<=4*1024*1024);const result=new Map<string,string>();let last:string|undefined;
 for(const line of raw.trimEnd().split("\n")){
  need(line.length>0);
  if(/^[ \t]/.test(line)){need(last);result.set(last,result.get(last)!+"\n"+line.slice(1));continue;}
  const at=line.indexOf(":");need(at>0&&/^[A-Za-z][A-Za-z0-9-]*$/.test(line.slice(0,at)));
  const key=line.slice(0,at).toLowerCase();need(!result.has(key));result.set(key,line.slice(at+1).replace(/^ /,""));last=key;
 }return result;
}
function stanzas(bytes:Buffer,tick:()=>void,visit:(raw:string)=>void):void {
 need(bytes.length<=ciIndexOperationalBytes);let at=0;
 while(at<bytes.length){tick();const end=bytes.indexOf("\n\n",at),stop=end<0?bytes.length:end;
  if(stop>at)visit(text(bytes.subarray(at,stop),4*1024*1024));at=end<0?bytes.length:end+2;
 }tick();
}
/** Caller supplies the complete original authenticated index; association never grants authority. */
export function joinH1BinarySource(binary:AcquiredSignedPackage,index:Buffer,tick:()=>void):H1SourceIdentity|undefined {
 let source:H1SourceIdentity|undefined;
 stanzas(index,tick,raw=>{
  const row=fields(raw);if(row.get("package")!==binary.package||row.get("version")!==binary.version||row.get("architecture")!==binary.arch)return;
  const joined=joinAcquiredSignedPackage(`Package: ${binary.package}\nVersion: ${binary.version}\nArchitecture: ${binary.arch}\n`,raw,binary);
  need(JSON.stringify(joined)===JSON.stringify(binary));const field=row.get("source");
  const match=field===undefined?undefined:/^([a-z0-9][a-z0-9+.-]+)(?: \(([^ ()]+)\))?$/.exec(field);
  need(field===undefined||match);const current=Object.freeze({name:match?.[1]??binary.package,version:match?.[2]??binary.version});
  need(packageName(current.name)&&version(current.version));need(source===undefined||JSON.stringify(source)===JSON.stringify(current));source=current;
 });return source;
}
function artifactRows(value:string|undefined):readonly H1SourceArtifact[] {
 need(value!==undefined);const lines=value.split("\n");need(lines.shift()===""&&lines.length>0&&lines.length<=h1SourceLimits.artifacts);
 let total=0;const seen=new Set<string>();const rows=lines.map(line=>{
  const match=/^\s*([a-f0-9]{64}) ([1-9][0-9]*) ([A-Za-z0-9_.+%:~-]+)$/.exec(line);need(match);
  const name=match[3]!,size=Number(match[2]);assertCiPublicEvidenceBasename(name);
  need(!seen.has(name)&&Number.isSafeInteger(size)&&size<=h1SourceLimits.artifactBytes);seen.add(name);
  need(/\.(?:dsc|(?:orig(?:-[A-Za-z0-9+.-]+)?|debian)\.tar\.(?:xz|gz|bz2|lzma|zst)|diff\.gz)$/.test(name));
  total+=size;need(total<=h1SourceLimits.totalBytes);return Object.freeze({name,sha256:match[1]!,size});
 });need(rows.filter(row=>row.name.endsWith(".dsc")).length<=1);return Object.freeze(rows.sort((a,b)=>a.name<b.name?-1:1));
}
/** No cross-pocket/component merge: both full indices must join one signed Release. */
export function joinH1SourceSelection(binary:AcquiredSignedPackage,source:H1SourceIdentity,binaryIndex:H1SourceIndexOrigin,
 index:Buffer,sourceIndex:H1SourceIndexOrigin,tick:()=>void):H1SourceSelection {
 tick();need(binaryIndex.origin===sourceIndex.origin&&binaryIndex.releaseSha256===sourceIndex.releaseSha256&&/^[a-f0-9]{64}$/.test(binaryIndex.releaseSha256));
 const component=/^(main|universe)\/binary-amd64\/Packages$/.exec(binaryIndex.path)?.[1];need(component&&sourceIndex.path===component+"/source/Sources");
 assertCompleteUbuntuIndex(index,sourceIndex);let selected:H1SourceSelection|undefined;
 stanzas(index,tick,raw=>{
  const row=fields(raw);if(row.get("package")!==source.name||row.get("version")!==source.version)return;
  need(!selected);const directory=row.get("directory");need(directory&&/^pool\/(?:main|universe)\/(?:[A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_+.-]+$/.test(directory));
  need(!directory.split("/").some(part=>part==="."||part==="..")&&directory.split("/")[1]===component);
  const artifacts=artifactRows(row.get("checksums-sha256"));need(artifacts.filter(row=>row.name.endsWith(".dsc")).length===1);
  selected=Object.freeze({source:Object.freeze({...source}),binary,binaryIndex,sourceIndex,stanzaSha256:hash(raw),directory,artifacts});
 });need(selected);tick();return selected;
}
function dscBody(bytes:Buffer):string {
 const raw=text(bytes,h1SourceLimits.dscBytes);
 if(!raw.startsWith("-----BEGIN PGP SIGNED MESSAGE-----\n")){need(!raw.includes("-----BEGIN PGP")&&!raw.includes("-----END PGP"));return raw;}
 const split=raw.indexOf("\n\n"),signature=raw.indexOf("\n-----BEGIN PGP SIGNATURE-----\n");need(split>0&&signature>split);
 const headers=raw.slice("-----BEGIN PGP SIGNED MESSAGE-----\n".length,split).split("\n");need(headers.length===1&&headers.every(line=>/^Hash: (?:SHA256|SHA384|SHA512)(?:, ?(?:SHA256|SHA384|SHA512))*$/.test(line)));
 const armor=raw.slice(signature+1);need(/^-----BEGIN PGP SIGNATURE-----\n(?:(?:Version|Comment): [^\r\n]*\n)*\n(?:[A-Za-z0-9+/]{1,76}={0,2}\n)+(?:=[A-Za-z0-9+/]{4}\n)?-----END PGP SIGNATURE-----\n?$/.test(armor));
 return raw.slice(split+2,signature).split("\n").map(line=>{if(line.startsWith("-")){need(line.startsWith("- "));return line.slice(2);}return line;}).join("\n");
}
/** Archive hash authenticates the entire .dsc framing; this does not verify an uploader key. */
export function validateH1SourceDsc(selection:H1SourceSelection,bytes:Buffer):void {
 const original=selection.artifacts.find(row=>row.name.endsWith(".dsc"));need(original&&bytes.length===original.size&&hash(bytes)===original.sha256);
 const row=fields(dscBody(bytes));need(row.get("format")==="3.0 (quilt)"&&row.get("source")===selection.source.name&&row.get("version")===selection.source.version);
 const artifacts=artifactRows(row.get("checksums-sha256"));need(!artifacts.some(row=>row.name.endsWith(".dsc")));
 need(JSON.stringify(artifacts)===JSON.stringify(selection.artifacts.filter(row=>!row.name.endsWith(".dsc"))));
}
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
/** Retain exact downloaded originals through selected binary acquisition; no extraction. */
export function retainH1SourceArchives(root:string,selection:H1SourceSelection,tick:()=>void){
 tick();need(selection.artifacts.length>0&&selection.artifacts.length<=h1SourceLimits.artifacts);let total=0;
 for(const row of selection.artifacts){assertCiPublicEvidenceBasename(row.name);need(Number.isSafeInteger(row.size)&&row.size>0&&row.size<=h1SourceLimits.artifactBytes&&/^[a-f0-9]{64}$/.test(row.sha256));total+=row.size;need(total<=h1SourceLimits.totalBytes);}
 need(new Set(selection.artifacts.map(row=>row.name)).size===selection.artifacts.length);
 const initial=lstatSync(root,{bigint:true});need(initial.isDirectory()&&initial.uid===0n&&initial.gid===0n&&(initial.mode&0o7777n)===0o700n);
 const directory=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),held=new Map<string,{fd:number;stamp:string;row:H1SourceArtifact}>();let closed=false;
 const finish=()=>{if(closed)return;closed=true;for(const item of held.values())closeSync(item.fd);closeSync(directory);};
 const rejoin=()=>{try{need(!closed);tick();need(stamp(fstatSync(directory,{bigint:true}))===stamp(initial)&&stamp(lstatSync(root,{bigint:true}))===stamp(initial));
  need(JSON.stringify(readdirSync(`/proc/self/fd/${directory}`).sort())===JSON.stringify(selection.artifacts.map(row=>row.name).sort()));
  for(const [name,item] of held){need(stamp(fstatSync(item.fd,{bigint:true}))===item.stamp&&stamp(lstatSync(`/proc/self/fd/${directory}/${name}`,{bigint:true}))===item.stamp);}tick();}catch(error){finish();throw error;}};
 const read=(name:string):Buffer=>{try{rejoin();const item=held.get(name);need(item);const buffer=Buffer.alloc(item.row.size+1);let at=0;
  for(;;){tick();const n=readSync(item.fd,buffer,at,buffer.length-at,at);tick();if(n===0)break;at+=n;need(at<=item.row.size);}need(at===item.row.size&&hash(buffer.subarray(0,at))===item.row.sha256);rejoin();return buffer.subarray(0,at);}catch(error){finish();throw error;}};
 try{
  need(stamp(fstatSync(directory,{bigint:true}))===stamp(initial));
  for(const row of selection.artifacts){tick();const path=`/proc/self/fd/${directory}/${row.name}`,before=lstatSync(path,{bigint:true});
   need(before.isFile()&&before.uid===0n&&before.gid===0n&&before.nlink===1n&&!(before.mode&0o022n)&&before.size===BigInt(row.size));
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);held.set(row.name,{fd,stamp:stamp(before),row});need(stamp(fstatSync(fd,{bigint:true}))===stamp(before));
  }
  rejoin();for(const row of selection.artifacts){const bytes=read(row.name);if(row.name.endsWith(".dsc"))validateH1SourceDsc(selection,bytes);}
  return Object.freeze({rejoin,read,close:finish});
 }catch(error){finish();throw error;}
}
