// Local fixed original H1 public sender. Explicit digest pins only, no remote path/command API.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {parseDelivery,packetNames,H1InstallPhase} from './bootstrap-current-h1-public.mts';
const BASE='/Volumes/Transcend/dev/projects/quanta/subscription-runtime/outputs/dependency-retention-recovery-20261009/full-h1-public-bootstrap-inputs-current';
const NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fact(v:unknown,why:string):asserts v{if(!v)throw new Error('PUBLIC_SENDER_HOLD:'+why);}
function quote(v:string):string{fact(!v.includes('\0'),'nul');return "'"+v.replaceAll("'","'\\''")+"'";}
type Input={fd:number;path:string;identity:string;sha256:string;bytes:number};const inputs:Input[]=[];
function identity(s:fs.BigIntStats):string{return [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function check(h:Input):void{const a=fs.fstatSync(h.fd,{bigint:true}),b=fs.lstatSync(h.path,{bigint:true});fact(a.isFile()&&b.isFile()&&a.nlink===1n&&identity(a)===h.identity&&identity(b)===h.identity,'source_identity');}
function open(path:string,pin:string,max:number):Input{fact(/^[a-f0-9]{64}$/.test(pin),'pin');const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),s=fs.fstatSync(fd,{bigint:true});const h={fd,path,identity:identity(s),sha256:pin,bytes:Number(s.size)};inputs.push(h);fact(s.size>0n&&s.size<=BigInt(max),'bound');check(h);verify(h);return h;}
function verify(h:Input):void{check(h);const b=Buffer.alloc(1024*1024),sha=createHash('sha256');let pos=0;for(;;){const n=fs.readSync(h.fd,b,0,b.length,pos);if(!n)break;sha.update(b.subarray(0,n));pos+=n;}fact(pos===h.bytes&&sha.digest('hex')===h.sha256,'source_hash');check(h);}
const args=process.argv.slice(2),status=args[0]==='--status',offset=status?1:0;fact(args.length===(status?4:3),'argv');const phase=args[offset],pin=args[offset+1]!,cellPin=args[offset+2]!;fact(Object.values(H1InstallPhase).includes(phase as H1InstallPhase),'phase');
const delivery=open(BASE+'/'+phase+'/delivery.json',pin,16384),bytes=fs.readFileSync(delivery.fd),d=parseDelivery(bytes,pin);fact(d.phase===phase,'delivery_phase');const names=packetNames(d.phase);
const cell=open(dirname(fileURLToPath(import.meta.url))+'/'+(status?'inspect':'bootstrap')+'-current-h1-public.mts',cellPin,2*1024**2),source=fs.readFileSync(cell.fd).toString('utf8');
const remote=['/usr/bin/sudo','-n','--','/usr/bin/env','-i','--chdir=/','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','HOME=/srv/workers','TMPDIR=/srv/workers','/bin/sh','-c','ulimit -Sn 65536 && exec "$@"','--',NODE,'--input-type=module-typescript','--eval',source,pin,...(status?[phase!]:[])].map(quote).join(' ');
let primary=false;
try{
 const key=spawnSync('/usr/bin/ssh-keygen',['-F','176.9.7.209','-f','/Users/belief/.ssh/known_hosts'],{encoding:'utf8',timeout:5000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});fact(!key.error&&!key.signal&&key.status===0,'known_host_lookup');const keys=key.stdout.split('\n').filter(line=>!line.startsWith('#')&&line.split(/\s+/)[1]==='ssh-ed25519');fact(keys.length===1&&'SHA256:'+createHash('sha256').update(Buffer.from(keys[0]!.split(/\s+/)[2]!,'base64')).digest('base64').replace(/=+$/,'')==='SHA256:Gk6uGoQOgblNFYao/ItTapfVtkR05X0MUBIpwxXoTWQ','expected_host_key');
 if(!status){fact(Array.isArray(d.files)&&d.files.length===names.length,'roster');for(let i=0;i<names.length;i++){const r=d.files[i]!;fact(r.name===names[i]&&Number.isSafeInteger(r.bytes)&&r.bytes>0,'fixed_name');const h=open(BASE+'/'+phase+'/'+r.name,r.sha256,1024**3);fact(h.bytes===r.bytes,'roster_size');}}
 const ssh=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlgorithms=ssh-ed25519','-o','HostKeyAlias=176.9.7.209','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','iliya@176.9.7.209',remote],{shell:false,stdio:[status?'ignore':'pipe','inherit','inherit'],timeout:status?30000:600000});const completion=once(ssh,'close');
 try{if(!status){const stdin=ssh.stdin!;stdin.on('error',()=>{});const write=(b:Buffer)=>new Promise<void>((resolve,reject)=>stdin.write(b,e=>e?reject(e):resolve()));const len=Buffer.alloc(4);len.writeUInt32BE(bytes.length);await write(Buffer.concat([len,bytes]));const b=Buffer.alloc(1024*1024);for(const h of inputs.slice(2)){check(h);let pos=0;while(pos<h.bytes){const n=fs.readSync(h.fd,b,0,Math.min(b.length,h.bytes-pos),pos);fact(n>0,'short_input');await write(b.subarray(0,n));pos+=n;check(h);}verify(h);}verify(delivery);verify(cell);stdin.end();}const [code,signal]=await completion;fact(code===0&&!signal,'transport_uncertain_same_attempt_only');}
 catch(e){ssh.stdin?.destroy();ssh.kill('SIGTERM');await completion.catch(()=>undefined);throw e;}
}catch(e){primary=true;throw e;}finally{let bad=false;for(const h of inputs.reverse()){try{fs.closeSync(h.fd);}catch{bad=true;}}if(bad){process.stderr.write('{"status":"LOCAL_CLOSE_UNCERTAIN","retry":"HOLD"}\n');if(!primary)throw new Error('LOCAL_CLOSE_UNCERTAIN');}}
