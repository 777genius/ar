/** Finite H1 physical checks. Results are DATA; only the original lexical slot owns admission. */
import {createHash} from "node:crypto";
import {types} from "node:util";
import {posix} from "node:path";
import {H1CatalogKind,type H1StagedSubject,type H1CatalogEntry} from "./dependency-full-h1-staged-tools-TEST.js";
import {retainH1EnvelopeRootData} from "./dependency-full-h1-rooted-reader-TEST.js";
import {H1ElfRole,h1LibcCanonicalPath,validateH1ElfRole} from "./dependency-full-h1-elf-role-TEST.js";
import {parsePythonEnvelopeElf} from "./dependency-full-python-envelope-TEST.js";
export enum H1ConstructorHeld {Distro="protected_signed_distro_original_facts_missing",Verifier="distro_verifier_tcb_missing",LoadRoute="unqualified_load_route",Getpath="compiled_getpath_source_missing",Cache="readonly_empty_cache_missing",Python="foreign_python_routes",Source="source_object_changed",Actor="foreign_actor_status",Cgroup="foreign_cgroup_rows",Mount="unknown_api_object",Deadline="original_deadline_missing",Definition="constructor_source_definition_missing"}
const heldReasons=new WeakMap<object,H1ConstructorHeld>();
class H1Held extends Error {constructor(reason:H1ConstructorHeld){super("TEST H1 constructor Held: "+reason);heldReasons.set(this,reason);}}
const fail=(reason:H1ConstructorHeld):never=>{throw new H1Held(reason);};
export function readH1ConstructorHeld(error:unknown):H1ConstructorHeld|undefined{return !types.isProxy(error)&&types.isNativeError(error)&&Object.getPrototypeOf(error)===H1Held.prototype?heldReasons.get(error):undefined;}
function requireThat(v:unknown,reason:H1ConstructorHeld):asserts v {if(!v)fail(reason);}
export const h1HeldError=(reason:H1ConstructorHeld):never=>fail(reason);
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
export const h1ReadonlyCache="/nonexistent/TEST-h1-readonly-pycache";
const loader="/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
const libcSha256="3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf";
const programs=new Set(["/usr/bin/python3.12","/usr/bin/nsenter"]);
const directories=["/usr/lib/x86_64-linux-gnu","/usr/lib/x86_64-linux-gnu/systemd","/usr/lib","/usr/lib64"] as const;
const guards=["/etc/ld.so.preload","/etc/ld.so.cache","/etc/ld.so.conf","/etc/ld.so.conf.d","/etc/ssl/openssl.cnf","/usr/lib/ssl/openssl.cnf","/usr/local/lib/python3.12","/usr/local/lib/python312.zip","/usr/lib/python312.zip","/usr/bin/pyvenv.cfg","/usr/pyvenv.cfg","/usr/bin/python3.12._pth","/usr/bin/python3._pth","/usr/bin/pybuilddir.txt","/usr/bin/Modules/Setup.local"] as const;
/** Pure DATA cycle/escape validation; never opens a root or issues authority. */
export function h1CanonicalCatalogPath(catalog:readonly H1CatalogEntry[],path:string):string {
 const rows=new Map(catalog.map(row=>["/"+row.path,row]));requireThat(rows.size===catalog.length,H1ConstructorHeld.Source);
 const seen=new Set<string>();
 for(let count=0;count<=32;count++){
  requireThat(path.startsWith("/")&&posix.normalize(path)===path&&!seen.has(path),H1ConstructorHeld.LoadRoute);seen.add(path);
  // Resolve the first alias component, preserving remaining literal components.
  const components=path.slice(1).split("/");let redirected=false;
  for(let i=0;i<components.length;i++){
   const name="/"+components.slice(0,i+1).join("/"),row=rows.get(name);requireThat(row,H1ConstructorHeld.LoadRoute);
   if(row.kind===H1CatalogKind.Alias){requireThat(!row.target.startsWith("/")&&row.target.length>0,H1ConstructorHeld.LoadRoute);const relative=posix.normalize(posix.join(posix.dirname(name).slice(1),row.target));requireThat(relative!==".."&&!relative.startsWith("../")&&relative!==".",H1ConstructorHeld.LoadRoute);const target=posix.resolve(posix.dirname(name),row.target);requireThat(target!=="/",H1ConstructorHeld.LoadRoute);path=posix.join(target,...components.slice(i+1));redirected=true;break;}
   if(i<components.length-1)requireThat(row.kind===H1CatalogKind.Directory,H1ConstructorHeld.LoadRoute);
  }
  if(!redirected)return path;
 }
 return fail(H1ConstructorHeld.LoadRoute);
}
function closed(v:unknown,keys:readonly string[]):Record<string,unknown>{
 requireThat(v!==null&&typeof v==="object"&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype,H1ConstructorHeld.Python);
 const d=Object.getOwnPropertyDescriptors(v);requireThat(Reflect.ownKeys(d).length===keys.length,H1ConstructorHeld.Python);
 const result:Record<string,unknown>={};for(const key of keys){const item=d[key];requireThat(item&&item.enumerable&&Object.hasOwn(item,"value"),H1ConstructorHeld.Python);result[key]=item.value;}return result;
}
function list(v:unknown,maximum:number):unknown[]{
 requireThat(Array.isArray(v)&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Array.prototype,H1ConstructorHeld.Python);
 const length=Object.getOwnPropertyDescriptor(v,"length");requireThat(length&&Object.hasOwn(length,"value"),H1ConstructorHeld.Python);const size:unknown=length.value;
 requireThat(typeof size==="number"&&Number.isSafeInteger(size)&&size>=0&&size<=maximum&&Reflect.ownKeys(v).length===size+1,H1ConstructorHeld.Python);
 const result:unknown[]=[];for(let i=0;i<size;i++){const row=Object.getOwnPropertyDescriptor(v,String(i));requireThat(row&&row.enumerable&&Object.hasOwn(row,"value"),H1ConstructorHeld.Python);result.push(row.value);}return result;
}
/** Actual original-host cgroup rows; optional observed legacy root adds no authority. */
export function checkH1OwnedCgroupData(raw:string,expected:string,alternate?:string):void{
 const canonical=(path:string)=>path.length<=2048&&path.startsWith("/")&&path.slice(1).split("/").every(cell=>/^[A-Za-z0-9_.@+-]+$/.test(cell)&&cell!=="."&&cell!=="..");
 requireThat(canonical(expected)&&(alternate===undefined||(canonical(alternate)&&alternate!==expected))&&Buffer.byteLength(raw)<=4096&&raw.endsWith("\n"),H1ConstructorHeld.Cgroup);
 const rows=raw.slice(0,-1).split("\n");requireThat(rows.length>=1&&rows.length<=2,H1ConstructorHeld.Cgroup);let unified=0,legacy=0;
 for(const row of rows){if(row==="0::"+expected||(alternate!==undefined&&row==="0::"+alternate))unified++;else if(row==="1:name=systemd:/")legacy++;else fail(H1ConstructorHeld.Cgroup);}
 requireThat(unified===1&&legacy<=1&&unified+legacy===rows.length,H1ConstructorHeld.Cgroup);
}

