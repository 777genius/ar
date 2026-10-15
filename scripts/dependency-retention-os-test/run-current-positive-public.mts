// Fixed first-Positive original ROOT transport. No execution before exact independent input/source review.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const C=fs.constants,S='/srv/workers/public-intake/TEST-dependency-full-positive-scoped-20261014-r1/full-positive-installation-ptrace-v1';
const NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node',NODE_SHA='7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c';
const HELPER_SHA='6e5b0c00c93fc4a7a6db82ea81654fd98a4aa2acce1a51184a08aea665fe234a';
const names=['preparation-input.json','source.bundle','public-files.payload','stage-current-positive-public.mts','run-current-positive-public.mts','review.json','outer-input.json','public-input.json'] as const;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fact(v:unknown,why:string):asserts v{if(!v)throw new Error('PUBLIC_TRANSPORT_HOLD:'+why);}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
type Row={name:string;bytes:number;sha256:string};
type Delivery={version:1;sourceSha:string;manifestSha256:string;reviewSha256:string;bootId:string;files:Row[]};
export function parseDelivery(b:Buffer,pin:string):Delivery{
 fact(digest(pin)&&b.length>0&&b.length<=16384&&hash(b)===pin,'delivery_digest');const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
 fact(v!==null&&typeof v==='object'&&!Array.isArray(v),'delivery_shape');const d=v as Delivery;
 fact(Object.keys(d).sort().join(',')==='bootId,files,manifestSha256,reviewSha256,sourceSha,version'&&d.version===1&&typeof d.sourceSha==='string'&&/^[a-f0-9]{40}$/.test(d.sourceSha)&&digest(d.manifestSha256)&&digest(d.reviewSha256)&&typeof d.bootId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(d.bootId),'delivery_fields');
 fact(Array.isArray(d.files)&&d.files.length===names.length,'delivery_count');let total=0;
 for(let i=0;i<names.length;i++){const r=d.files[i]!;fact(r!==null&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).sort().join(',')==='bytes,name,sha256'&&r.name===names[i]&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=(i===2?1024**3:i===1?128*1024**2:i===0?32*1024**2:2*1024**2)&&digest(r.sha256),'delivery_row');total+=r.bytes;}
 fact(total<=2*1024**3&&d.files[0]!.sha256===d.manifestSha256&&d.files[5]!.sha256===d.reviewSha256&&d.files[3]!.sha256===HELPER_SHA,'delivery_join');return d;
}
export function selectedUnit(d:Delivery):string{return 'subscription-runtime-installer-positive-'+hash(Buffer.from(d.sourceSha+':'+d.manifestSha256))+'.service';}
function bounded(fd:number,max:number):Buffer{const chunks:Buffer[]=[];let n=0;for(;;){const b=Buffer.alloc(Math.min(65536,max+1-n)),got=fs.readSync(fd,b,0,b.length,n);if(!got)break;n+=got;fact(n<=max,'read_bound');chunks.push(b.subarray(0,got));}return Buffer.concat(chunks);}
function read(path:string,max:number):Buffer{const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{return bounded(fd,max);}finally{fs.closeSync(fd);}}
function mount(fd:number):string{const text=read('/proc/self/fdinfo/'+fd,4096).toString('utf8'),rows=[...text.matchAll(/^mnt_id:\s+(\d+)$/gm)];fact(rows.length===1,'mount');return rows[0]![1]!;}
type Held={fd:number;path:string;dir:boolean;identity:string;mnt:string;sha?:string};
const held:Held[]=[];
function tuple(s:fs.BigIntStats,dir:boolean):string{return [s.dev,s.ino,s.uid,s.gid,s.mode,...(dir?[]:[s.nlink,s.size,s.mtimeNs,s.ctimeNs])].join(':');}
function eofHash(fd:number):string{const b=Buffer.alloc(1024*1024),h=createHash('sha256');let offset=0;for(;;){const n=fs.readSync(fd,b,0,b.length,offset);if(!n)break;h.update(b.subarray(0,n));offset+=n;}return h.digest('hex');}
function open(path:string,dir:boolean,mode?:number,pin?:string):Held{const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(dir?C.O_DIRECTORY:0));
 try{const s=fs.fstatSync(fd,{bigint:true});fact(s.uid===0n&&s.gid===0n&&(s.mode&0o022n)===0n&&(dir?s.isDirectory():s.isFile()&&s.nlink===1n)&&(mode===undefined||Number(s.mode&0o7777n)===mode),'root_object');const h:Held={fd,path,dir,identity:tuple(s,dir),mnt:mount(fd)};if(pin!==undefined){fact(eofHash(fd)===pin,'source_hash');h.sha=pin;}check(h);held.push(h);return h;}catch(e){fs.closeSync(fd);throw e;}}
