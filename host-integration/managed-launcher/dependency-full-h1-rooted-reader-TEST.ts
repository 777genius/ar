/** Retained-root filesystem DATA adapter. No process/namespace/native admission. */
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,readlinkSync,readdirSync,type BigIntStats} from "node:fs";
import {performance} from "node:perf_hooks";
export interface H1RootedEnvelopeDataReader {
 readonly rootIdentity:string;
 stat(path:string):BigIntStats;
 names(path:string):readonly string[];
 bytes(path:string,maximum:number):Buffer;
 literal(path:string):Buffer;
 revalidate():void;
 descriptors():readonly number[];
 close():void;
}
const tuple=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const object=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode].map(String).join(":");
function need(v:unknown):asserts v {if(!v)throw Error("TEST H1 rooted DATA Held");}
/** Duplicate one retained root FD for DATA observation only. Callers cannot
 * enroll this reader/result into native parent WeakMaps. No root path fallback. */
export function retainH1EnvelopeRootData(rootFd:number,deadline:number):H1RootedEnvelopeDataReader {
 need(process.platform==="linux"&&Number.isSafeInteger(rootFd)&&rootFd>=0&&Number.isFinite(deadline));
 const before=fstatSync(rootFd,{bigint:true});need(before.isDirectory()&&before.uid===0n&&before.gid===0n&&!(before.mode&0o022n));
 const owned=openSync(`/proc/self/fd/${rootFd}`,constants.O_RDONLY|constants.O_DIRECTORY),initial=fstatSync(owned,{bigint:true});
 let closed=false;const held=new Map<string,{fd:number;identity:string;parent:number;name:string}>();
 const tick=()=>need(!closed&&performance.now()<deadline);
 const parts=(path:string)=>{need(typeof path==="string"&&path.startsWith("/")&&path.length<=4096);const a=path.slice(1).split("/");need(a.length<=2047&&a.every(n=>/^[A-Za-z0-9_+@.-]+$/.test(n)&&n!=="."&&n!==".."));return a;};
 function revalidate(){tick();need(tuple(fstatSync(rootFd,{bigint:true}))===tuple(before)&&tuple(fstatSync(owned,{bigint:true}))===tuple(initial));for(const d of held.values()){tick();need(tuple(fstatSync(d.fd,{bigint:true}))===d.identity&&tuple(lstatSync(`/proc/self/fd/${d.parent}/${d.name}`,{bigint:true}))===d.identity);}tick();}
 function parent(path:string):{fd:number;name:string}{tick();const a=parts(path),name=a.pop();need(name);let fd=owned,key="";for(const n of a){key+="/"+n;let d=held.get(key);if(!d){need(held.size<256);const child=openSync(`/proc/self/fd/${fd}/${n}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=fstatSync(child,{bigint:true});need(s.isDirectory()&&s.uid===0n&&s.gid===0n&&!(s.mode&0o022n));d={fd:child,identity:tuple(s),parent:fd,name:n};held.set(key,d);}catch(e){closeSync(child);throw e;}}fd=d.fd;}revalidate();return {fd,name};}
 function stat(path:string){const p=parent(path),s=lstatSync(`/proc/self/fd/${p.fd}/${p.name}`,{bigint:true});tick();return s;}
 function regular(path:string,maximum:number){need(Number.isSafeInteger(maximum)&&maximum>=0&&maximum<=32*1024*1024);const p=parent(path),location=`/proc/self/fd/${p.fd}/${p.name}`,s=lstatSync(location,{bigint:true});need(s.isFile()&&s.uid===0n&&s.gid===0n&&s.nlink===1n&&!(s.mode&0o022n)&&s.size<=BigInt(maximum));const fd=openSync(location,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{need(tuple(fstatSync(fd,{bigint:true}))===tuple(s));const chunks:Buffer[]=[];let total=0;for(;;){tick();const b=Buffer.alloc(Math.min(65536,maximum-total+1)),n=readSync(fd,b,0,b.length,total);tick();if(!n)break;total+=n;need(total<=maximum);chunks.push(b.subarray(0,n));}need(BigInt(total)===s.size&&tuple(fstatSync(fd,{bigint:true}))===tuple(s)&&tuple(lstatSync(location,{bigint:true}))===tuple(s));revalidate();return Buffer.concat(chunks,total);}finally{closeSync(fd);}}
 function names(path:string){const p=parent(path),location=`/proc/self/fd/${p.fd}/${p.name}`,s=lstatSync(location,{bigint:true});need(s.isDirectory()&&s.uid===0n&&s.gid===0n&&!(s.mode&0o022n));const fd=openSync(location,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{need(tuple(fstatSync(fd,{bigint:true}))===tuple(s));const rows=readdirSync(`/proc/self/fd/${fd}`,{encoding:"buffer"});need(rows.length<=20000);const result=rows.map(b=>{const n=b.toString("ascii");need(b.equals(Buffer.from(n))&&/^[A-Za-z0-9_+@.-]+$/.test(n)&&n!=="."&&n!=="..");return n;});need(tuple(fstatSync(fd,{bigint:true}))===tuple(s)&&tuple(lstatSync(location,{bigint:true}))===tuple(s));revalidate();return Object.freeze(result.sort());}finally{closeSync(fd);}}
 function literal(path:string){const p=parent(path),location=`/proc/self/fd/${p.fd}/${p.name}`,s=lstatSync(location,{bigint:true});need(s.isSymbolicLink()&&s.nlink===1n&&s.uid===0n&&s.gid===0n&&s.size<=4096n);const b=readlinkSync(location,{encoding:"buffer"});need(BigInt(b.length)===s.size&&tuple(lstatSync(location,{bigint:true}))===tuple(s));revalidate();return b;}
 try{need(object(before)===object(initial));revalidate();return Object.freeze({rootIdentity:object(initial),stat,names,bytes:regular,literal,revalidate,descriptors(){revalidate();return Object.freeze([owned,...[...held.values()].map(row=>row.fd)]);},close(){if(closed)return;closed=true;for(const d of [...held.values()].reverse())closeSync(d.fd);closeSync(owned);}});}catch(e){for(const d of [...held.values()].reverse())closeSync(d.fd);closeSync(owned);throw e;}
}
