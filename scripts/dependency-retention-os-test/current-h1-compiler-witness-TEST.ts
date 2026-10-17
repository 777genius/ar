#!/usr/bin/node
/** Fixed GCC/G++ witness inside the configured TEST build root. Records actual
 * invocation/intermediate bytes before packaging cleanup; never qualifies H1. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,writeFileSync,mkdirSync,readdirSync,realpathSync,readlinkSync,type BigIntStats} from "node:fs";
import {dirname,join,resolve,basename} from "node:path";
import {pathToFileURL} from "node:url";
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
export const h1CompilerWitnessLimits=Object.freeze({fileBytes:128*1024*1024,invocationBytes:128*1024,responseFiles:16,argv:4096,inputs:32,intermediates:64,compilerMs:180000});
/** Retains complete bytes and physical identity. No source/macro interpreter. */
export function readH1CompilerInput(path:string,deadline:number){
 const tick=()=>assert(performance.now()<deadline,"compiler witness original deadline");tick();const canonical=realpathSync(path),before=lstatSync(canonical,{bigint:true});assert(before.isFile()&&before.size>=0n&&before.size<=BigInt(h1CompilerWitnessLimits.fileBytes));const fd=openSync(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(before));const body=Buffer.alloc(Number(before.size)+1);let at=0;for(;;){tick();const count=readSync(fd,body,at,body.length-at,at);tick();if(!count)break;at+=count;assert(at<=Number(before.size));}assert.equal(at,Number(before.size));assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(before));assert.equal(stamp(lstatSync(canonical,{bigint:true})),stamp(before));assert.equal(realpathSync(path),canonical);tick();return Object.freeze({path:canonical,identity:stamp(before),bytes:at,sha256:sha(body.subarray(0,at)),body:body.subarray(0,at)});}finally{closeSync(fd);}
}
/** Only compiler-produced diagnostics/intermediates are copied. Empty files
 * are recorded explicitly; no incomplete reads silently become an empty row. */
