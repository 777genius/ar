/** Fixed child for an already configured, offline disposable package root. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdirSync,readFileSync,readlinkSync,readdirSync,writeFileSync,lstatSync,realpathSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {pathToFileURL} from "node:url";
export async function mainH1BuildChild():Promise<void>{
 assert(process.platform==="linux"&&process.env.CI==="true"&&process.env.TEST_H1_CONTROLLED_BUILD==="1");assert(process.env.TEST_H1_BUILD_OUTER_NET&&readlinkSync("/proc/self/ns/net")!==process.env.TEST_H1_BUILD_OUTER_NET);assert.equal(process.getuid?.(),0);assert.equal(process.argv.length,4);
 const family=process.argv[2],dsc=process.argv[3];assert(family==="python3.12"||family==="systemd");assert(dsc&&/^[A-Za-z0-9_.+%:~-]+\.dsc$/.test(dsc));assert.equal(realpathSync("/build"),"/build");assert.equal(readdirSync("/build").length,0);mkdirSync("/build/h1-witness",{mode:0o700});
 const env={PATH:"/h1:/usr/sbin:/usr/bin:/sbin:/bin",HOME:"/build",TMPDIR:"/tmp",LANG:"C.UTF-8",LC_ALL:"C.UTF-8",CI:"true",TEST_H1_CONTROLLED_BUILD:"1",TEST_H1_COMPILER_WITNESS:"1",TEST_H1_BUILD_OUTER_NET:process.env.TEST_H1_BUILD_OUTER_NET,CC:"/h1/h1-cc",CXX:"/h1/h1-cxx",DEB_BUILD_OPTIONS:"parallel=2",DEB_BUILD_PROFILES:"",DEB_VENDOR:"Ubuntu"};
 const run=(command:string,args:string[],cwd:string)=>{const r=spawnSync(command,args,{cwd,env,shell:false,stdio:"inherit"});assert(!r.error&&r.status===0&&r.signal===null,"controlled package recipe failed");};
 // No compiler override from user/package configuration. This instruments a NEW
 // build. Missing actual relevant compiler witnesses remains Held at collection.
 const elfModule=await import("/h1/"+"hosted-signed-tool-elf.js") as typeof import("../../src/provider-codex/app-server/adapters/hosted-signed-tool-elf.ts");
 const queue=["/usr/bin/node"],visited=new Set<string>(),nodeElf:unknown[]=[];
 while(queue.length){const named=queue.shift()!,path=realpathSync(named);if(visited.has(path))continue;assert(visited.size<128);visited.add(path);const body=readFileSync(path);assert(body.length<=128*1024*1024);const facts=elfModule.parseHostedSignedToolElf(body);assert.equal(facts.rpath.length,0);assert.equal(facts.runpath.length,0);nodeElf.push({named,path,sha256:createHash("sha256").update(body).digest("hex"),bytes:body.length,facts});if(facts.interpreter)queue.push(facts.interpreter);for(const name of facts.needed){const candidates=["/lib/x86_64-linux-gnu","/usr/lib/x86_64-linux-gnu","/lib","/usr/lib"].map(dir=>join(dir,name)).filter(candidate=>{try{return lstatSync(candidate).isFile()||lstatSync(candidate).isSymbolicLink();}catch(e){if(!(e instanceof Error&&"code" in e&&e.code==="ENOENT"))throw e;return false;}});assert(candidates.length>0,"actual configured Node ELF dependency absent");const target=realpathSync(candidates[0]!);assert(candidates.every(candidate=>realpathSync(candidate)===target),"ambiguous configured Node ELF dependency");queue.push(target);}}
 writeFileSync("/build/node-elf-closure-UNADMITTED.json",JSON.stringify({purpose:"ACTUAL_CONFIGURED_NODE_ELF_DATA",objects:nodeElf,nativeQualified:false})+"\n",{flag:"wx",mode:0o600});
 const status=spawnSync("/usr/bin/dpkg-query",["-W","-f=${binary:Package}\t${Version}\t${Architecture}\t${Status}\n"],{env,shell:false,maxBuffer:4*1024*1024});assert(!status.error&&status.status===0&&status.signal===null);writeFileSync("/build/configured-status.tsv",status.stdout,{flag:"wx",mode:0o600});
 run("/usr/bin/dpkg-source",["--no-copy","--no-check","--extract","/source/"+dsc,"/build/work"],"/build");
 run("/usr/bin/dpkg-checkbuilddeps",[],"/build/work");
 run("/usr/bin/dpkg-buildpackage",["--build=binary","--no-sign"],"/build/work");
 const witnesses=readdirSync("/build/h1-witness");assert(witnesses.length>0&&witnesses.length<=100000);let relevant=0;
 for(const name of witnesses){assert(/^[a-f0-9-]{36}$/.test(name));const path=join("/build/h1-witness",name,"invocation.json");assert(lstatSync(path).size<=256*1024);const row=JSON.parse(readFileSync(path,"utf8")) as {status:number;inputs:{path:string}[]};if(row.inputs.some(input=>family==="python3.12"?/\/Modules\/getpath\.c$/.test(input.path):/\/src\/nspawn\/[^/]+\.c$/.test(input.path))){assert.equal(row.status,0);relevant++;}}
 assert(relevant>0,"recipe bypassed controlled compiler witness");assert(readdirSync("/build").some(name=>name.endsWith(".buildinfo")));assert(readdirSync("/build").some(name=>name.endsWith(".changes")));assert(readdirSync("/build").some(name=>name.endsWith(".deb")));
 writeFileSync("/build/terminal-UNADMITTED.json",JSON.stringify({purpose:"ACTUAL_CONTROLLED_COMPILE_UNADMITTED",family,witnesses:witnesses.length,relevantCompilerInvocations:relevant,compileSucceeded:true,sourceSemanticsReviewed:false,originalBinaryEquality:false,nativeQualified:false})+"\n",{flag:"wx",mode:0o600});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){mainH1BuildChild().catch(()=>{process.stderr.write("TEST H1 controlled recipe Held\n");process.exitCode=70;});}
