// Fixed read-only recovery cell. Does not submit, stop, reset, adopt or remove anything.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const BASE='/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1';
const UNIT='subscription-runtime-installer-73000000-0000-4000-8000-9ca302fabd07.service';
function read(path:string,max:number):Buffer {
 const parents:number[]=[];let parent=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);parents.push(parent);
 const parts=path.slice(1).split('/');
 for(const part of parts.slice(0,-1)){parent=fs.openSync(`/proc/self/fd/${parent}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  parents.push(parent);const s=fs.fstatSync(parent,{bigint:true});if(s.uid!==0n||s.gid!==0n||(s.mode&0o022n)!==0n)throw new Error('recovery ancestry HOLD');}
 const leaf=`/proc/self/fd/${parent}/${parts.at(-1)!}`,fd=fs.openSync(leaf,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd,{bigint:true}),n=fs.lstatSync(path,{bigint:true});
  if(!s.isFile()||s.nlink!==1n||s.uid!==0n||s.gid!==0n||(s.mode&0o7777n)!==0o400n||s.size>BigInt(max)
   ||s.dev!==66305n||s.dev!==n.dev||s.ino!==n.ino)throw new Error('fixed PUBLIC recovery custody HOLD');return fs.readFileSync(fd);
 }finally{fs.closeSync(fd);for(const p of parents.reverse())fs.closeSync(p);}
}
if(fs.readFileSync('/etc/machine-id','utf8').trim()!=='d856d40da5ad4e23b4f67773e5942842'
 ||fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!=='f12bc43a-9252-42d4-919d-85b846a176a8')throw new Error('recovery host/boot HOLD');
const status=spawnSync('/usr/bin/systemctl',['show',UNIT,'--property=Id,LoadState,ActiveState,SubState,Transient,MainPID,InvocationID,ControlGroup,Result,ExecMainCode,ExecMainStatus'],
 {shell:false,cwd:'/',encoding:'utf8',timeout:5000,maxBuffer:8192,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:BASE,TMPDIR:`${BASE}/bootstrap-tmp`},stdio:['ignore','pipe','pipe']});
if(status.error||status.signal||status.status!==0)throw new Error('same-unit status uncertain; preserve; never resubmit');
const facts=Object.fromEntries(status.stdout.trimEnd().split('\n').map(s=>{const p=s.indexOf('=');if(p<1)throw new Error('unit properties HOLD');return [s.slice(0,p),s.slice(p+1)];}));
const owner=read(`${BASE}/control/intake-owner-receipt.json`,8192),pin=read(`${BASE}/control/intake-owner-receipt.sha256`,65);
const digest=createHash('sha256').update(owner).digest('hex');if(!pin.equals(Buffer.from(`${digest}\n`)))throw new Error('owner digest HOLD');
const submitted:unknown=JSON.parse(read(`${BASE}/results/PUBLIC-submit-once.json`,128*1024).toString('utf8'));
if(!submitted||typeof submitted!=='object'||(submitted as Record<string,unknown>).unit!==UNIT
 ||(submitted as Record<string,unknown>).ownerReceiptSha256!==digest)throw new Error('owned once-only reservation HOLD');
let journal:Record<string,unknown>[]=[];
try{journal=read(`${BASE}/results/PUBLIC-bootstrap-attempt.jsonl`,8*1024*1024).toString('utf8').trim().split('\n').map(s=>JSON.parse(s) as Record<string,unknown>);}
catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const terminal=facts.MainPID==='0'&&((facts.ActiveState==='active'&&facts.SubState==='exited')||facts.ActiveState==='failed'||facts.ActiveState==='inactive');
const start=journal[0],success=terminal&&facts.LoadState==='loaded'&&facts.Id===UNIT&&facts.Transient==='yes'
 &&facts.ControlGroup===`/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${UNIT}`
 &&facts.Result==='success'&&facts.ExecMainStatus==='0'&&start?.unit===UNIT
 &&start.invocationId===facts.InvocationID&&journal.at(-1)?.kind==='PUBLIC_DATA_ONLY';
process.stdout.write(JSON.stringify({kind:'FIXED_PUBLIC_STATUS',unit:UNIT,ownerReceiptSha256:digest,facts,journalKinds:journal.map(r=>r.kind),
 terminal,publicStageObservedSuccess:success,retry:'HOLD',fullEightAcceptance:'UNPROVEN'})+'\n');