function check(h:Held):void{const fresh=fs.openSync(h.path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(h.dir?C.O_DIRECTORY:0));try{for(const fd of [h.fd,fresh])fact(tuple(fs.fstatSync(fd,{bigint:true}),h.dir)===h.identity&&mount(fd)===h.mnt&&(h.sha===undefined||eofHash(fd)===h.sha),'retained_named_join');}finally{fs.closeSync(fresh);}}
function anchor(path:string):Held{let parent=open('/',true);for(const part of path.slice(1).split('/').filter(Boolean))parent=open('/proc/self/fd/'+parent.fd+'/'+part,true);return parent;}
function absent(path:string):void{try{fs.lstatSync(path);}catch(e){if(e!==null&&typeof e==='object'&&Object.getOwnPropertyDescriptor(e,'code')?.value==='ENOENT')return;throw e;}throw new Error('PUBLIC_TRANSPORT_HOLD:already_exists');}
function make(parent:Held,name:string):Held{check(parent);const path='/proc/self/fd/'+parent.fd+'/'+name;absent(path);fs.mkdirSync(path,{mode:0o700});fs.fsyncSync(parent.fd);return open(path,true,0o700);}
function write(parent:Held,name:string,b:Buffer,mode=0o400):Held{check(parent);const path='/proc/self/fd/'+parent.fd+'/'+name,fd=fs.openSync(path,C.O_RDWR|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,mode);try{let n=0;while(n<b.length){const got=fs.writeSync(fd,b,n,b.length-n);fact(got>0,'short_write');n+=got;}fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.fsyncSync(parent.fd);return open(path,false,mode,hash(b));}
function closeAll():void{let failure=false;for(const h of held.reverse()){try{fs.closeSync(h.fd);}catch{failure=true;}}fact(!failure,'close_uncertain');}
function originalRoot(boot:string):void{fact(process.platform==='linux'&&process.arch==='x64'&&process.getuid?.()===0&&process.getgid?.()===0&&process.cwd()==='/'&&process.execPath===NODE,'original_root');fact(read('/etc/machine-id',64).toString().trim()==='d856d40da5ad4e23b4f67773e5942842'&&read('/proc/sys/kernel/random/boot_id',64).toString().trim()===boot,'machine_boot');for(const n of ['user','pid','mnt','cgroup','net','uts','ipc'])fact(fs.readlinkSync('/proc/self/ns/'+n)===fs.readlinkSync('/proc/1/ns/'+n),'original_namespace');fact(read('/proc/self/uid_map',4096).toString().trim().split(/\s+/).join(' ')==='0 0 4294967295','original_uid_map');const bin=anchor('/opt/nodejs/node-v24.21.0-linux-x64/bin'),node=open('/proc/self/fd/'+bin.fd+'/node',false,0o755,NODE_SHA);fact(tuple(fs.statSync('/proc/self/exe',{bigint:true}),false)===node.identity,'original_node');const workers=anchor('/srv/workers');fact(fs.fstatSync(workers.fd,{bigint:true}).dev===66305n&&fs.fstatSync(workers.fd,{bigint:true}).ino===2n,'scratch_identity');const rows=read('/proc/self/mountinfo',8*1024**2).toString().trim().split('\n').map(r=>r.split(' ')),own=rows.filter(r=>r[4]==='/srv/workers');fact(own.length===1&&own[0]![0]===workers.mnt&&own[0]![3]==='/'&&own[0]![own[0]!.indexOf('-')+1]==='ext4'&&fs.statSync('/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f',{bigint:true}).rdev===66305n,'scratch_mount');for(const r of rows)fact(!(r[4]!==S&&(r[4]!.startsWith(S+'/')))&&!(S.startsWith(r[4]!+'/')&&r[4]!.startsWith('/srv/workers/'))&&r[4]!==S,'stage_mount');}
function command(exe:string,args:string[],timeout=5000):string{const r=spawnSync(exe,args,{shell:false,cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},encoding:'utf8',timeout,maxBuffer:65536,stdio:['ignore','pipe','pipe']});fact(!r.error&&!r.signal&&(r.status===0||(r.status===4&&exe==='/usr/bin/systemctl'&&args[0]==='show')),'command_uncertain');return r.stdout;}
function properties(unit:string):Record<string,string>{const rows=command('/usr/bin/systemctl',['show',unit,'--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Result,ExecMainStatus,Job,Transient,KillMode,SendSIGKILL,Delegate,PrivateNetwork,PrivateTmp,PrivateDevices,RootDirectory,RootImage,LimitNOFILE,NoNewPrivileges,RemainAfterExit,Restart,RuntimeMaxUSec,TimeoutStopUSec,CapabilityBoundingSet,AmbientCapabilities,ProtectSystem']);return Object.fromEntries(rows.trimEnd().split('\n').map(s=>{const i=s.indexOf('=');fact(i>0,'unit_property');return [s.slice(0,i),s.slice(i+1)];}));}
function cgroup(unit:string):string{return '/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/'+unit;}
function runnerCgroup(group:string):void{
 const bytes=read('/proc/self/cgroup',16384);
 fact(bytes.length>0&&bytes.every(byte=>byte<128),'runner_cgroup_ascii');
 const text=bytes.toString('ascii'),rows=(text.endsWith('\n')?text.slice(0,-1):text).split('\n');
 fact(rows.length>0&&rows.length<=64,'runner_cgroup_rows');
 const hierarchies=new Set<string>();let unified=0;
 for(const row of rows){
  const fields=row.split(':');fact(fields.length===3,'runner_cgroup_fields');
  const [hierarchy,controllers,path]=fields;
  fact(hierarchy!==undefined&&/^(0|[1-9][0-9]*)$/.test(hierarchy)&&!hierarchies.has(hierarchy),'runner_cgroup_hierarchy');
  hierarchies.add(hierarchy);
  if(hierarchy==='0'){fact(controllers===''&&path===group,'runner_cgroup');unified++;}
  else{
   // Only the observed legacy named hierarchy is admitted; it supplies no ownership proof.
   fact(hierarchy==='1'&&controllers==='name=systemd'&&path==='/','runner_cgroup_legacy');
  }
 }
 fact(unified===1,'runner_cgroup');
}
/** DATA phase arithmetic only. Staging/install require their full unchanged
 * 120s operation budget; the final launch handoff uses the actual remaining
 * original 270s deadline, without renewing it or demanding a third 120s grant. */
