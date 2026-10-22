/** Inner command ownership inside the fixed Docker TEST container. Docker owns
 * cgroup limits; each command gets its own PID namespace and death signal. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {openSync,writeSync,closeSync,readFileSync,readdirSync,lstatSync} from "node:fs";
import {join} from "node:path";
import {readH1CompilerInput} from "./current-h1-compiler-witness-TEST.ts";
import {h1BuildLimits} from "./current-h1-build-plan-TEST.ts";
function disk(root:string){let bytes=0,entries=0;const walk=(dir:string,depth:number)=>{assert(depth<96);for(const name of readdirSync(dir)){assert(++entries<=h1BuildLimits.rootEntries);const path=join(dir,name),s=lstatSync(path);assert(!s.isSocket()&&!s.isFIFO()&&!s.isBlockDevice());if(s.isDirectory())walk(path,depth+1);else if(s.isFile()){bytes+=s.size;assert(bytes<=h1BuildLimits.rootBytes);}}};walk(root,0);return {bytes,entries};}
export async function runH1OwnedBuildCommand(input:{command:string;args:readonly string[];cwd:string;env:NodeJS.ProcessEnv;deadline:number;output:string;scratch:string;maximum?:number}):Promise<Buffer>{
 assert(process.platform==="linux"&&process.getuid?.()===0&&process.env.CI==="true"&&process.env.TEST_H1_DOCKER_COMPILER==="1");
 // cgroup namespace is private in the inspected outer Docker profile. These
 // actual files corroborate the daemon-owned limits; no inner cgroup writes.
 assert.equal(readFileSync("/sys/fs/cgroup/memory.max","utf8").trim(),"6442450944");assert.equal(readFileSync("/sys/fs/cgroup/memory.swap.max","utf8").trim(),"0");assert.equal(readFileSync("/sys/fs/cgroup/pids.max","utf8").trim(),"512");
 assert(["/usr/bin/bwrap","/usr/bin/apt-get","/usr/bin/dpkg-deb","/usr/bin/gpgv"].includes(input.command)&&input.args.length<8192);assert(performance.now()<input.deadline);const tool=readH1CompilerInput(input.command,input.deadline);
 const stdout=openSync(input.output+".stdout","wx",0o600),stderr=openSync(input.output+".stderr","wx",0o600),chunks:Buffer[]=[];let bytes=0,failed=false,closed=false;let timer:ReturnType<typeof setInterval>|undefined;
 const child=spawn("/usr/bin/unshare",["--fork","--pid","--mount","--mount-proc","--kill-child=SIGKILL","--",input.command,...input.args],{cwd:input.cwd,env:input.env,shell:false,stdio:["ignore","pipe","pipe"]});
 // Killing this retained unshare owner also sends SIGKILL to its PID1 child;
 // PID namespace teardown kills every descendant. Outer Docker kill/wait is the
 // independent terminal backstop if the local wrapper itself stops responding.
 const stop=()=>{failed=true;child.kill("SIGKILL");};
 try{const consume=(data:Buffer,fd:number,keep:boolean)=>{if(failed)return;bytes+=data.length;if(bytes>(input.maximum??h1BuildLimits.logBytes)){stop();return;}try{writeSync(fd,data);if(keep)chunks.push(Buffer.from(data));}catch{stop();}};child.stdout!.on("data",(b:Buffer)=>consume(b,stdout,true));child.stderr!.on("data",(b:Buffer)=>consume(b,stderr,false));timer=setInterval(()=>{try{if(performance.now()>=input.deadline){stop();return;}disk(input.scratch);}catch{stop();}},1000);timer.unref();
  const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});closed=true;const after=readH1CompilerInput(input.command,input.deadline);assert.equal(after.identity,tool.identity);assert.equal(after.sha256,tool.sha256);disk(input.scratch);const record={command:input.command,toolSha256:tool.sha256,toolIdentity:tool.identity,args:input.args,status:result.code,signal:result.signal,logBytes:bytes,failed,namespaceOwnerClosed:true,outerContainerTerminalRequired:true,nativeQualified:false};const fd=openSync(input.output+".json","wx",0o600);try{writeSync(fd,JSON.stringify(record)+"\n");}finally{closeSync(fd);}assert(!failed&&result.code===0&&result.signal===null,"owned compiler command failed/overflowed");return Buffer.concat(chunks);
 }finally{if(timer)clearInterval(timer);if(!closed){stop();await new Promise<void>(r=>child.once("close",()=>r()));}closeSync(stdout);closeSync(stderr);}
}
