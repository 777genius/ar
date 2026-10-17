#!/usr/bin/node
/** GCC's documented -wrapper receives actual expanded subcommand argv. It
 * captures consumed preprocessed/assembly/object bytes before invoking cc1/as/
 * collect2, then the real output before the build recipe regains control. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdirSync,writeFileSync,lstatSync,realpathSync,readlinkSync,openSync,closeSync,constants,writeSync} from "node:fs";
import {join,resolve,basename,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {readH1CompilerInput} from "./current-h1-compiler-witness-TEST.ts";
function main(){
 assert(process.platform==="linux"&&process.env.TEST_H1_COMPILER_WITNESS==="1"&&process.env.CI==="true");assert(process.env.TEST_H1_BUILD_OUTER_NET&&readlinkSync("/proc/self/ns/net")!==process.env.TEST_H1_BUILD_OUTER_NET);const parent=process.env.TEST_H1_GCC_INVOCATION;assert(parent&&/^[a-f0-9-]{36}$/.test(parent));const executable=process.argv[2],args=process.argv.slice(3);assert(executable&&executable.startsWith("/")&&args.length<=8192&&Buffer.byteLength(JSON.stringify(args))<=512*1024);const deadline=performance.now()+180000,tool=readH1CompilerInput(executable,deadline),fd=openSync(tool.path,constants.O_RDONLY|constants.O_NOFOLLOW),id=randomUUID(),output=join("/build/h1-witness",parent,"sub-"+id);mkdirSync(output,{mode:0o700});const cwd=realpathSync(process.cwd());assert(cwd.startsWith("/build/"));
 const save=(name:string,b:Buffer|string)=>writeFileSync(join(output,name),b,{flag:"wx",mode:0o600});let total=0;const inputs:Record<string,unknown>[]=[],captured=new Set<string>();
 const capture=(path:string,role:string)=>{const row=readH1CompilerInput(path,deadline);if(captured.has(row.path))return;captured.add(row.path);total+=row.bytes;assert(total<=512*1024*1024&&captured.size<=512);const name="input-"+inputs.length;save(name,row.body);inputs.push({role,record:name,path:row.path,identity:row.identity,bytes:row.bytes,sha256:row.sha256});};
 for(let i=0;i<args.length;i++){const arg=args[i]!;if(arg.startsWith("@")){capture(resolve(cwd,arg.slice(1)),"actual_subcommand_response_file_uninterpreted");continue;}if(arg.startsWith("-")||args[i-1]==="-o")continue;const path=resolve(cwd,arg);try{if(lstatSync(path).isFile())capture(path,"actual_expanded_subcommand_file_argument");}catch(e){if(!(e instanceof Error&&"code" in e&&e.code==="ENOENT"))throw e;}}
 // Actual cc1 source argv (including @response expansion owned by GCC) selects
 // the generated configuration snapshot. Whole compiler intermediates remain
 // authoritative execution observations, never a handwritten C interpretation.
 for(const row of [...inputs]){const source=String(row.path);if(!/(?:\/Modules\/getpath\.(?:c|i)|\/src\/nspawn\/[^/]+\.(?:c|i))$/.test(source))continue;for(const start of [dirname(source),cwd]){let root=start;for(let depth=0;depth<8&&root.startsWith("/build/");depth++,root=dirname(root)){for(const name of ["pyconfig.h","Makefile","config.h","Python/frozen_modules/getpath.h","Modules/getpath.py","Modules/getpath.c","meson-info/intro-buildoptions.json","compile_commands.json"]){try{capture(join(root,name),"generated_configuration_at_actual_subcommand");}catch(e){if(!(e instanceof Error&&"code" in e&&e.code==="ENOENT"))throw e;}}}}}
 let result:ReturnType<typeof spawnSync>;try{result=spawnSync("/proc/self/fd/3",args,{argv0:executable,shell:false,cwd,env:process.env,stdio:[0,"pipe","pipe",fd],maxBuffer:128*1024*1024,timeout:180000,killSignal:"SIGKILL"});}finally{closeSync(fd);}
 save("stdout",result.stdout??Buffer.alloc(0));save("stderr",result.stderr??Buffer.alloc(0));if(result.stdout?.length)writeSync(1,Buffer.from(result.stdout));if(result.stderr?.length)writeSync(2,Buffer.from(result.stderr));for(const row of inputs){const after=readH1CompilerInput(String(row.path),deadline);assert.equal(after.sha256,row.sha256);assert.equal(after.identity,row.identity);}
 const outputs:Record<string,unknown>[]=[];for(let i=0;i<args.length;i++)if(args[i]==="-o"&&args[i+1]&&args[i+1]!=="/dev/null"&&args[i+1]!=="-"){const path=resolve(cwd,args[i+1]!);try{const row=readH1CompilerInput(path,deadline);save("output-"+outputs.length,row.body);outputs.push({path:row.path,identity:row.identity,bytes:row.bytes,sha256:row.sha256});}catch(e){if(!(e instanceof Error&&"code" in e&&e.code==="ENOENT"))throw e;}}
 save("subcommand.json",JSON.stringify({purpose:"ACTUAL_GCC_EXPANDED_SUBCOMMAND_UNADMITTED",parent,id,tool:{path:tool.path,sha256:tool.sha256,identity:tool.identity},cwd,args,inputs,outputs,status:result.status,signal:result.signal,spawnFailed:result.error!==undefined,sourceSemanticsReviewed:false,selectedVariantReviewed:false,nativeQualified:false})+"\n");assert(!result.error&&result.status!==null&&result.signal===null);process.exitCode=result.status;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{main();}catch{process.stderr.write("TEST H1 GCC subcommand witness Held\n");process.exitCode=70;}}