function save(path:string,body:Buffer|string){writeFileSync(path,body,{flag:"wx",mode:0o600});}
function main(){
 assert(process.platform==="linux"&&process.env.TEST_H1_COMPILER_WITNESS==="1");assert.equal(process.env.CI,"true");const outer=process.env.TEST_H1_BUILD_OUTER_NET;assert(outer&&readlinkSync("/proc/self/ns/net")!==outer,"offline build namespace required");
 const deadline=performance.now()+h1CompilerWitnessLimits.compilerMs+30000,args=process.argv.slice(2);assert(args.length<=h1CompilerWitnessLimits.argv&&Buffer.byteLength(JSON.stringify(args))<=h1CompilerWitnessLimits.invocationBytes);
 const command=basename(process.argv[1]??"")==="h1-cxx"?"/usr/bin/g++":"/usr/bin/gcc",compiler=readH1CompilerInput(command,deadline),compilerFd=openSync(compiler.path,constants.O_RDONLY|constants.O_NOFOLLOW);
 const base="/build/h1-witness",id=randomUUID(),output=join(base,id);assert(lstatSync(base).isDirectory());mkdirSync(output,{mode:0o700});
 const cwd=realpathSync(process.cwd());assert(cwd.startsWith("/build/")&&cwd!==base&&!cwd.startsWith(base+"/"));
 const responses=args.filter(arg=>arg.startsWith("@"));assert(responses.length<=h1CompilerWitnessLimits.responseFiles);const responseFacts=responses.map((arg,index)=>{const input=readH1CompilerInput(resolve(cwd,arg.slice(1)),deadline);save(join(output,"response-"+index),input.body);return {path:input.path,identity:input.identity,bytes:input.bytes,sha256:input.sha256};});
 const sourceArguments=args.filter(arg=>/\.(?:c|cc|cpp)$/.test(arg)&&!arg.startsWith("-")),sources=sourceArguments.map(path=>readH1CompilerInput(resolve(cwd,path),deadline));assert(sources.length<=h1CompilerWitnessLimits.inputs);
 const relevant=sources.filter(row=>/(?:\/Modules\/getpath\.c|\/src\/nspawn\/[^/]+\.c|\/src\/shared\/dev-setup\.c|\/src\/basic\/os-util\.c)$/.test(row.path));
 const generated=new Map<string,ReturnType<typeof readH1CompilerInput>>();
 for(const start of [...relevant.map(row=>dirname(row.path)),cwd]){let root=start;for(let depth=0;depth<8&&root.startsWith("/build/");depth++,root=dirname(root)){
  for(const name of ["pyconfig.h","Makefile","config.h","Python/frozen_modules/getpath.h","Modules/getpath.py","Modules/getpath.c","meson-info/intro-buildoptions.json","compile_commands.json"]){const path=join(root,name);try{const row=readH1CompilerInput(path,deadline);if(!generated.has(row.path))generated.set(row.path,row);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}}
 }}assert(generated.size<=h1CompilerWitnessLimits.inputs);
 let inputIndex=0;for(const row of [...sources,...generated.values()])save(join(output,"input-"+inputIndex++),row.body);
 // GCC itself emits and consumes these preprocessing intermediates. The extra
 // save/dump options instrument this NEW build, never attest old distro flags.
 const actualArgs=[...args,"-save-temps=obj","-dumpdir",output+"/","-dumpbase","unit","-v","-wrapper","/usr/bin/node,/h1/compiler-subprocess.mjs"];
 const environment=Object.fromEntries(["PATH","LANG","LC_ALL","SOURCE_DATE_EPOCH","CPATH","C_INCLUDE_PATH","CPLUS_INCLUDE_PATH","LIBRARY_PATH","GCC_EXEC_PREFIX"].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
 let result:ReturnType<typeof spawnSync>;
 try{assert.equal(stamp(fstatSync(compilerFd,{bigint:true})),compiler.identity);result=spawnSync("/proc/self/fd/3",actualArgs,{argv0:command,shell:false,cwd,env:{...process.env,TEST_H1_GCC_INVOCATION:id},stdio:[0,1,2,compilerFd],timeout:h1CompilerWitnessLimits.compilerMs,killSignal:"SIGKILL"});assert.equal(stamp(fstatSync(compilerFd,{bigint:true})),compiler.identity);}finally{closeSync(compilerFd);}
 for(const row of [...sources,...generated.values()]){const after=readH1CompilerInput(row.path,deadline);assert.equal(after.identity,row.identity);assert.equal(after.sha256,row.sha256);}
 const names=readdirSync(output).filter(name=>!name.startsWith("input-")&&!name.startsWith("response-")&&!name.startsWith("sub-")).sort();assert(names.length<=h1CompilerWitnessLimits.intermediates);const intermediates=names.map(name=>{const row=readH1CompilerInput(join(output,name),deadline);return {name,bytes:row.bytes,sha256:row.sha256};});
 save(join(output,"invocation.json"),JSON.stringify({purpose:"ACTUAL_COMPILER_WITNESS_UNADMITTED",id,cwd,compiler:{path:compiler.path,identity:compiler.identity,sha256:compiler.sha256},requestedArgs:args,actualArgs,environment,responseFiles:responseFacts,inputs:[...sources,...generated.values()].map((row,index)=>({record:"input-"+index,path:row.path,identity:row.identity,bytes:row.bytes,sha256:row.sha256})),intermediates,status:result.status,signal:result.signal,spawnFailed:result.error!==undefined,sourceSemanticsReviewed:false,originalBinaryEquality:false,nativeQualified:false})+"\n");
 assert(!result.error&&result.status!==null&&result.signal===null);process.exitCode=result.status;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{main();}catch{process.stderr.write("TEST H1 compiler witness Held\n");process.exitCode=70;}}