/** Finite live report corroborates already proven load routes; it cannot authenticate imports. */
export function checkH1PythonRouteData(value:unknown,catalog:readonly H1CatalogEntry[]):void{
 const row=closed(value,["executable","prefix","execPrefix","path","isolated","noSite","dontWriteBytecode","cache","origArgv","modules"]);
 requireThat(row.executable==="/usr/bin/python3.12"&&row.prefix==="/usr"&&row.execPrefix==="/usr"&&row.isolated===1&&row.noSite===1&&row.dontWriteBytecode===true&&row.cache===h1ReadonlyCache,H1ConstructorHeld.Python);
 const expected=["/usr/lib/python312.zip","/usr/lib/python3.12","/usr/lib/python3.12/lib-dynload"];
 const paths=list(row.path,3);requireThat(paths.every(path=>typeof path==="string")&&JSON.stringify(paths)===JSON.stringify(expected),H1ConstructorHeld.Python);
 const argv=list(row.origArgv,7);requireThat(argv.every(value=>typeof value==="string")&&argv.length===7&&argv[0]==="/usr/bin/python3.12"&&JSON.stringify(argv.slice(1))===JSON.stringify(["-I","-S","-B","-X","pycache_prefix="+h1ReadonlyCache,"-c"]),H1ConstructorHeld.Python);
 const modules=list(row.modules,256);
 const rows=new Map(catalog.map(entry=>["/"+entry.path,entry]));let previous="";
 for(const item of modules){const value=list(item,2);requireThat(value.length===2&&typeof value[0]==="string"&&value[0]>previous&&typeof value[1]==="string",H1ConstructorHeld.Python);previous=value[0];
  const origin=value[1];if(origin==="built-in"||origin==="frozen")continue;
  requireThat(origin.startsWith("/usr/lib/python3.12/")&&!/\.(?:pyc|pyo|zip)$/.test(origin),H1ConstructorHeld.Python);
  requireThat(rows.get(h1CanonicalCatalogPath(catalog,origin))?.kind===H1CatalogKind.File,H1ConstructorHeld.Python);
 }
}
/** Read only through the retained physical root; never observes caller '/'. */
export function retainH1ConstructorLoadFacts(subject:H1StagedSubject,rootFd:number,deadline:number){
 const root=retainH1EnvelopeRootData(rootFd,deadline),rows=new Map(subject.catalog.map(row=>["/"+row.path,row]));
 function file(path:string){const canonical=h1CanonicalCatalogPath(subject.catalog,path),row=rows.get(canonical);requireThat(row?.kind===H1CatalogKind.File,H1ConstructorHeld.Source);
  const bytes=root.bytes(canonical,32*1024*1024);requireThat(sha(bytes)===row.sha256,H1ConstructorHeld.Source);if(canonical===h1LibcCanonicalPath)requireThat(row.sha256===libcSha256&&bytes.length===2129424,H1ConstructorHeld.Source);return bytes;}
 function absent(path:string){try{root.stat(path);}catch(error){if(error instanceof Error&&"code" in error&&error.code==="ENOENT")return;throw error;}fail(H1ConstructorHeld.LoadRoute);}
 function revalidate(){root.revalidate();for(const path of guards)absent(path);
  const cache=rows.get(h1ReadonlyCache);requireThat(cache?.kind===H1CatalogKind.Directory&&root.names(h1ReadonlyCache).length===0,H1ConstructorHeld.Cache);
  for(const alias of ["/lib","/lib64"]){const row=rows.get(alias);requireThat(row?.kind===H1CatalogKind.Alias&&row.target===(alias==="/lib"?"usr/lib":"usr/lib64"),H1ConstructorHeld.LoadRoute);requireThat(root.literal(alias).equals(Buffer.from(row.target)),H1ConstructorHeld.Source);}
  requireThat(h1CanonicalCatalogPath(subject.catalog,"/lib64/ld-linux-x86-64.so.2")===loader,H1ConstructorHeld.LoadRoute);
  for(const [path,row] of rows){if(row.kind!==H1CatalogKind.File)continue;requireThat(!/\.(?:pyc|pyo|zip)$/.test(path),H1ConstructorHeld.LoadRoute);
   const bytes=file(path),elf=bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]));if(!elf){requireThat(!/\.so(?:\.[A-Za-z0-9_.+-]+)?$/.test(path),H1ConstructorHeld.LoadRoute);continue;}
   if(path===loader)validateH1ElfRole(bytes,H1ElfRole.Loader);else if(programs.has(path))validateH1ElfRole(bytes,H1ElfRole.Program);else if(path===h1LibcCanonicalPath)validateH1ElfRole(bytes,H1ElfRole.Libc,"libc.so.6",path);else validateH1ElfRole(bytes,H1ElfRole.Extension);
   const facts=parsePythonEnvelopeElf(bytes);requireThat(facts.rpath.length===0&&facts.runpath.length===0,H1ConstructorHeld.LoadRoute);
   for(const name of facts.needed){requireThat(/^[A-Za-z0-9_+.-]+$/.test(name)&&name!=="."&&name!=="..",H1ConstructorHeld.LoadRoute);let found=false;
    for(const dir of directories)for(const prefix of [dir,...["x86-64-v2","x86-64-v3","x86-64-v4"].map(level=>dir+"/glibc-hwcaps/"+level)]){
     const candidate=prefix+"/"+name;if(!rows.has(candidate))continue;found=true;const canonical=h1CanonicalCatalogPath(subject.catalog,candidate),selected=file(candidate);if(name==="libc.so.6"&&canonical===h1LibcCanonicalPath)validateH1ElfRole(selected,H1ElfRole.Libc,name,canonical);else validateH1ElfRole(selected,H1ElfRole.SharedObject,name);
    }requireThat(found,H1ConstructorHeld.LoadRoute);
   }
  }
  for(const program of [loader,...programs])file(program);root.revalidate();
 }
 try{revalidate();return Object.freeze({revalidate,descriptors:root.descriptors,close:root.close});}catch(error){root.close();throw error;}
}
/** Status DATA check also used inside retained live actor reads. Exact masks are original parent facts. */
export enum H1PidView {Original="original",Guest="guest"}
export function checkH1ActorStatusData(raw:string,pid:number,capabilities:readonly string[],view=H1PidView.Original):void{
 requireThat((view===H1PidView.Original||view===H1PidView.Guest)&&Buffer.byteLength(raw)<=16384&&Number.isSafeInteger(pid)&&pid>1&&capabilities.length===5&&capabilities.every(value=>/^[0-9a-f]{16}$/.test(value)),H1ConstructorHeld.Actor);
 for(const key of ["Uid","Gid","Tgid","NSpid","NoNewPrivs","CapInh","CapPrm","CapEff","CapBnd","CapAmb"])requireThat((raw.match(new RegExp("^"+key+":","gm"))??[]).length===1,H1ConstructorHeld.Actor);
 for(const key of ["Uid","Gid"])requireThat(new RegExp("^"+key+":\\s+0\\s+0\\s+0\\s+0$","m").test(raw),H1ConstructorHeld.Actor);
 const namespace=/^NSpid:\s+([1-9][0-9]*(?:[ \t]+[1-9][0-9]*)*)$/m.exec(raw)?.[1]?.trim().split(/\s+/);requireThat(/^NoNewPrivs:\s+1$/m.test(raw)&&new RegExp("^Tgid:\\s+"+pid+"$","m").test(raw)&&namespace&&namespace[0]===String(pid)&&namespace.length===(view===H1PidView.Guest?2:1),H1ConstructorHeld.Actor);
 for(const [index,key] of ["Inh","Prm","Eff","Bnd","Amb"].entries())requireThat(new RegExp("^Cap"+key+":\\s+"+capabilities[index]+"$","m").test(raw),H1ConstructorHeld.Actor);
}
/** Same original unit start/runtime; monotonic absolute value, no call-time renewal. */
export function h1OriginalDeadlineData(values:Readonly<Record<string,string>>,pid:number,invocation:string):bigint{
 requireThat(values.MainPID===String(pid)&&values.InvocationID===invocation&&/^[a-f0-9]{32}$/.test(invocation)&&/^[1-9][0-9]*$/.test(values.ExecMainStartTimestampMonotonic??"")&&values.RuntimeMaxUSec==="30min",H1ConstructorHeld.Deadline);
 return BigInt(values.ExecMainStartTimestampMonotonic!)*1000n+1800000000000n;
}

