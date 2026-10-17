import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseToolPlan,ToolKind} from './stage-current-h1-public.mts';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),source='a'.repeat(40),manifest='b'.repeat(64);
function plan(){return {version:1,kind:'H1_FINAL_TOOL_ROOT_UNADMITTED_DATA_V1',sourceSha:source,manifestSha256:manifest,payload:{bytes:Buffer.byteLength('SR_PUBLIC_FILES_V1\n')+8+1,sha256:'c'.repeat(64)},rows:[{path:'bin',kind:ToolKind.Alias,mode:0o777,bytes:3,sha256:'',target:'usr'},{path:'usr',kind:ToolKind.Directory,mode:0o755,bytes:0,sha256:'',target:''},{path:'usr/tool',kind:ToolKind.File,mode:0o755,bytes:1,sha256:'d'.repeat(64),target:''}]};}
function parse(value:unknown){const bytes=Buffer.from(JSON.stringify(value)+'\n');return parseToolPlan(bytes,sha(bytes),source,manifest);}
test('toolroot recipe has no invented future physical identity or review claim',()=>{assert.deepEqual(parse(plan()),plan());for(const extra of [{rootIdentity:{}},{approved:true},{nativeQualified:true},{reviewText:'approved'}])assert.throws(()=>parse({...plan(),...extra}));});
test('unknown source or manifest cannot share a prepared operation',()=>{assert.throws(()=>parse({...plan(),sourceSha:'e'.repeat(40)}));assert.throws(()=>parse({...plan(),manifestSha256:'e'.repeat(64)}));});
test('literal alias escapes, missing targets and cycles refuse before any I/O',()=>{for(const target of ['../outside','/usr','missing','bin']){const p=plan();p.rows[0]={...p.rows[0]!,target,bytes:Buffer.byteLength(target)};assert.throws(()=>parse(p));}});
test('parent, roster, mode and payload EOF-size contracts are exact',()=>{const p=plan();for(const change of [{...p,rows:p.rows.slice(1).filter(r=>r.path!=='usr')},{...p,rows:[...p.rows,p.rows[2]]},{...p,rows:p.rows.map(r=>r.kind===ToolKind.File?{...r,mode:0o777}:r)},{...p,payload:{...p.payload,bytes:p.payload.bytes+1}},{...p,rows:p.rows.map(r=>({...r,path:'../'+r.path}))}])assert.throws(()=>parse(change));});

import {createH1StageProgressEncoder,H1StageProgressPhase,STAGE_BUDGET_MS} from './stage-current-h1-public.mts';
const counts=()=>({objects:4,processedObjects:10,processedBytes:8192,guardCalls:20});
test('observational progress emits phase changes and bounded budget-derived cadence without timers',()=>{
 const interval=Math.ceil(STAGE_BUDGET_MS/(64-Object.keys(H1StageProgressPhase).length-1)),emit=createH1StageProgressEncoder(),a=emit(H1StageProgressPhase.initial_pins,0,counts());assert(a);assert.equal(JSON.parse(a.toString()).sequence,1);
 assert.equal(emit(H1StageProgressPhase.initial_pins,interval-1,counts()),null);
 const b=emit(H1StageProgressPhase.initial_pins,interval,counts());assert(b);assert.equal(JSON.parse(b.toString()).sequence,2);
 const c=emit(H1StageProgressPhase.git_metadata_before,interval+1,counts());assert(c);assert.equal(JSON.parse(c.toString()).phase,'git_metadata_before');
});
test('progress reserves every finite phase and final record within64 records/16KiB',()=>{
 const emit=createH1StageProgressEncoder(),rows:Buffer[]=[];const interval=Math.ceil(STAGE_BUDGET_MS/(64-Object.keys(H1StageProgressPhase).length-1));
 const initial=emit(H1StageProgressPhase.initial_pins,0,counts());assert(initial);rows.push(initial);
 for(let i=1;i<=40;i++){const r=emit(H1StageProgressPhase.initial_pins,i*interval,counts());assert(r);rows.push(r);}
 assert.equal(emit(H1StageProgressPhase.initial_pins,STAGE_BUDGET_MS,counts()),null);
 for(const phase of Object.values(H1StageProgressPhase).slice(1)){const r=emit(phase,STAGE_BUDGET_MS,counts());assert(r);rows.push(r);}
 const final=emit(H1StageProgressPhase.complete,STAGE_BUDGET_MS,counts(),true);assert(final);rows.push(final);
 assert.equal(rows.length,64);assert.equal(emit(H1StageProgressPhase.complete,STAGE_BUDGET_MS,counts(),true),null);assert(rows.every(r=>r.length<=256));assert(Buffer.concat(rows).length<=16384);
 assert.deepEqual(rows.map(r=>JSON.parse(r.toString()).sequence),Array.from({length:64},(_,i)=>i+1));
});
test('progress counters reject foreign properties, accessors, proxies and values beyond original finite work bounds',()=>{
 const emit=createH1StageProgressEncoder();let calls=0;const proxy=new Proxy(counts(),{getPrototypeOf(){calls++;throw Error('PRIVATE_CANARY');}});
 assert.equal(emit(H1StageProgressPhase.initial_pins,0,proxy),null);assert.equal(calls,0);
 const getter=Object.defineProperty(counts(),'objects',{enumerable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});assert.equal(emit(H1StageProgressPhase.initial_pins,0,getter),null);assert.equal(calls,0);
 for(const c of [{...counts(),objects:100001},{...counts(),processedObjects:1600001},{...counts(),processedBytes:16*1024**3+1},{...counts(),guardCalls:12800001},{...counts(),objects:-0},{...counts(),processedBytes:NaN},{...counts(),private:'PRIVATE_CANARY'}])assert.equal(emit(H1StageProgressPhase.initial_pins,0,c),null);
 assert.equal(emit(H1StageProgressPhase.initial_pins,-1,counts()),null);assert.equal(emit(H1StageProgressPhase.initial_pins,STAGE_BUDGET_MS+1,counts()),null);
});