export const PositiveTransportPhase=Object.freeze({Stage:"stage",Install:"install",Handoff:"handoff"} as const);
export type PositiveTransportPhase=typeof PositiveTransportPhase[keyof typeof PositiveTransportPhase];
export function positiveTransportPhaseTimeout(phase:PositiveTransportPhase,remainingMs:number):number {
 fact(Object.values(PositiveTransportPhase).includes(phase)&&Number.isFinite(remainingMs),'phase_budget');
 const remaining=Math.floor(remainingMs);
 fact(remaining>0&&(phase===PositiveTransportPhase.Handoff||remaining>=120000),'phase_budget');
 return Math.min(120000,remaining);
}
export function parseIds(text:string):number[]{fact(text.length<=65536&&/^(?:[1-9][0-9]*\n)*$/.test(text),'cgroup_ids');const ids=text.trim()?text.trim().split('\n').map(Number):[];fact(ids.every(Number.isSafeInteger),'cgroup_id_range');return ids;}
function census(group:string,solePid?:number):void{const root=anchor('/sys/fs/cgroup'+group);let dirs=0;const visit=(h:Held)=>{fact(++dirs<=8192,'cgroup_bound');check(h);for(const leaf of ['cgroup.procs','cgroup.threads']){const ids=parseIds(read('/proc/self/fd/'+h.fd+'/'+leaf,65536).toString());fact(ids.every(id=>solePid!==undefined&&(leaf==='cgroup.procs'?id===solePid:fs.existsSync('/proc/'+solePid+'/task/'+id))),'owned_descendant_present');}for(const name of fs.readdirSync('/proc/self/fd/'+h.fd)){fact(/^[A-Za-z0-9_.:@-]+$/.test(name),'cgroup_name');const path='/proc/self/fd/'+h.fd+'/'+name,s=fs.lstatSync(path);if(s.isDirectory())visit(open(path,true));}check(h);};visit(root);if(solePid===undefined)fact(/^populated 0$/m.test(read('/proc/self/fd/'+root.fd+'/cgroup.events',4096).toString()),'cgroup_populated');}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
const pin=process.argv[2];fact(process.argv.length===3&&digest(pin)&&process.argv[1]===S+'/run-current-positive-public.mts'&&process.execArgv.length===0,'runner_argv');const deadline=performance.now()+270000;let cancelled=false;const cancel=()=>{cancelled=true;};process.on('SIGTERM',cancel);process.on('SIGINT',cancel);process.umask(0o077);
try{const control=anchor(S+'/.transport'),delivery=open('/proc/self/fd/'+control.fd+'/delivery.json',false,0o400,pin);const d=parseDelivery(bounded(delivery.fd,16384),pin),unit=selectedUnit(d),stage=anchor(S),birth=read('/proc/self/stat',4096).toString().slice(read('/proc/self/stat',4096).toString().lastIndexOf(')')+2).split(' ')[19];originalRoot(d.bootId);
 const source=names.map((name,i)=>open('/proc/self/fd/'+stage.fd+'/'+name,false,i===5?0o600:0o400,d.files[i]!.sha256));const inv=process.env.INVOCATION_ID;fact(typeof inv==='string'&&/^[a-f0-9]{32}$/.test(inv),'invocation');
 function guard(){for(const n of ['user','pid','mnt','cgroup','net','uts','ipc'])fact(fs.readlinkSync('/proc/self/ns/'+n)===fs.readlinkSync('/proc/1/ns/'+n),'original_namespace');fact(!cancelled&&performance.now()<deadline,'deadline_cancel');for(const h of held)check(h);fact(read('/proc/self/stat',4096).toString().slice(read('/proc/self/stat',4096).toString().lastIndexOf(')')+2).split(' ')[19]===birth,'runner_birth');const u=properties(unit);fact(u.Id===unit&&u.Transient==='yes'&&u.InvocationID===inv&&u.MainPID===String(process.pid)&&u.ControlGroup===cgroup(unit)&&u.KillMode==='control-group'&&u.SendSIGKILL==='yes'&&u.Delegate==='no'&&u.PrivateNetwork==='no'&&u.PrivateTmp==='no'&&u.PrivateDevices==='no'&&u.RootDirectory===''&&u.RootImage===''&&Number(u.LimitNOFILE)>=65536&&u.NoNewPrivileges==='yes'&&u.RemainAfterExit==='yes'&&u.Restart==='no'&&u.RuntimeMaxUSec==='5min'&&u.TimeoutStopUSec==='30s'&&u.CapabilityBoundingSet==='cap_sys_ptrace'&&u.AmbientCapabilities===''&&u.ProtectSystem==='no','unit_lineage');runnerCgroup(cgroup(unit));fact(!cancelled&&performance.now()<deadline,'post_join_deadline');}
 const child=async(phase:PositiveTransportPhase,args:string[],env:Record<string,string>)=>{guard();const timeout=positiveTransportPhaseTimeout(phase,deadline-performance.now());return await new Promise<Buffer>((resolve,reject)=>{const proc=spawn(NODE,args,{shell:false,cwd:'/',env,stdio:['ignore','pipe','pipe'],timeout,killSignal:'SIGKILL'});let out=0,err=0;const chunks:Buffer[]=[];proc.stdout.on('data',(b:Buffer)=>{out+=b.length;if(out>2*1024**2)proc.kill('SIGKILL');else chunks.push(b);});proc.stderr.on('data',(b:Buffer)=>{err+=b.length;if(err>65536)proc.kill('SIGKILL');});const stop=()=>proc.kill('SIGKILL');process.on('SIGTERM',stop);process.on('SIGINT',stop);proc.on('error',reject);proc.on('close',(code,sig)=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);if(code!==0||sig||out>2*1024**2||err>65536)reject(new Error('child_uncertain'));else resolve(Buffer.concat(chunks));});}).then(data=>{guard();census(cgroup(unit),process.pid);guard();return data;});};
 guard();census(cgroup(unit),process.pid);write(control,'started.json',Buffer.from(JSON.stringify({unit,invocationId:inv,pid:process.pid,startTicks:birth,deliverySha256:pin})+'\n'));
 await child(PositiveTransportPhase.Stage,[S+'/stage-current-positive-public.mts',d.manifestSha256],{HOME:'/',PATH:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:S});
 const version=anchor(S+'/input/'+d.sourceSha),catalog=open('/proc/self/fd/'+version.fd+'/public-installation.json',false,0o400),catalogBytes=bounded(catalog.fd,2*1024**2),reviewBytes=bounded(source[5]!.fd,32768),review=JSON.parse(reviewBytes.toString()) as Record<string,unknown>;catalog.sha=hash(catalogBytes);check(catalog);
 fact(review.sourceSha===d.sourceSha&&review.catalogSha256===hash(catalogBytes)&&review.moduleSha256!==undefined,'catalog_review_join');const receipt=JSON.parse(read('/proc/self/fd/'+version.fd+'/public-staging-receipt.json',2*1024**2).toString()) as Record<string,unknown>;fact(receipt.status==='PUBLIC_STAGED_UNADMITTED_DATA'&&receipt.manifestSha256===d.manifestSha256&&receipt.sourceSha===d.sourceSha&&receipt.catalogSha256===hash(catalogBytes),'stage_receipt_join');guard();
 // Public inputs are selected independently; no digest here grants native admission.
 fact(hash(reviewBytes)===d.files[5]!.sha256&&review.outerReviewSha256===d.files[6]!.sha256&&review.publicReviewSha256===d.files[7]!.sha256,'review_input_join');
 write(stage,'public-installation.json',catalogBytes,0o600);const outer=make(stage,'outer-review'),pub=make(stage,'public-review');write(outer,'input.json',bounded(source[6]!.fd,32768),0o600);write(pub,'input.json',bounded(source[7]!.fd,32768),0o600);guard();
 // Native Installer acquire requires the original fixed job roots before its copy phase.
 guard();const jobs=anchor('/srv/workers/jobs');fact(fs.fstatSync(jobs.fd,{bigint:true}).dev===66305n&&jobs.mnt===stage.mnt,'original_jobs_mount');
 const job=make(jobs,'TEST-dependency-full-positive-scoped-20261014-r1');guard();
 for(const name of ['input','tmp','os-TEST']){guard();make(job,name);guard();}
 const requestBytes=await child(PositiveTransportPhase.Install,[S+'/input/'+d.sourceSha+'/source/host-integration/managed-launcher/dependency-full-positive-install-TEST.js'],{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TEST_SOURCE_SHA:d.sourceSha});
 fact(requestBytes.length>0,'request_data_missing');JSON.parse(requestBytes.toString('utf8'));guard();write(control,'request.json',requestBytes);
 const handoffBytes=await child(PositiveTransportPhase.Handoff,['/opt/subscription-runtime-full-positive-TEST/host-jobs/full-positive-manager-TEST.mjs'],{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
 const handoff:unknown=JSON.parse(handoffBytes.toString('utf8'));fact(handoff!==null&&typeof handoff==='object'&&!Array.isArray(handoff),'parent_handoff');
 const parent=handoff as Record<string,unknown>;fact(Object.keys(parent).sort().join(',')==='afterSha256,beforeSha256,completion,invocationId,jobId,pid,sourceSha,startTicks,status,unit'&&parent.status==='STARTED_HELD'&&parent.completion==='UNPROVEN'&&parent.jobId==='TEST-dependency-full-positive-scoped-20261014-r1'&&parent.unit==='subscription-job-dfedfa76a77a65dc9b5ede0e4a98b8082dccc42443a683deba555fa700319583.service'&&parent.sourceSha===d.sourceSha&&digest(parent.beforeSha256)&&digest(parent.afterSha256)&&typeof parent.invocationId==='string'&&/^[a-f0-9]{32}$/.test(parent.invocationId)&&Number.isSafeInteger(parent.pid)&&Number(parent.pid)>0&&typeof parent.startTicks==='string'&&/^[1-9][0-9]*$/.test(parent.startTicks),'parent_handoff_fields');
 guard();write(control,'handoff.json',handoffBytes);census(cgroup(unit),process.pid);write(control,'result.json',Buffer.from(JSON.stringify({version:1,status:'INSTALLED_PARENT_STARTED_HELD',unit,invocationId:inv,deliverySha256:pin,sourceSha:d.sourceSha,manifestSha256:d.manifestSha256,catalogSha256:hash(catalogBytes),requestSha256:hash(requestBytes),handoffSha256:hash(handoffBytes),nativeQualified:'UNPROVEN',retry:'HOLD'})+'\n'));guard();
}catch{process.stderr.write('{"status":"INSTALLER_PARTIAL_OR_UNCERTAIN","retry":"HOLD"}\n');process.exitCode=70;}finally{try{closeAll();fact(!cancelled&&performance.now()<deadline,'final_deadline');}catch{process.exitCode=70;}process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}

}
