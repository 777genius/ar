// Local fixed first-Positive public sender. Explicit digest pins only, no remote path/command API.
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {types as utilTypes} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
const BASE='/Volumes/Transcend/dev/projects/quanta/subscription-runtime/outputs/dependency-retention-recovery-20261009/full-positive-public-bootstrap-inputs-current';
const NODE='/opt/nodejs/node-v24.21.0-linux-x64/bin/node';
const names=['preparation-input.json','source.bundle','public-files.payload','stage-current-positive-public.mts','run-current-positive-public.mts','review.json','outer-input.json','public-input.json'];
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fact(v:unknown,why:string):asserts v{if(!v)throw new Error('PUBLIC_SENDER_HOLD:'+why);}
function quote(v:string):string{fact(!v.includes('\0'),'nul');return "'"+v.replaceAll("'","'\\''")+"'";}
type Input={fd:number;path:string;identity:string;sha256:string;bytes:number};const inputs:Input[]=[];
function identity(s:fs.BigIntStats):string{return [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function check(h:Input):void{const a=fs.fstatSync(h.fd,{bigint:true}),b=fs.lstatSync(h.path,{bigint:true});fact(a.isFile()&&b.isFile()&&a.nlink===1n&&identity(a)===h.identity&&identity(b)===h.identity,'source_identity');}
function open(path:string,pin:string,max:number):Input{fact(/^[a-f0-9]{64}$/.test(pin),'pin');const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),s=fs.fstatSync(fd,{bigint:true});const h={fd,path,identity:identity(s),sha256:pin,bytes:Number(s.size)};inputs.push(h);fact(s.size>0n&&s.size<=BigInt(max),'bound');check(h);verify(h);return h;}
function verify(h:Input):void{check(h);const b=Buffer.alloc(1024*1024),sha=createHash('sha256');let pos=0;for(;;){const n=fs.readSync(h.fd,b,0,b.length,pos);if(!n)break;sha.update(b.subarray(0,n));pos+=n;}fact(pos===h.bytes&&sha.digest('hex')===h.sha256,'source_hash');check(h);}
const args=process.argv.slice(2),status=args[0]==='--status';fact(args.length===(status?3:2),'argv');const pin=args[status?1:0]!,cellPin=args[status?2:1]!;fact(/^[a-f0-9]{64}$/.test(pin),'delivery_pin');
const delivery=open(BASE+'/delivery.json',pin,16384),bytes=fs.readFileSync(delivery.fd),d=JSON.parse(bytes.toString()) as {files:{name:string;bytes:number;sha256:string}[]};
const cell=open(dirname(fileURLToPath(import.meta.url))+'/'+(status?'inspect':'bootstrap')+'-current-positive-public.mts',cellPin,2*1024**2),source=fs.readFileSync(cell.fd).toString('utf8');
const remote=['/usr/bin/sudo','-n','--','/usr/bin/env','-i','--chdir=/','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C','HOME=/srv/workers','TMPDIR=/srv/workers','/bin/sh','-c','ulimit -Sn 65536 && exec "$@"','--',NODE,'--input-type=module-typescript','--eval',source,pin].map(quote).join(' ');
// Local pipe acknowledgement is not remote receipt or durable publication.
const transferTimeoutMs=900000;
type SenderPhase='host_key'|'input_validation'|'spawn'|'header_write'|'row_write'|'row_verify'|'final_verify'|'stdin_end'|'await_close';
const senderStarted=performance.now();let sshStarted:number|null=null;let senderPhase:SenderPhase='host_key',failedPhase:SenderPhase|undefined,rowIndex:number|null=null,attemptedBytes=0,acknowledgedWriteBytes=0,completedRows=0,childClosed=false,childExitCode:number|null=null,childSignal:string|null=null,childErrorCode:string|null=null,cleanupTerminationRequested=false;
const senderCodes=new Set(['EPIPE','ECONNRESET','ETIMEDOUT','ENOENT','EACCES','EPERM','EIO','EINVAL','ENOMEM','EAGAIN']);
const senderSignals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGABRT','SIGSEGV','SIGPIPE']);
const senderReasons=new Set(['known_host_lookup','expected_host_key','roster','fixed_name','roster_size','source_identity','source_hash','short_input','transport_uncertain_same_attempt_only']);
function senderError(error:unknown):{code:string;reason:string|null}{
 try{if(error===null||(typeof error!=='object'&&typeof error!=='function')||utilTypes.isProxy(error))return {code:'UNKNOWN',reason:null};
 const code=Object.getOwnPropertyDescriptor(error,'code')?.value,message=Object.getOwnPropertyDescriptor(error,'message')?.value;
 const suffix=typeof message==='string'&&message.startsWith('PUBLIC_SENDER_HOLD:')?message.slice(19):null;
 return {code:typeof code==='string'&&senderCodes.has(code)?code:'UNKNOWN',reason:typeof suffix==='string'&&senderReasons.has(suffix)?suffix:null};
 }catch{return {code:'UNKNOWN',reason:null};}
}
function reportSenderFailure(error:unknown):void{
 try{const diagnostic={status:'LOCAL_TRANSFER_UNCERTAIN',retry:'HOLD',reconciliation:'same_attempt_required',phase:failedPhase??senderPhase,rowIndex,attemptedBytes,acknowledgedWriteBytes,completedRows,elapsedMs:Math.max(0,Math.floor(performance.now()-(sshStarted??senderStarted))),configuredTimeoutMs:status?30000:transferTimeoutMs,clock:sshStarted===null?'local_preflight':'ssh_process',primary:senderError(error),child:{closed:childClosed,exitCode:childExitCode,signal:childSignal,errorCode:childErrorCode},cleanupTerminationRequested,remoteReceipt:'UNPROVEN'};
 const bytes=Buffer.from(JSON.stringify(diagnostic)+'\n');if(bytes.length<=2048)fs.writeSync(2,bytes,0,bytes.length);
 }catch{/* Observability never replaces the primary transfer failure. */}
}
let primary=false;
try{
 const key=spawnSync('/usr/bin/ssh-keygen',['-F','176.9.7.209','-f','/Users/belief/.ssh/known_hosts'],{encoding:'utf8',timeout:5000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});fact(!key.error&&!key.signal&&key.status===0,'known_host_lookup');const keys=key.stdout.split('\n').filter(line=>!line.startsWith('#')&&line.split(/\s+/)[1]==='ssh-ed25519');fact(keys.length===1&&'SHA256:'+createHash('sha256').update(Buffer.from(keys[0]!.split(/\s+/)[2]!,'base64')).digest('base64').replace(/=+$/,'')==='SHA256:Gk6uGoQOgblNFYao/ItTapfVtkR05X0MUBIpwxXoTWQ','expected_host_key');
 senderPhase='input_validation';if(!status){fact(Array.isArray(d.files)&&d.files.length===names.length,'roster');for(let i=0;i<names.length;i++){const r=d.files[i]!;fact(r.name===names[i]&&Number.isSafeInteger(r.bytes)&&r.bytes>0,'fixed_name');const h=open(BASE+'/'+r.name,r.sha256,i===2?1024**3:i===1?128*1024**2:i===0?32*1024**2:2*1024**2);fact(h.bytes===r.bytes,'roster_size');}}
 senderPhase='spawn';sshStarted=performance.now();const ssh=spawn('/usr/bin/ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','HostKeyAlgorithms=ssh-ed25519','-o','HostKeyAlias=176.9.7.209','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','workers-fsn1-01-private',remote],{shell:false,stdio:[status?'ignore':'pipe','inherit','inherit'],timeout:status?30000:transferTimeoutMs});const closeObservation=new Promise<void>(resolve=>ssh.once('close',(code,signal)=>{childClosed=true;childExitCode=Number.isSafeInteger(code)?code:null;childSignal=signal===null?null:senderSignals.has(signal)?signal:'UNKNOWN';resolve();}));ssh.on('error',error=>{childErrorCode=senderError(error).code;});const completion=once(ssh,'close');void completion.catch(()=>undefined);
 try{if(!status){const stdin=ssh.stdin!;stdin.on('error',()=>{});const write=(b:Buffer)=>new Promise<void>((resolve,reject)=>{attemptedBytes+=b.length;stdin.write(b,e=>{if(e)reject(e);else{acknowledgedWriteBytes+=b.length;resolve();}});});const len=Buffer.alloc(4);len.writeUInt32BE(bytes.length);senderPhase='header_write';await write(Buffer.concat([len,bytes]));const b=Buffer.alloc(1024*1024);for(const [index,h] of inputs.slice(2).entries()){rowIndex=index;check(h);let pos=0;while(pos<h.bytes){const n=fs.readSync(h.fd,b,0,Math.min(b.length,h.bytes-pos),pos);fact(n>0,'short_input');senderPhase='row_write';await write(b.subarray(0,n));pos+=n;check(h);}senderPhase='row_verify';verify(h);completedRows++;}senderPhase='final_verify';verify(delivery);verify(cell);senderPhase='stdin_end';stdin.end();}senderPhase='await_close';const [code,signal]=await completion;fact(code===0&&!signal,'transport_uncertain_same_attempt_only');}
 catch(e){failedPhase=senderPhase;ssh.stdin?.destroy();cleanupTerminationRequested=true;ssh.kill('SIGTERM');await completion.catch(()=>undefined);await closeObservation;throw e;}
}catch(e){primary=true;reportSenderFailure(e);process.exitCode=1;}finally{let bad=false;for(const h of inputs.reverse()){try{fs.closeSync(h.fd);}catch{bad=true;}}if(bad){try{fs.writeSync(2,'{"status":"LOCAL_CLOSE_UNCERTAIN","retry":"HOLD"}\n');}catch{/* Preserve the original transfer or close outcome. */}if(!primary)throw new Error('LOCAL_CLOSE_UNCERTAIN');}}
