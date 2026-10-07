// Fixed PUBLIC bootstrap CLI, SOURCE proposal only. Never call from provider/runtime startup.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RootPrerequisites } from './stage-public-9ca.mts';

const HEAD='9ca302fabd07b5cbccd103b7d0cbe16d86f0a8c6', JOB='TEST-dependency-full-native-20261007-r1';
const BASE=`/srv/workers/public-intake/${JOB}`, CONTROL=`${BASE}/control`, INTAKE=`${BASE}/${HEAD}`;
const UNIT='subscription-runtime-installer-73000000-0000-4000-8000-9ca302fabd07.service';
const CGROUP=`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${UNIT}`;
const NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node';
const ADAPTER_SHA='3bdceddbaace17e42ee8605be9d3413b1aac240ad5f990d9e717f527b8cdf361';
const REVIEW_SHA='56a24b6d1af74e1eb868f2f63ff5eb091c21d7efc41a4efe89cf087131b3b3b1';
const C=fs.constants;
type Held={fd:number;path:string;directory:boolean;mode:number;dev:bigint;ino:bigint;mntId:string};
const held:Held[]=[];
function requireFact(ok:unknown,why:string):asserts ok {if(!ok)throw new Error(`PUBLIC bootstrap HOLD: ${why}`);}
function mountId(fd:number):string {
  const id=/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`,'utf8'))?.[1];
  requireFact(id,'missing namespace-local FD mount ID');return id;
}
function check(h:Held):void {
  const old=fs.fstatSync(h.fd,{bigint:true}), named=fs.openSync(h.path,C.O_RDONLY|C.O_NOFOLLOW|(h.directory?C.O_DIRECTORY:0));
  try {
    const fresh=fs.fstatSync(named,{bigint:true});
    requireFact([old,fresh].every(s=>s.dev===h.dev&&s.ino===h.ino&&s.uid===0n&&s.gid===0n
      &&Number(s.mode&0o7777n)===h.mode&&(h.directory?s.isDirectory():s.isFile()&&s.nlink===1n))
      &&mountId(h.fd)===h.mntId&&mountId(named)===h.mntId,'fresh named/held physical or mount identity changed');
  } finally {fs.closeSync(named);}
}
function open(path:string,directory:boolean,mode:number):number {
  const fd=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|(directory?C.O_DIRECTORY:0)), s=fs.fstatSync(fd,{bigint:true});
  const h:Held={fd,path,directory,mode,dev:s.dev,ino:s.ino,mntId:mountId(fd)};held.push(h);check(h);
  return fd;
}
function directory(path:string):number {
  let fd=open('/',true,0o755), prefix='';
  for(const part of path.slice(1).split('/')) {
    prefix+=`/${part}`;
    fd=open(`/proc/self/fd/${fd}/${part}`,true,prefix.startsWith('/srv/workers/public-intake')?0o700:0o755);
  }
  return fd;
}
function bytes(fd:number,max:number):Buffer {
  const size=fs.fstatSync(fd).size;requireFact(size<=max,'bounded metadata');
  const b=Buffer.alloc(size);let p=0;
  while(p<size){const n=fs.readSync(fd,b,p,size-p,p);requireFact(n>0,'short metadata read');p+=n;}
  return b;
}
function sha(fd:number):string {
  const hash=createHash('sha256'), b=Buffer.alloc(1024*1024);let p=0;
  for(;;){const n=fs.readSync(fd,b,0,b.length,p);if(!n)break;hash.update(b.subarray(0,n));p+=n;}
  return hash.digest('hex');
}
function write(fd:number,record:unknown):void {
  const b=Buffer.from(`${JSON.stringify(record)}\n`);let p=0;
  while(p<b.length){const n=fs.writeSync(fd,b,p,b.length-p);requireFact(n>0,'short receipt write');p+=n;}
  fs.fsyncSync(fd);
}
function absent(path:string):void {
  try{fs.lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  throw new Error('PUBLIC bootstrap HOLD: prior job/attempt exists');
}
function birth():string {
  const stat=fs.readFileSync('/proc/self/stat','utf8'), close=stat.lastIndexOf(')'), ticks=stat.slice(close+2).trim().split(/\s+/)[19];
  requireFact(stat.startsWith(`${process.pid} (`)&&close>0&&ticks&&/^\d+$/.test(ticks),'own kernel birth');return ticks;
}
const environment={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:BASE,TMPDIR:`${BASE}/bootstrap-tmp`};
const unset=['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','GCONV_PATH','LOCPATH',
  'GLIBC_TUNABLES','OPENSSL_CONF','OPENSSL_MODULES','NODE_V8_COVERAGE'];
const properties={Id:UNIT,Transient:'yes',MainPID:String(process.pid),ControlGroup:CGROUP,User:'0',Group:'0',Restart:'no',
  NoNewPrivileges:'yes',CapabilityBoundingSet:'',AmbientCapabilities:'',WorkingDirectory:'/',ProtectSystem:'no',
  ReadWritePaths:'',BindPaths:'',BindReadOnlyPaths:'',RootDirectory:'',PrivateNetwork:'yes',PrivateDevices:'no',PrivateTmp:'no',RuntimeMaxUSec:'20min',
  Environment:Object.entries(environment).map(([k,v])=>`${k}=${v}`).join(' '),UnsetEnvironment:unset.join(' ')};
const startTicks=birth();
function lifetime():void {
  requireFact(birth()===startTicks&&fs.readFileSync('/proc/self/cgroup','utf8')===`0::${CGROUP}\n`,'own birth/cgroup changed');
  const observed=spawnSync('/usr/bin/systemctl',['show',UNIT,`--property=${Object.keys(properties).join(',')},LoadState,ActiveState,SubState,InvocationID`],
    {shell:false,encoding:'utf8',timeout:5000,maxBuffer:8192,cwd:'/',env:environment,stdio:['ignore','pipe','pipe']});
  requireFact(!observed.error&&!observed.signal&&observed.status===0,'owned unit observation');
  const facts=new Map<string,string>();
  for(const line of observed.stdout.trimEnd().split('\n')) {
    const i=line.indexOf('=');requireFact(i>0&&!facts.has(line.slice(0,i)),'duplicate/malformed unit property');
    facts.set(line.slice(0,i),line.slice(i+1));
  }
  requireFact(facts.size===Object.keys(properties).length+4&&Object.entries(properties).every(([k,v])=>facts.get(k)===v)
    &&facts.get('LoadState')==='loaded'&&['active','activating'].includes(facts.get('ActiveState')??'')
    &&['running','start'].includes(facts.get('SubState')??'')&&/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID??'')
    &&facts.get('InvocationID')===process.env.INVOCATION_ID&&birth()===startTicks,'actual invocation/birth/owned unit profile');
}
let attempt:number|undefined, journal:Held|undefined, verifyBoundary:(()=>void)|undefined;
try {
  requireFact(process.platform==='linux'&&process.getuid?.()===0&&process.getgid?.()===0
    &&process.argv.length===2&&process.argv[0]===NODE&&process.argv[1]===`${CONTROL}/run-public-stage-9ca.mts`
    &&process.execArgv.length===0&&process.execPath===NODE
    &&process.cwd()==='/'&&fileURLToPath(import.meta.url)===`${CONTROL}/run-public-stage-9ca.mts`,'fixed ROOT invocation');
  const generated=['INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID','USER','LOGNAME','SHELL'];
  requireFact(Object.keys(process.env).every(k=>Object.hasOwn(environment,k)||generated.includes(k))
    &&Object.entries(environment).every(([k,v])=>process.env[k]===v)&&unset.every(k=>process.env[k]===undefined)
    &&/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID??'')
    &&(process.env.SYSTEMD_EXEC_PID===undefined||process.env.SYSTEMD_EXEC_PID===String(process.pid)),'fixed clean environment with actual systemd invocation');
  const nodeParent=directory('/opt/nodejs/node-v24.21.0-linux-x64/bin'), node=open(`/proc/self/fd/${nodeParent}/node`,false,0o755);
  const exe=fs.openSync('/proc/self/exe',C.O_RDONLY);
  try {
    const actual=fs.fstatSync(exe,{bigint:true}), named=fs.fstatSync(node,{bigint:true});
    requireFact(actual.dev===named.dev&&actual.ino===named.ino&&mountId(exe)===mountId(node)&&fs.readlinkSync('/proc/self/exe')===NODE
      &&sha(exe)==='7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c','actual pinned bootstrap executable');
  } finally {fs.closeSync(exe);}
  const status=fs.readFileSync('/proc/self/status','utf8');
  requireFact(['CapEff','CapPrm','CapBnd','CapAmb'].every(k=>new RegExp(`^${k}:\\s+0+$`,'m').test(status))
    &&/^NoNewPrivs:\s+1$/m.test(status)&&fs.readFileSync('/proc/self/cgroup','utf8')===`0::${CGROUP}\n`,'owned cgroup/cap-empty');
  const workers=directory('/srv/workers'), control=directory(CONTROL), intake=directory(INTAKE);
  const results=directory(`${BASE}/results`), bootstrapTmp=directory(`${BASE}/bootstrap-tmp`);
  function guard():void {
    for(const h of held)check(h);
    if(journal)check(journal);
    const exe=fs.openSync('/proc/self/exe',C.O_RDONLY);
    try {
      const actual=fs.fstatSync(exe,{bigint:true}), named=fs.fstatSync(node,{bigint:true});
      requireFact(actual.dev===named.dev&&actual.ino===named.ino&&mountId(exe)===mountId(node)
        &&fs.readlinkSync('/proc/self/exe')===NODE&&sha(node)==='7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c','actual/named interpreter boundary changed');
    } finally {fs.closeSync(exe);}
    const scratch=fs.fstatSync(workers,{bigint:true});
    requireFact(scratch.dev===66305n&&scratch.ino===2n&&String(fs.statSync('/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f',{bigint:true}).rdev)==='66305'
      &&[control,intake,results,bootstrapTmp].every(fd=>fs.fstatSync(fd,{bigint:true}).dev===scratch.dev&&mountId(fd)===mountId(workers)),'control/intake/results/TMPDIR owned scratch');
    const mountText=fs.readFileSync('/proc/self/mountinfo','utf8');requireFact(Buffer.byteLength(mountText)<=8*1024*1024,'bounded mount view');
    const mounts=mountText.trim().split('\n').map(line=>line.split(' '));
    const root=mounts.filter(fields=>fields[4]==='/srv/workers');
    const scratchMount=root[0];requireFact(root.length===1&&scratchMount,'unique scratch mount');
    requireFact(scratchMount[0]===mountId(workers)&&scratchMount[3]==='/'
      &&scratchMount[scratchMount.indexOf('-')+1]==='ext4','unique ext4 scratch view');
    for(const fields of mounts) {
      const point=fields[4];requireFact(point,'malformed mount view');
      if(point.startsWith('/srv/workers/'))requireFact(![CONTROL,INTAKE,`${BASE}/results`,`${BASE}/bootstrap-tmp`,`/srv/workers/jobs/${JOB}`].some(target=>point===target
        ||target.startsWith(`${point}/`)||point.startsWith(`${target}/`)),'ancestor/nested bootstrap mount');
    }
  }
  guard();lifetime();
  const adapter=open(`/proc/self/fd/${control}/stage-public-9ca.mts`,false,0o400);
  const review=open(`/proc/self/fd/${control}/adapter-independent-review-FREEZE.json`,false,0o400);
  requireFact(fs.fstatSync(adapter).size===26146&&sha(adapter)===ADAPTER_SHA
    &&fs.fstatSync(review).size===525&&sha(review)===REVIEW_SHA,'accepted exact adapter/review');
  const ownership=open(`/proc/self/fd/${control}/intake-owner-receipt.json`,false,0o400);
  const pinFile=open(`/proc/self/fd/${control}/intake-owner-receipt.sha256`,false,0o400), pinBytes=bytes(pinFile,65);
  requireFact(pinBytes.length===65&&pinBytes[64]===10&&pinBytes.subarray(0,64).every(b=>(b>=48&&b<=57)||(b>=97&&b<=102)),'raw lowercase hex receipt digest');
  const pin=pinBytes.toString('utf8');
  requireFact(/^[a-f0-9]{64}\n$/.test(pin)&&sha(ownership)===pin.trim(),'independently ROOT-sealed ownership receipt');
  const receipt:unknown=JSON.parse(bytes(ownership,8192).toString('utf8'));
  requireFact(receipt!==null&&typeof receipt==='object','ownership receipt shape');const r=receipt as Record<string,unknown>;
  const physical=fs.fstatSync(intake,{bigint:true}), mntId=/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${intake}`,'utf8'))?.[1];
  requireFact(fs.fstatSync(results,{bigint:true}).dev===physical.dev
    &&/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${results}`,'utf8'))?.[1]===mntId,'results remain on namespace-local owned scratch');
  requireFact(r.kind==='ROOT_PUBLIC_INTAKE_PHYSICAL_FACTS'&&r.path===INTAKE&&r.head===HEAD&&r.dev===String(physical.dev)
    &&r.ino===String(physical.ino)&&r.uid===0&&r.gid===0&&r.mode===0o700&&physical.dev===66305n
    &&r.scratchUuid==='d0f2cac1-2009-4e9d-a710-e156f417938f'&&r.unit===UNIT&&r.controlGroup===CGROUP
    &&r.adapterSha256===ADAPTER_SHA&&r.sourceReviewFreezeSha256===REVIEW_SHA&&typeof r.rootBoundaryReviewSha256==='string'
    &&/^[a-f0-9]{64}$/.test(r.rootBoundaryReviewSha256)&&r.originalProtectedInputsUnchanged===true
    &&r.noActiveOrPersistedReferences===true&&mntId,'fresh namespace-local/physical ownership join');
  absent(`/srv/workers/jobs/${JOB}`);
  verifyBoundary=()=>{
    guard();lifetime();
    requireFact(sha(adapter)===ADAPTER_SHA&&sha(ownership)===pin.trim()&&sha(review)===REVIEW_SHA
      &&bytes(pinFile,65).equals(pinBytes),'fresh named module/control receipt bytes changed');
  };
  verifyBoundary();
  const module=await import('./stage-public-9ca.mts');
  verifyBoundary();
  requireFact(module.HEAD===HEAD&&module.PUBLIC_INTAKE===INTAKE&&sha(adapter)===ADAPTER_SHA&&sha(ownership)===pin.trim(),'module/receipt retained join');
  const prerequisites:RootPrerequisites={ownerBoundaryReviewSha256:r.rootBoundaryReviewSha256,intakeOwnerReceiptSha256:pin.trim(),
    intakeIdentity:{dev:String(physical.dev),ino:String(physical.ino),mntId,mode:0o700,uid:0,gid:0},
    originalProtectedInputsUnchanged:true,noActiveOrPersistedReferences:true};
  const path=`/proc/self/fd/${results}/PUBLIC-bootstrap-attempt.jsonl`;
  verifyBoundary();absent(`/srv/workers/jobs/${JOB}`);
  attempt=fs.openSync(path,C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,0o400);
  const created=fs.fstatSync(attempt,{bigint:true});
  journal={fd:attempt,path,directory:false,mode:0o400,dev:created.dev,ino:created.ino,mntId:mountId(attempt)};
  verifyBoundary();
  write(attempt,{kind:'OWNED_PUBLIC_ATTEMPT',unit:UNIT,pid:process.pid,startTicks,invocationId:process.env.INVOCATION_ID,head:HEAD,ownerReceipt:pin.trim()});fs.fsyncSync(results);
  const result=module.stagePublic9ca(prerequisites);
  verifyBoundary();
  requireFact(sha(adapter)===ADAPTER_SHA&&sha(ownership)===pin.trim(),'changed caller inputs after stage');
  write(attempt,{kind:'PUBLIC_DATA_ONLY',result,fullEightAcceptance:'UNPROVEN'});
} catch(error) {
  if(attempt!==undefined) {
    try {verifyBoundary?.();write(attempt,{kind:'PARTIAL_OR_UNCERTAIN',retry:'HOLD',fullEightAcceptance:'UNPROVEN'});}
    catch {/* Preserve the owned intent if current custody is uncertain; no further write or retry. */}
  }
  throw error;
} finally {
  if(attempt!==undefined)fs.closeSync(attempt);
  for(const h of held.reverse())fs.closeSync(h.fd);
}
