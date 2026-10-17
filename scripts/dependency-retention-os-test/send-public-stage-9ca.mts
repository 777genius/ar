// Fixed authorized PUBLIC installation transport. No execution until independent review/strict CI acceptance.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const BASE='/Volumes/Transcend/Codex-artifacts/dependency-retention-execution/full-established-administrator-installed-publication-100';
const NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node';
const freeze:unknown=JSON.parse(fs.readFileSync(`${BASE}/FREEZE.json`,'utf8'));
function fact(ok:unknown,why:string):asserts ok {if(!ok)throw new Error(`PUBLIC sender HOLD: ${why}`);}
fact(freeze!==null&&typeof freeze==='object'&&Array.isArray((freeze as Record<string,unknown>).files),'immutable proposal freeze');
type Pin={path:string;bytes:number;sha256:string};
const seals=(freeze as {files:Pin[]}).files;
function sealed(name:string):Buffer {
 const pin=seals.find(p=>p.path===name);fact(pin,'required frozen source');const data=fs.readFileSync(`${BASE}/${name}`);
 fact(data.length===pin.bytes&&createHash('sha256').update(data).digest('hex')===pin.sha256,'frozen source changed');return data;
}
if(process.argv.length===3&&process.argv[2]==='--status'){
 const remote=['/usr/bin/sudo','-n','--','/usr/bin/env','-i','--chdir=/','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','HOME=/srv/workers','TMPDIR=/srv/workers',
  NODE,'--input-type=module-typescript','--eval',sealed('inspect-public-stage-9ca.mts').toString('utf8')].map(quote).join(' ');
 const child=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','workers-fsn1-01',remote],{shell:false,stdio:['ignore','inherit','inherit'],timeout:30000});
 const [code,signal]=await once(child,'close');process.exit(code===0&&!signal?0:1);
}
const rootReview=process.argv[2];fact(process.argv.length===3&&rootReview&&/^[a-f0-9]{64}$/.test(rootReview),'exact independently accepted ROOT boundary review digest');
const source=sealed('bootstrap-public-stage-9ca.mts').toString('utf8');
const administrativeHeader=sealed('administrative-transport.json');
const administrativeDigest=createHash('sha256').update(administrativeHeader).digest('hex');
const roster:unknown=JSON.parse(sealed('input-roster.json').toString('utf8'));fact(Array.isArray(roster)&&roster.length===22,'fixed22 archive/source roster');
const administrativeNames=['run-public-stage-9ca.mts','administrative-installation.js','administrative-public-maintenance.js','administration-reviewed-source.json','original-bootstrap-boundary-FREEZE.json','original-bootstrap-boundary-report.md','original-bootstrap-boundary-review.json','administration-independent-review-FREEZE.json'];
const administrativeRows:unknown=JSON.parse(administrativeHeader.toString('utf8'));
fact(Array.isArray(administrativeRows)&&administrativeRows.length===8,'fixed administrative header roster');
const expectedNames=['source-9ca302.bundle','profile-artifact.zip','runtime-artifact.zip','runtime-validated-public.tgz','node-v22.23.3-linux-x64.tar.xz','current-git-role-manifest.json','current-generated-role-manifest.json','runtime-role-manifest.json','actual-current-runtime-inventory.json','node-full-member-manifest.json','DATA-FREEZE.json','DATA-review.json',administrativeNames[0],'stage-public-9ca.mts','adapter-independent-review-FREEZE.json',...administrativeNames.slice(1)];
for(let index=0;index<roster.length;index++)fact(roster[index]?.name===expectedNames[index],'fixed ordered transport member');
for(let index=0;index<administrativeNames.length;index++){
 const row=administrativeRows[index],member=roster[index===0?12:14+index];
 fact(Array.isArray(row)&&row.length===3&&row[0]===administrativeNames[index]&&member.name===row[0]&&member.bytes===row[1]&&member.sha256===row[2],'header/member exact join');
}
type Input=Pin&{name:string;fd:number;ino:bigint;dev:bigint;mtime:bigint;ctime:bigint};
const inputs:Input[]=[];
let primaryFailure:unknown;
function check(input:Input):void {
 const held=fs.fstatSync(input.fd,{bigint:true}),named=fs.lstatSync(input.path,{bigint:true});
 fact([held,named].every(s=>s.isFile()&&s.nlink===1n&&s.size===BigInt(input.bytes)&&s.dev===input.dev&&s.ino===input.ino
  &&s.mtimeNs===input.mtime&&s.ctimeNs===input.ctime),'local pinned source custody');
}
function quote(s:string):string {fact(!s.includes('\0'),'NUL in fixed command');return `'${s.replaceAll("'","'\\''")}'`;}
try {
 for(const row of roster){fact(row!==null&&typeof row==='object','roster row');const r=row as Record<string,unknown>;
  fact(typeof r.path==='string'&&r.path.startsWith('/Volumes/Transcend/Codex-artifacts/dependency-retention-execution/')
   &&typeof r.name==='string'&&/^[A-Za-z0-9_.-]+$/.test(r.name)&&Number.isSafeInteger(r.bytes)&&Number(r.bytes)>0
   &&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256),'fixed roster fields');
  const fd=fs.openSync(r.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(fd,{bigint:true});
  const input={path:r.path,name:r.name,bytes:Number(r.bytes),sha256:r.sha256,fd,dev:s.dev,ino:s.ino,mtime:s.mtimeNs,ctime:s.ctimeNs};inputs.push(input);check(input);
  const hash=createHash('sha256'),b=Buffer.alloc(1024*1024);let p=0;
  for(;;){const n=fs.readSync(fd,b,0,b.length,p);if(!n)break;hash.update(b.subarray(0,n));p+=n;}
  fact(p===input.bytes&&hash.digest('hex')===input.sha256,'entire local PUBLIC input hash');check(input);
 }
 // Fixed existing multiplex alias; sudo is the existing authorized installation/bootstrap exception.
 const remote=['/usr/bin/sudo','-n','--','/usr/bin/env','-i','--chdir=/','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','HOME=/srv/workers','TMPDIR=/srv/workers',
  NODE,'--input-type=module-typescript','--eval',source,rootReview,administrativeDigest].map(quote).join(' ');
 const ssh=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','workers-fsn1-01',remote],
  {shell:false,stdio:['pipe','inherit','inherit'],timeout:600000});
 const completion=once(ssh,'close');ssh.stdin.on('error',()=>{/* close/error completion records uncertain transport */});
 try {const size=Buffer.alloc(4);size.writeUInt32BE(administrativeHeader.length);
   await new Promise<void>((resolve,reject)=>ssh.stdin.write(Buffer.concat([size,administrativeHeader]),error=>error?reject(error):resolve()));
   const buffer=Buffer.alloc(1024*1024);for(const input of inputs){check(input);let position=0;while(position<input.bytes){
   const n=fs.readSync(input.fd,buffer,0,Math.min(buffer.length,input.bytes-position),position);fact(n>0,'owned input short read');
   await new Promise<void>((resolve,reject)=>ssh.stdin.write(buffer.subarray(0,n),error=>error?reject(error):resolve()));position+=n;
  }check(input);}ssh.stdin.end();const [code,signal]=await completion;
  fact(code===0&&!signal,'transport uncertain/failed; inspect same fixed unit and preserved attempt, never rerun');
 }catch(error){ssh.stdin.destroy();ssh.kill('SIGTERM');await completion.catch(()=>undefined);throw error;}
}catch(error){primaryFailure=error;throw error;}
finally{const cleanupFailures:string[]=[];for(const input of inputs){try{fs.closeSync(input.fd);}catch(error){cleanupFailures.push((error as NodeJS.ErrnoException).code??'UNKNOWN');}}
 if(cleanupFailures.length){process.stderr.write(JSON.stringify({kind:'PUBLIC_LOCAL_FD_CLEANUP_FAILED',cleanupFailures,primaryOutcomePreserved:primaryFailure!==undefined,retry:'HOLD'})+'\n');
  if(primaryFailure===undefined)throw new Error('PUBLIC sender HOLD: owned FD cleanup failed after transport; inspect same unit, never resubmit');}}