export enum H1ApiKind {Directory="directory",Regular="regular",Character="character",Pipe="pipe",Socket="socket",Unknown="unknown"}
/** DATA predicate only; the original actor reader supplies actual kernel stat/type/mount joins. */
export function checkH1ApiObjectData(path:string,kind:H1ApiKind,uid:bigint,gid:bigint,mode:bigint):void{
 const dirs=new Set(["/","/proc","/proc/sys","/sys","/sys/fs/cgroup","/dev","/dev/pts","/dev/shm","/run","/tmp","/run/host","/run/host/incoming"]);
 const regular=new Set(["/proc/sysrq-trigger","/proc/sys/kernel/random/boot_id","/proc/kmsg"]);
 requireThat(uid===0n&&gid===0n&&(mode&0o6000n)===0n,H1ConstructorHeld.Mount);
 if(dirs.has(path)){requireThat(kind===H1ApiKind.Directory,H1ConstructorHeld.Mount);return;}
 if(regular.has(path)){requireThat(kind===H1ApiKind.Regular,H1ConstructorHeld.Mount);return;}
 if(path==="/dev/ptmx"){requireThat(kind===H1ApiKind.Character,H1ConstructorHeld.Mount);return;}
 if(path==="/dev/console"){requireThat(kind===H1ApiKind.Character||kind===H1ApiKind.Pipe,H1ConstructorHeld.Mount);return;}
 return fail(H1ConstructorHeld.Mount);
}
/** A kernel environ observation, not a reported PID or authorization record. */
export function checkH1HostReleaseData(raw:Buffer,expected:Readonly<Record<string,string>>):void{
 requireThat(raw.length<=16384&&raw.length>0&&raw.at(-1)===0&&Buffer.from(raw.toString("utf8"),"utf8").equals(raw),H1ConstructorHeld.Definition);const values:Record<string,string>={};
 for(const cell of raw.toString("utf8").split("\0").slice(0,-1)){const at=cell.indexOf("=");requireThat(at>0&&!Object.hasOwn(values,cell.slice(0,at)),H1ConstructorHeld.Definition);values[cell.slice(0,at)]=cell.slice(at+1);}
 const keys=Object.keys(values).filter(key=>key.startsWith("container_host_")).sort();requireThat(JSON.stringify(keys)===JSON.stringify(Object.keys(expected).sort())&&keys.every(key=>values[key]===expected[key]),H1ConstructorHeld.Definition);
 // A notify socket or configuration route cannot be borrowed from the HOST environment.
 requireThat((values.NOTIFY_SOCKET===undefined||values.NOTIFY_SOCKET==="/run/host/notify")&&values.LD_PRELOAD===undefined&&values.LD_LIBRARY_PATH===undefined&&values.PYTHONPATH===undefined&&values.PYTHONHOME===undefined,H1ConstructorHeld.LoadRoute);
}
