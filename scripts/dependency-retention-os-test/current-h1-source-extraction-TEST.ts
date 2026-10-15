/** Original CI acquisition -> fresh isolated dpkg-source -> complete DATA.
 * No package installation, custom archive/patch interpreter or native grant. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,readdirSync,mkdirSync,writeFileSync,symlinkSync,existsSync,fchmodSync,realpathSync,type BigIntStats} from "node:fs";
import {join} from "node:path";
import {joinCompleteUbuntuIndex} from "./current-h1-tool-inputs-ci-index.ts";
import {retainOriginalAcquiredArchive,joinAcquiredSignedPackage,type AcquiredSignedPackage} from "./current-h1-tool-inputs-package.ts";
import {type H1SourceSelection,type retainH1SourceArchives} from "./current-h1-source-record-TEST.ts";
import {censusH1PatchedSource,H1SourceCensusProfile} from "./current-h1-source-extraction-child-TEST.ts";
import {H1SemanticFamily,h1PatchedSourceLimits} from "./current-h1-source-semantics-TEST.ts";
import {h1SourceSandboxArgv} from "./current-h1-source-sandbox-TEST.ts";
interface Tool {readonly fd:number;readonly actual:string;readonly stamp:string;readonly sha256:string}
interface Input {readonly scratch:string;readonly evidence:string;readonly sibling:string;readonly sourceSha:string;readonly deadline:number;readonly env:NodeJS.ProcessEnv;readonly indices:readonly {bytes:Buffer}[];readonly sourceSelections:readonly H1SourceSelection[];readonly sourceArchives:readonly ReturnType<typeof retainH1SourceArchives>[];readonly aptGet:Tool;readonly dpkgDeb:Tool;tick():void}
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(":");
const packages=Object.freeze(["bubblewrap","dpkg-dev","perl","tar","xz-utils","gzip","bzip2","libstdc++6"]);
export async function collectH1PatchedSourceData(input:Input):Promise<void>{
 const {scratch,evidence,tick}=input;tick();assert(process.platform==="linux"&&process.getuid?.()===0&&process.getgid?.()===0);const own=lstatSync(scratch,{bigint:true});assert(own.isDirectory()&&own.uid===0n&&own.gid===0n&&(own.mode&0o7777n)===0o700n);
 const commands:unknown[]=[],held:ReturnType<typeof retainOriginalAcquiredArchive>[]=[],root=join(scratch,"source-extractor-image"),archives=join(scratch,"source-extractor-packages");
 const mkdir=(path:string)=>{mkdirSync(path,{mode:0o700});assert.equal(lstatSync(path,{bigint:true}).uid,0n);};mkdir(root);mkdir(archives);mkdir(join(archives,"partial"));
 const read=(path:string,maximum:number)=>{tick();const s=lstatSync(path,{bigint:true});assert(s.isFile()&&s.size<=BigInt(maximum)&&!(s.mode&0o022n));const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(s));const b=Buffer.alloc(Number(s.size)+1);let at=0;for(;;){tick();const n=readSync(fd,b,at,b.length-at,at);tick();if(!n)break;at+=n;assert(at<=Number(s.size));}assert.equal(at,Number(s.size));assert.equal(stamp(fstatSync(fd,{bigint:true})),stamp(s));assert.equal(stamp(lstatSync(path,{bigint:true})),stamp(s));return b.subarray(0,at);}finally{closeSync(fd);}};
 const file=(path:string,body:Buffer|string)=>{tick();writeFileSync(path,body,{flag:"wx",mode:0o600});const s=lstatSync(path,{bigint:true});assert(s.uid===0n&&s.gid===0n&&s.nlink===1n);assert(read(path,128*1024*1024).equals(Buffer.isBuffer(body)?body:Buffer.from(body)));};
 const command=(tool:Tool,args:readonly string[],maxBuffer=4*1024*1024)=>{tick();assert.equal(stamp(fstatSync(tool.fd,{bigint:true})),tool.stamp);assert.equal(stamp(lstatSync(tool.actual,{bigint:true})),tool.stamp);const result=spawnSync("/proc/self/fd/3",args,{argv0:tool.actual,shell:false,cwd:scratch,env:input.env,stdio:["ignore","pipe","pipe",tool.fd],timeout:Math.max(1,Math.floor(Math.min(180000,input.deadline-performance.now()))),killSignal:"SIGKILL",maxBuffer});tick();assert.equal(stamp(fstatSync(tool.fd,{bigint:true})),tool.stamp);assert(commands.length<512);commands.push({tool:tool.actual,toolSha256:tool.sha256,args,status:result.status,signal:result.signal,spawnFailed:result.error!==undefined,stdoutSha256:hash(result.stdout??Buffer.alloc(0)),stderrSha256:hash(result.stderr??Buffer.alloc(0))});assert(!result.error&&result.status===0&&result.signal===null,"source extraction acquisition command failed");return result.stdout;};
 try{
  // Only our private archives directory changes. Existing41-package image and
  // system package database are untouched; signed indices independently join.
  const installArgs=["-o","Dir::Cache::archives="+archives,"--yes","--download-only","--no-install-recommends","install",...packages];
  // Bound and independently authenticate the solver's COMPLETE transfer set
  // before downloading, rather than trusting a signed size as an unlimited cap.
  const uris=command(input.aptGet,["-o","Acquire::ForceHash=SHA256","--print-uris",...installArgs]).toString("utf8"),requested=new Map<string,{size:number;sha256:string;local:string;matched:AcquiredSignedPackage|undefined}>();let plannedBytes=0;
  for(const line of uris.split("\n")){tick();if(!line.startsWith("'"))continue;const cells=/^'([^']+)' ([A-Za-z0-9_.+%:~-]+\.deb) ([1-9][0-9]*) SHA256:([a-f0-9]{64})$/.exec(line);assert(cells,"fixed SHA256 print-uris transfer record required");const url=new URL(cells[1]!);assert(["https://archive.ubuntu.com","https://security.ubuntu.com"].includes(url.origin)&&url.pathname.startsWith("/ubuntu/pool/")&&!url.search&&!url.hash);const path=decodeURIComponent(url.pathname.slice("/ubuntu/".length)),size=Number(cells[3]);assert(Number.isSafeInteger(size)&&size>0&&size<=32*1024*1024&&!requested.has(path));plannedBytes+=size;assert(plannedBytes<=128*1024*1024&&requested.size<128);requested.set(path,{size,sha256:cells[4]!,local:cells[2]!,matched:undefined});}
  assert(requested.size>0);
  for(const index of input.indices){let at=0;while(at<index.bytes.length){tick();const end=index.bytes.indexOf("\n\n",at),stop=end<0?index.bytes.length:end;assert(stop-at<=4*1024*1024);const raw=index.bytes.subarray(at,stop).toString("utf8"),filename=/^Filename: (\S+)$/m.exec(raw)?.[1],request=filename?requested.get(filename):undefined;
    if(request){const packageName=/^Package: (\S+)$/m.exec(raw)?.[1],version=/^Version: (\S+)$/m.exec(raw)?.[1],architecture=/^Architecture: (\S+)$/m.exec(raw)?.[1];assert(packageName&&version&&architecture);const row=joinAcquiredSignedPackage(`Package: ${packageName}\nVersion: ${version}\nArchitecture: ${architecture}\n`,raw,request);if(request.matched)assert.deepEqual(row,request.matched);request.matched=row;}
    at=end<0?index.bytes.length:end+2;
  }}for(const request of requested.values())assert(request.matched,"every planned extraction tool transfer must join authenticated complete Packages");
  file(join(evidence,"source-extractor-transfer-plan-UNADMITTED.json"),JSON.stringify({sourceSha:input.sourceSha,bytes:plannedBytes,packages:[...requested.values()].map(row=>row.matched),nativeQualified:false})+"\n");
  command(input.aptGet,installArgs);
  const names=readdirSync(archives).filter(name=>name.endsWith(".deb")).sort(),vector:AcquiredSignedPackage[]=[];assert(names.length>0&&names.length<=128);let total=0,decodedToolBytes=0;
  for(const name of names){assert(/^[A-Za-z0-9_.+%:~-]+\.deb$/.test(name));const archive=retainOriginalAcquiredArchive(join(archives,name),tick);held.push(archive);total+=archive.size;assert(total<=128*1024*1024);const fields=command(input.dpkgDeb,["--field",`/proc/${process.pid}/fd/${archive.fd}`,"Package","Version","Architecture"],16384).toString("utf8");let selected:AcquiredSignedPackage|undefined;
   for(const index of input.indices){tick();const row=joinCompleteUbuntuIndex(fields,index.bytes,archive);if(row){if(selected)assert.deepEqual(selected,row);selected=row;}}assert(selected,"authenticated complete extraction-tool package index required");assert(!vector.some(row=>row.package===selected!.package));vector.push(selected);archive.rejoin();
   decodedToolBytes+=command(input.dpkgDeb,["--fsys-tarfile",`/proc/${process.pid}/fd/${archive.fd}`],128*1024*1024).length;assert(decodedToolBytes<=384*1024*1024,"bounded original tool-image tar streams");archive.rejoin();
   command(input.dpkgDeb,["--extract",`/proc/${process.pid}/fd/${archive.fd}`,root]);archive.rejoin();
  }
  assert.deepEqual(names,[...requested.values()].map(row=>row.local).sort(),"exact prebounded downloaded transfer membership");const canonical=(rows:readonly AcquiredSignedPackage[])=>[...rows].sort((a,b)=>a.package.localeCompare(b.package));assert.deepEqual(canonical(vector),canonical([...requested.values()].map(row=>row.matched!)));for(const name of packages)assert(vector.some(row=>row.package===name));
  for(const [alias,target] of [["bin","usr/bin"],["sbin","usr/sbin"],["lib","usr/lib"],["lib64","usr/lib64"]] as const)if(!existsSync(join(root,alias)))symlinkSync(target,join(root,alias));
  for(const name of ["runtime","inputs","output","tmp","proc","dev"]){const path=join(root,name);if(existsSync(path)){const s=lstatSync(path,{bigint:true});assert(s.isDirectory()&&s.uid===0n&&s.gid===0n);}else mkdir(path);}
  file(join(root,"runtime/node"),read(realpathSync(process.execPath),128*1024*1024));const node=openSync(join(root,"runtime/node"),constants.O_RDONLY|constants.O_NOFOLLOW);try{fchmodSync(node,0o555);}finally{closeSync(node);}
  for(const name of ["current-h1-source-extraction-child-TEST.js","current-h1-source-semantics-TEST.js"])file(join(root,"runtime",name),read(join(input.sibling,name),2*1024*1024));
  const inventory=censusH1PatchedSource(root,tick,H1SourceCensusProfile.ToolImage),imageHash=hash(JSON.stringify(inventory));file(join(evidence,"source-extractor-image-UNADMITTED.json"),JSON.stringify({sourceSha:input.sourceSha,packages:vector,inventory,nativeQualified:false})+"\n");
  const bwrap=retainOriginalAcquiredArchive(join(root,"usr/bin/bwrap"),tick);held.push(bwrap);const rejoin=()=>{tick();assert.equal(lstatSync(scratch,{bigint:true}).ino,own.ino);for(const h of held)h.rejoin();for(const h of input.sourceArchives)h.rejoin();assert.deepEqual(censusH1PatchedSource(root,tick,H1SourceCensusProfile.ToolImage),inventory);tick();};
  for(const selection of input.sourceSelections){rejoin();const family=selection.source.name;assert(Object.values(H1SemanticFamily).includes(family as H1SemanticFamily));const dsc=selection.artifacts.find(row=>row.name.endsWith(".dsc"));assert(dsc);const args=h1SourceSandboxArgv(root,join(scratch,"source-"+family),family as H1SemanticFamily,dsc.name);
   const r=spawnSync("/proc/self/fd/3",args,{argv0:"/usr/bin/bwrap",shell:false,cwd:scratch,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:scratch,TMPDIR:scratch},stdio:["ignore","pipe","pipe",bwrap.fd],timeout:Math.max(1,Math.floor(Math.min(150000,input.deadline-performance.now()))),killSignal:"SIGKILL",maxBuffer:h1PatchedSourceLimits.recordBytes});rejoin();
   file(join(evidence,family+"-source-extractor-command.json"),JSON.stringify({sourceSha:input.sourceSha,args,status:r.status,signal:r.signal,stdoutSha256:hash(r.stdout??Buffer.alloc(0)),stderrSha256:hash(r.stderr??Buffer.alloc(0)),nativeQualified:false})+"\n");assert(!r.error&&r.status===0&&r.signal===null,"unsupported source sandbox/extraction Held");
   const body:unknown=JSON.parse(r.stdout.toString("utf8"));assert(body&&typeof body==="object"&&"purpose" in body&&body.purpose==="PATCHED_SOURCE_UNADMITTED_DATA"&&"nativeQualified" in body&&body.nativeQualified===false);
   file(join(evidence,family+"-patched-constructor-inputs-UNADMITTED.json"),JSON.stringify({sourceSha:input.sourceSha,selection,extractorImageSha256:imageHash,body,compiledInputEquality:false,hostNspawnProvenance:false,nativeQualified:false})+"\n");
  }rejoin();
 }finally{try{file(join(evidence,"source-extractor-commands-UNADMITTED.json"),JSON.stringify({sourceSha:input.sourceSha,commands,nativeQualified:false})+"\n");}finally{for(const h of held)h.close();}}
}
