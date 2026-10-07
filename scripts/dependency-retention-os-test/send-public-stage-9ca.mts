// Fixed authorized PUBLIC installation transport. No execution until independent review/strict CI acceptance.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const BASE='/Volumes/Transcend/Codex-artifacts/dependency-retention-execution/native-9ca-public-stage-transport-proposal-75';
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
 const child=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','workers-fsn1-01-public',remote],{shell:false,stdio:['ignore','inherit','inherit'],timeout:30000});
 const [code,signal]=await once(child,'close');process.exit(code===0&&!signal?0:1);
}
const rootReview=process.argv[2];fact(process.argv.length===3&&rootReview&&/^[a-f0-9]{64}$/.test(rootReview),'exact independently accepted ROOT boundary review digest');
const source=sealed('bootstrap-public-stage-9ca.mts').toString('utf8');
const roster:unknown=JSON.parse(sealed('input-roster.json').toString('utf8'));fact(Array.isArray(roster)&&roster.length===15,'fixed15 roster');
type Input=Pin&{name:string;fd:number;ino:bigint;dev:bigint;mtime:bigint;ctime:bigint};
const inputs:Input[]=[];
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
  NODE,'--input-type=module-typescript','--eval',source,rootReview].map(quote).join(' ');
 const ssh=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','workers-fsn1-01-public',remote],
  {shell:false,stdio:['pipe','inherit','inherit'],timeout:600000});
 const completion=once(ssh,'close');ssh.stdin.on('error',()=>{/* close/error completion records uncertain transport */});
 try {for(const input of inputs){check(input);for await(const chunk of fs.createReadStream(input.path,{fd:input.fd,autoClose:false,start:0,highWaterMark:1024*1024})){
   const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);await new Promise<void>((resolve,reject)=>ssh.stdin.write(b,error=>error?reject(error):resolve()));
  }check(input);}ssh.stdin.end();const [code,signal]=await completion;
  fact(code===0&&!signal,'transport uncertain/failed; inspect same fixed unit and preserved attempt, never rerun');
 }catch(error){ssh.stdin.destroy();ssh.kill('SIGTERM');await completion.catch(()=>undefined);throw error;}
}finally{for(const input of inputs)fs.closeSync(input.fd);}
