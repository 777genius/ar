import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
interface Request {operation:'start'|'status';machineId:string;jobId:string}
interface TransportModule {hostTransport(input:{host:string;machineId:string;socketDir:string;run:(args:readonly string[],stdin?:string)=>Promise<string>}):{request(input:Request):Promise<unknown>}}
const url=process.argv[2]?pathToFileURL(process.argv[2]):new URL('../host-job-transport.mjs',import.meta.url);
const module=await import(url.href) as TransportModule;
const root=await mkdtemp(join(tmpdir(),'TEST-ssh-no-replay-r3455-'));
const machineId='1'.repeat(32),jobId='TEST-consumed-start-r3455';let checks=0,starts=0,statuses=0,masters=0;
const consumed:Request[]=[];
async function run(args:readonly string[],stdin=''):Promise<string>{
 if(args.includes('-O')){checks++;return '';}
 if(args.includes('-M')){masters++;return '';}
 assert(args.includes('-oProxyCommand=false')&&args.includes('-oControlMaster=no'));
 const request=JSON.parse(stdin) as Request;assert.equal(request.machineId,machineId);assert.equal(request.jobId,jobId);
 if(request.operation==='start'){starts++;consumed.push(request);if(starts===1)throw new Error('TEST response lost after consumed START');return JSON.stringify({ok:true,result:{unexpectedReplay:true}});}
 assert.equal(request.operation,'status');statuses++;return JSON.stringify({ok:true,result:{state:'started',fromConsumedFirstStart:true}});
}
try{
 const transport=module.hostTransport({host:'TEST-no-replay-r3534',machineId,socketDir:root,run});
 await assert.rejects(transport.request({operation:'start',machineId,jobId}),error=>error instanceof Error&&error.message==='ssh request outcome unknown'&&error.cause instanceof Error&&error.cause.message==='TEST response lost after consumed START');
 assert.equal(starts,1,'body accepted before response loss must never be submitted twice');assert.equal(consumed.length,1);assert.equal(checks,1,'failure must not eagerly reconnect');assert.equal(masters,0);
 assert.deepEqual(await transport.request({operation:'status',machineId,jobId}),{state:'started',fromConsumedFirstStart:true});assert.equal(checks,2,'next explicit status reconnects after failed generation');assert.equal(statuses,1);assert.equal(starts,1);assert.equal(masters,0);
 // A failed initial check bootstraps before dispatching its first body.
 const events:string[]=[];
 const bootstrap=module.hostTransport({host:'TEST-bootstrap-r3534',machineId,socketDir:join(root,'bootstrap'),run:async(args,body='')=>{
  if(args.includes('-O')){events.push('check');throw new Error('TEST missing initial master');}
  if(args.includes('-M')){events.push('master');assert.equal(body,'');return '';}
  events.push('body');assert.deepEqual(JSON.parse(body),{operation:'status',machineId,jobId});
  return JSON.stringify({ok:true,result:'TEST bootstrap ready'});
 }});
 assert.equal(await bootstrap.request({operation:'status',machineId,jobId}),'TEST bootstrap ready');
 assert.deepEqual(events,['check','master','body']);
 console.log(JSON.stringify({passed:true,consumedStarts:starts,statusRequests:statuses,connectChecks:checks,sshExecuted:false,providerExecuted:false}));
}finally{await rm(root,{recursive:true,force:true});}
