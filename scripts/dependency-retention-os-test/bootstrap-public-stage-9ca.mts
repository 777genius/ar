// Fixed PUBLIC ROOT installation/bootstrap TCB. SOURCE only until independently accepted.
// Sent as pinned Node24 module-typescript --eval source; stdin is exactly the fixed PUBLIC byte roster.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const C=fs.constants, HEAD='9ca302fabd07b5cbccd103b7d0cbe16d86f0a8c6', NAME='TEST-dependency-full-native-20261007-r1';
const ROOT='/srv/workers/public-intake', BASE=`${ROOT}/${NAME}`, INTAKE=`${BASE}/${HEAD}`, CONTROL=`${BASE}/control`;
const JOB=`/srv/workers/jobs/${NAME}`, NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node';
const UNIT='subscription-runtime-installer-73000000-0000-4000-8000-9ca302fabd07.service';
const FULL='subscription-job-23c9a46219542abcbf6025cdbf5c4b1f400e653c9d7da5c0aee721ef7148b2a3.service';
const LEDGER=`/root/.local/state/subscription-runtime/host-jobs/${FULL}.json`;
const CGROUP=`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${UNIT}`;
const NODE_SHA='7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c';
const ADAPTER='3bdceddbaace17e42ee8605be9d3413b1aac240ad5f990d9e717f527b8cdf361';
const REVIEW='56a24b6d1af74e1eb868f2f63ff5eb091c21d7efc41a4efe89cf087131b3b3b1';
type Pin=readonly [name:string,size:number,sha256:string];
const pins:readonly Pin[]=[
 ['source-9ca302.bundle',9515981,'751d6a7ea31d117372931a3e85753f9c8094d6c8541f931b43e75743f288fe50'],
 ['profile-artifact.zip',462454,'4c13ddadf5a2034c3a5fc5e0790f9ddeb24bb605efce8df9fd7dc16a635f3af3'],
 ['runtime-artifact.zip',109932227,'cafd730f3df83a2dca92e77108d22fb7e23d5bc43a39d1949db73090f97f9c6d'],
 ['runtime-validated-public.tgz',110282985,'9bb742c25a01a5ddbf4d016c120eefcf4578f8437bd198d906011e7052c41199'],
 ['node-v22.23.3-linux-x64.tar.xz',31001304,'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'],
 ['current-git-role-manifest.json',691624,'38ea482effc0cb868d034238623086817a9749556040566d403117295ff7caf8'],
 ['current-generated-role-manifest.json',48516,'5226833c66b69e5b2665fb21f9c7cc68151b17692f61c2896f5ba6e716635283'],
 ['runtime-role-manifest.json',2389594,'78d58e4c45908944a198c593d922590d7f258d8289d9d3ccbd7d56cb3afab7f8'],
 ['actual-current-runtime-inventory.json',2410688,'bb1e9b7fa0acdc16b5854b365d080f37f6039ee68e4a213c9b4243a8054a943a'],
 ['node-full-member-manifest.json',1101418,'f2eab34d34f0cda8f4a9d71398cc21d6bec14749e49f351cdf974a80f9586fac'],
 ['DATA-FREEZE.json',2016,'3b886270007b0cc7a0366f5e732a07ef96ac8b8f2c81b4109379b3013f2d3c1c'],
 ['DATA-review.json',9942,'9af07989e7476c5b8b31c97b459e8af1e801a8a53722c895d95f30142a1dfe1e'],
 ['run-public-stage-9ca.mts',14027,'9d3f5dff0b26998a1dd796649d630df129283f263e7b1a458e9baf2b2d62f26c'],
 ['stage-public-9ca.mts',26146,ADAPTER], ['adapter-independent-review-FREEZE.json',525,REVIEW],
];
const installed:readonly [string,string][]=[
 ['/opt/subscription-runtime/host-jobs/manager.mjs','e6f8003b03a8e750e4ed312e21d1e53137818156a675a8c87a2959aa7cdfda8a'],
 ['/opt/subscription-runtime/host-jobs/contract.mjs','ff513080213ac8cc259fbcd40b416238c8db8850c63267ff43c13af428476867'],
 ['/opt/subscription-runtime/host-jobs/endpoint.mjs','324a78d6627bd7e9628092c7eb93f1ea47887a3c87c5a13ac0cfed2568ad4dae'],
 ['/opt/subscription-runtime/host-jobs/storage-policy.mjs','ef05b14ff0f1dd9f575c260a3bf71c6520a3f1cfd05f85a98af331d077d6b508'],
 ['/opt/subscription-runtime/managed-launcher/profiles.mjs','ca45ab021dd762ae69496b4b19dbbee4090ac22c484f83ea89e8c81948f7773b'],
 ['/opt/subscription-runtime/managed-launcher/payload-guard.mjs','25ed9cda79c86b2f2cc70fe2670dd9e35375f7180b8b9bceaf1027d45b11b166'],
 ['/opt/subscription-runtime/managed-launcher/launch.mjs','af49e9740dbf8ef07381fa0369dd308ea182f48c331d7e2bc296ef489f98a661'],
];
const protectedAbsent=[
 '/srv/worker-state/protected-storage-test/dependency-full-native-activation/review.json',
 '/srv/worker-state/protected-storage-test/dependency-full-native-activation/public-installation.json',
 '/run/TEST-full-outer-review/input.json', '/run/TEST-real-codex-public-review/input.json',
];
type Held={fd:number;path:string;directory:boolean;dev:bigint;ino:bigint;mode:number;mnt:string};
const held:Held[]=[], immutable:{path:string;h:Held;hash:string;size:bigint;mtime:bigint;ctime:bigint}[]=[], missing:string[]=[];
const namespaceFd=fs.openSync('/proc/self/ns/mnt',C.O_RDONLY),namespace=fs.fstatSync(namespaceFd,{bigint:true});
function fact(ok:unknown,why:string):asserts ok {if(!ok)throw new Error(`PUBLIC bootstrap HOLD: ${why}`);}
function absent(path:string):void {
 try{fs.lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 throw new Error('PUBLIC bootstrap HOLD: fixed name already exists; preserve and inspect');
}
function mount(fd:number):string {const m=/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`,'utf8'))?.[1];fact(m,'FD mount');return m;}
function check(h:Held):void {
 const fresh=fs.openSync(h.path,C.O_RDONLY|C.O_NOFOLLOW|(h.directory?C.O_DIRECTORY:0));
 try{for(const fd of [h.fd,fresh]){const s=fs.fstatSync(fd,{bigint:true});fact(s.dev===h.dev&&s.ino===h.ino
  &&s.uid===0n&&s.gid===0n&&Number(s.mode&0o7777n)===h.mode&&mount(fd)===h.mnt
  &&(h.directory?s.isDirectory():s.isFile()&&s.nlink===1n),'held/named ROOT identity');}}finally{fs.closeSync(fresh);}
}
function open(path:string,directory:boolean,mode?:number):Held {
 const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|(directory?C.O_DIRECTORY:0)),s=fs.fstatSync(fd,{bigint:true});
 const h={fd,path,directory,dev:s.dev,ino:s.ino,mode:Number(s.mode&0o7777n),mnt:mount(fd)};held.push(h);check(h);
 fact((h.mode&0o022)===0&&(mode===undefined||h.mode===mode),'protected mode');return h;
}
function dir(path:string,mode?:number):Held {
 let h=open('/',true,0o755),prefix='';
 for(const part of path.slice(1).split('/')){prefix+=`/${part}`;h=open(`/proc/self/fd/${h.fd}/${part}`,true,prefix===path?mode:undefined);}
 return h;
}
function digest(h:Held):string {
 check(h);const b=Buffer.alloc(1024*1024),hash=createHash('sha256');let p=0;
 for(;;){const n=fs.readSync(h.fd,b,0,b.length,p);if(!n)break;hash.update(b.subarray(0,n));p+=n;}check(h);return hash.digest('hex');
}
function immutableFile(path:string,mode:number,pin?:string):void {
 const parent=dir(path.slice(0,path.lastIndexOf('/'))),h=open(`/proc/self/fd/${parent.fd}/${path.slice(path.lastIndexOf('/')+1)}`,false,mode);
 const s=fs.fstatSync(h.fd,{bigint:true});fact(s.size<=128n*1024n*1024n,'protected nonsecret leaf bound');const hash=digest(h);
 fact(pin===undefined||hash===pin,'original installed hash');immutable.push({path,h,hash,size:s.size,mtime:s.mtimeNs,ctime:s.ctimeNs});
}
function protectedAbsence(path:string):void {
 let h=open('/',true,0o755);const parts=path.slice(1).split('/');
 for(let i=0;i<parts.length;i++){
  const p=`/proc/self/fd/${h.fd}/${parts[i]!}`;
  try{fs.lstatSync(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){missing.push(p);return;}throw e;}
  fact(i<parts.length-1,'original protected leaf no longer absent');h=open(p,true);
 }
}
function cmd(exe:'/usr/bin/systemctl'|'/usr/bin/systemd-run',args:string[],timeout=5000):string {
 const r=spawnSync(exe,args,{shell:false,cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:BASE,TMPDIR:`${BASE}/bootstrap-tmp`},
  encoding:'utf8',timeout,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
 fact(!r.error&&!r.signal&&r.status===0,'bounded fixed command failed/uncertain; never resubmit');return r.stdout;
}
function unitAbsent(unit:string):void {
 fact(cmd('/usr/bin/systemctl',['show',unit,'--property=LoadState,ActiveState,SubState'])===
  'LoadState=not-found\nActiveState=inactive\nSubState=dead\n','fixed unit already exists or state unsupported');
 for(const root of ['/run/systemd/transient','/etc/systemd/system','/run/systemd/system'])absent(`${root}/${unit}`);
}
const targets=[BASE,JOB], fixedReference=(s:string)=>targets.some(t=>s===t||s.startsWith(`${t}/`)||s.includes(t));
function references():void {
 absent(JOB);absent(LEDGER);unitAbsent(FULL);unitAbsent(UNIT);
 // Fixed identity census only. Do not inspect argv, environ, auth, sessions or registries.
 for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)&&p!==String(process.pid))){
  try{for(const name of ['cwd','root',...fs.readdirSync(`/proc/${pid}/fd`).map(f=>`fd/${f}`)]){
   try{fact(!fixedReference(fs.readlinkSync(`/proc/${pid}/${name}`)),'live fixed TEST reference');}
   catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}
  }}catch(e){if(['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))continue;throw e;}
 }
 const state='/root/.local/state/subscription-runtime/host-jobs';
 const stateDir=dir(state);
 const entries=fs.readdirSync(`/proc/self/fd/${stateDir.fd}`);fact(!entries.some(n=>n.startsWith(`${FULL}.json.`)),'fixed queued temporary ledger');
 const names=entries.filter(n=>/^subscription-job-[a-f0-9]{64}\.service\.json$/.test(n));
 fact(names.length<=8192,'bounded fixed-reference manager census');
 for(const name of names){
  const path=`/proc/self/fd/${stateDir.fd}/${name}`,s=fs.lstatSync(path);
  fact(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&s.gid===0&&s.nlink===1&&s.size<=1024*1024,'manager custody file guard');
  const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW);try{const record:unknown=JSON.parse(fs.readFileSync(fd,'utf8'));
   fact(record!==null&&typeof record==='object'&&!Array.isArray(record),'typed original manager custody');const r=record as Record<string,unknown>;
   fact(typeof r.jobId==='string'&&typeof r.unit==='string'&&r.jobId!==NAME&&r.unit!==FULL&&r.unit!==UNIT,'persisted fixed TEST identity');
  }finally{fs.closeSync(fd);}
 }
}
let workers:Held|undefined,attempt:Held|undefined;const owned:Held[]=[];
function guard():void {
 const ns=fs.statSync('/proc/self/ns/mnt',{bigint:true});fact(ns.dev===namespace.dev&&ns.ino===namespace.ino,'same ROOT mount namespace');
 fact(fs.readFileSync('/etc/machine-id','utf8').trim()==='d856d40da5ad4e23b4f67773e5942842'
  &&fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()==='f12bc43a-9252-42d4-919d-85b846a176a8','same machine/boot');
 for(const h of held)check(h);for(const path of missing)absent(path);
 for(const x of immutable){const s=fs.fstatSync(x.h.fd,{bigint:true});fact(s.size===x.size&&s.mtimeNs===x.mtime&&s.ctimeNs===x.ctime
  &&digest(x.h)===x.hash,'original protected snapshot changed');}
 const text=fs.readFileSync('/proc/self/mountinfo','utf8');fact(Buffer.byteLength(text)<=8*1024*1024,'mount bound');
 const rows=text.trim().split('\n').map(r=>r.split(' ')),scratch=rows.filter(r=>r[4]==='/srv/workers');
 fact(workers&&scratch.length===1&&scratch[0]?.[0]===workers.mnt&&scratch[0]?.[3]==='/'
  &&scratch[0]?.[scratch[0]!.indexOf('-')+1]==='ext4'
  &&fs.statSync('/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f',{bigint:true}).rdev===66305n,'scratch namespace/UUID');
 for(const row of rows){const p=row[4];fact(p,'mount row');if(p.startsWith('/srv/workers/'))fact(![ROOT,JOB].some(t=>p===t||p.startsWith(`${t}/`)||t.startsWith(`${p}/`)),'nested/ancestor scratch mount');}
 fact(owned.every(h=>h.dev===workers!.dev&&h.mnt===workers!.mnt),'owned scratch identity');
 const space=fs.statfsSync('/srv/workers',{bigint:true});fact(space.bavail*space.bsize>=14n*1024n**3n&&space.ffree>=100000n,'native preserved disk/inode gates');
 const available=/^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1];fact(available&&BigInt(available)*1024n>=9n*1024n**3n,'native preserved RAM gate');
}
function fresh(parent:Held,name:string):Held {
 guard();check(parent);const p=`/proc/self/fd/${parent.fd}/${name}`;absent(p);fs.mkdirSync(p,{mode:0o700});fs.fsyncSync(parent.fd);
 const h=open(p,true,0o700);owned.push(h);guard();return h;
}
function seal(parent:Held,name:string,data:Buffer):Held {
 guard();const path=`/proc/self/fd/${parent.fd}/${name}`,fd=fs.openSync(path,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);
 try{let p=0;while(p<data.length){const n=fs.writeSync(fd,data,p,data.length-p);fact(n>0,'receipt short write');p+=n;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.fsyncSync(parent.fd);const h=open(path,false,0o400);owned.push(h);guard();return h;
}
try {
 fact(process.platform==='linux'&&process.getuid?.()===0&&process.getgid?.()===0&&process.execPath===NODE&&process.cwd()==='/'
  &&process.argv.length===2&&/^[a-f0-9]{64}$/.test(process.argv[1]??'')&&process.execArgv.length===3
  &&process.execArgv[0]==='--input-type=module-typescript'&&process.execArgv[1]==='--eval','fixed authorized ROOT bootstrap invocation/review digest');
 const rootBoundaryReviewSha256=process.argv[1]!;process.umask(0o077);
 const nodeParent=dir('/opt/nodejs/node-v24.21.0-linux-x64/bin'),node=open(`/proc/self/fd/${nodeParent.fd}/node`,false,0o755);
 const exe=fs.openSync('/proc/self/exe',C.O_RDONLY);try{const a=fs.fstatSync(exe,{bigint:true});fact(a.dev===node.dev&&a.ino===node.ino
  &&mount(exe)===node.mnt&&fs.readlinkSync('/proc/self/exe')===NODE&&digest(node)===NODE_SHA,'actual pinned interpreter');}finally{fs.closeSync(exe);}
 const nodeStat=fs.fstatSync(node.fd,{bigint:true});immutable.push({path:NODE,h:node,hash:NODE_SHA,size:nodeStat.size,mtime:nodeStat.mtimeNs,ctime:nodeStat.ctimeNs});
 const srv=dir('/srv',0o755);workers=dir('/srv/workers',0o755);const jobs=dir('/srv/workers/jobs',0o755);
 fact(srv.dev===2306n&&srv.ino===13631489n&&workers.dev===66305n&&workers.ino===2n&&jobs.dev===66305n&&jobs.ino===144310273n,'fixed parent pins');
 guard();absent(ROOT);references();
 for(const [path,hash] of installed)immutableFile(path,0o644,hash);
 for(const path of protectedAbsent)protectedAbsence(path);
 guard();references();
 const environment={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:BASE,TMPDIR:`${BASE}/bootstrap-tmp`};
 const unset=['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','GCONV_PATH','LOCPATH','GLIBC_TUNABLES','OPENSSL_CONF','OPENSSL_MODULES','NODE_V8_COVERAGE'];
 const generated=['INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID','USER','LOGNAME','SHELL'];
 const defaults=cmd('/usr/bin/systemctl',['show-environment']);
 for(const line of defaults.trimEnd().split('\n').filter(Boolean)){const key=line.slice(0,line.indexOf('='));
  fact(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)&&(Object.hasOwn(environment,key)||unset.includes(key)), 'manager environment incompatible with caller');}
 const properties={User:'0',Group:'0',Slice:'subscription-runtime-hosted.slice',Restart:'no',NoNewPrivileges:'yes',
  CapabilityBoundingSet:'',AmbientCapabilities:'',RuntimeMaxSec:'20min',TimeoutStopSec:'30s',WorkingDirectory:'/',PrivateNetwork:'yes',
  PrivateDevices:'no',PrivateTmp:'no',ProtectSystem:'no',RootDirectory:'',ReadWritePaths:'',BindPaths:'',BindReadOnlyPaths:'',
  Environment:Object.entries(environment).map(([k,v])=>`${k}=${v}`).join(' '),UnsetEnvironment:unset.join(' '),PassEnvironment:'',EnvironmentFile:'',
  SetLoginEnvironment:'no',StandardInput:'null',StandardOutput:'journal',StandardError:'journal',UMask:'0077',RemainAfterExit:'yes'};
 fact(generated.every(k=>!Object.hasOwn(environment,k)&&!unset.includes(k)),'preserve systemd-generated invocation metadata');
 const args=['--unit='+UNIT,'--service-type=exec',...Object.entries(properties).map(([k,v])=>`--property=${k}=${v}`),NODE,`${CONTROL}/run-public-stage-9ca.mts`];
 const root=fresh(workers,'public-intake'),base=fresh(root,NAME),intake=fresh(base,HEAD),control=fresh(base,'control');
 const results=fresh(base,'results');fresh(base,'bootstrap-tmp');
 seal(control,'PUBLIC-purpose.json',Buffer.from(JSON.stringify({kind:'FIXED_PUBLIC_BOOTSTRAP_PURPOSE',head:HEAD,unit:UNIT,
  controlGroup:CGROUP,rootBoundaryReviewSha256,pid:process.pid,boot:'f12bc43a-9252-42d4-919d-85b846a176a8',
  targets:[BASE,JOB],protected:immutable.map(x=>({path:x.path,dev:String(x.h.dev),ino:String(x.h.ino),
   mode:x.h.mode,uid:0,gid:0,mntId:x.h.mnt,bytes:String(x.size),mtimeNs:String(x.mtime),ctimeNs:String(x.ctime),sha256:x.hash})),
  protectedAbsent,missingCount:missing.length,bootstrapSha256:createHash('sha256').update(process.execArgv[2]!).digest('hex'),fullEightAcceptance:'UNPROVEN'})+'\n'));
 const buffer=Buffer.alloc(1024*1024);
 for(let index=0;index<pins.length;index++){
  const pin=pins[index]!;guard();const parent=index<12?intake:control,path=`/proc/self/fd/${parent.fd}/${pin[0]}`;
  const fd=fs.openSync(path,C.O_RDWR|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);let count=0;const hash=createHash('sha256');
  try{while(count<pin[1]){const n=fs.readSync(0,buffer,0,Math.min(buffer.length,pin[1]-count),null);fact(n>0,'short fixed PUBLIC transport');
   hash.update(buffer.subarray(0,n));let p=0;while(p<n){const wrote=fs.writeSync(fd,buffer,p,n-p);fact(wrote>0,'short intake write');p+=wrote;}count+=n;}
   fact(count===pin[1]&&hash.digest('hex')===pin[2],'fixed transport size/hash');fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  fs.fsyncSync(parent.fd);const h=open(path,false,0o400);owned.push(h);fact(digest(h)===pin[2],'sealed named input hash');guard();
 }
 fact(fs.readSync(0,buffer,0,1,null)===0,'extra PUBLIC transport byte');guard();references();
 const receipt=seal(control,'intake-owner-receipt.json',Buffer.from(JSON.stringify({kind:'ROOT_PUBLIC_INTAKE_PHYSICAL_FACTS',path:INTAKE,head:HEAD,
  dev:String(intake.dev),ino:String(intake.ino),uid:0,gid:0,mode:0o700,scratchUuid:'d0f2cac1-2009-4e9d-a710-e156f417938f',unit:UNIT,
  controlGroup:CGROUP,adapterSha256:ADAPTER,sourceReviewFreezeSha256:REVIEW,rootBoundaryReviewSha256,
  originalProtectedInputsUnchanged:true,noActiveOrPersistedReferences:true})+'\n'));
 seal(control,'intake-owner-receipt.sha256',Buffer.from(digest(receipt)+'\n'));
 guard();references();attempt=seal(results,'PUBLIC-submit-once.json',Buffer.from(JSON.stringify({kind:'OWNED_SUBMISSION_RESERVED',head:HEAD,unit:UNIT,
  ownerReceiptSha256:digest(receipt),rootBoundaryReviewSha256,owned:owned.map(h=>({path:fs.realpathSync(`/proc/self/fd/${h.fd}`),
   dev:String(h.dev),ino:String(h.ino),mode:h.mode,mntId:h.mnt})),argv:args,retry:'HOLD',fullEightAcceptance:'UNPROVEN'})+'\n'));
 guard();references();
 // Exactly one submission. A timeout/error is an uncertain result: never call systemd-run again.
 cmd('/usr/bin/systemd-run',args,30000);
 process.stdout.write(JSON.stringify({kind:'PUBLIC_INSTALLER_SUBMITTED',unit:UNIT,receiptSha256:digest(receipt),
  next:'Read same unit and fixed PUBLIC-bootstrap-attempt.jsonl; preserve all inputs/records; never resubmit',fullEightAcceptance:'UNPROVEN'})+'\n');
} catch(error) {
 process.stderr.write(JSON.stringify({kind:attempt?'SUBMISSION_OR_RESULT_UNCERTAIN':'PUBLIC_PREPARATION_PARTIAL_OR_HELD',unit:UNIT,
  reason:error instanceof Error?error.message.slice(0,1024):'fixed bootstrap error',retry:'HOLD',
  recovery:'Read same fixed unit/attempt and owned physical records; preserve paths; no deletion',fullEightAcceptance:'UNPROVEN'})+'\n');process.exitCode=1;
} finally {for(const h of held.reverse())fs.closeSync(h.fd);fs.closeSync(namespaceFd);}
