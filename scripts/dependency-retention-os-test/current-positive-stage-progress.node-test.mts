import assert from 'node:assert/strict';
import test from 'node:test';
import {knownChildFailure as cChild} from './run-current-positive-public.mts';
import {createCStageProgressEncoder,CStageProgressPhase,STAGE_BUDGET_MS} from './stage-current-positive-public.mts';
import {stageProgressData,lastStageProgress} from './run-current-positive-public.mts';
const progressCounters=()=>({objects:4,processedObjects:10,processedBytes:8192,guardCalls:20});
const progressRow=()=>({kind:'C_STAGE_PROGRESS' as const,version:1 as const,sequence:1,phase:CStageProgressPhase.tracked_modes,elapsedMs:5000,...progressCounters()});
const progressLine=(v:unknown)=>Buffer.from(JSON.stringify(v)+'\n');
test('actual encoder and closed standalone runner parser agree for every original finite phase',()=>{
 const emit=createCStageProgressEncoder(),rows=[] as Buffer[];let elapsed=0;
 for(const phase of Object.values(CStageProgressPhase)){const r=emit(phase,elapsed++,progressCounters());assert(r);assert(stageProgressData(JSON.parse(r.toString())));rows.push(r);}
 const stderr=Buffer.concat(rows);assert.equal(lastStageProgress(stderr)?.phase,CStageProgressPhase.complete);assert.equal(lastStageProgress(stderr)?.sequence,rows.length);
 const diagnostic=cChild(Buffer.concat([Buffer.from('PRIVATE_CANARY\n'),stderr,Buffer.from('Error: PUBLIC_STAGE_HOLD:cancelled_or_deadline\n')]));assert.equal(diagnostic.knownReason,'cancelled_or_deadline');assert.equal(diagnostic.stageProgress?.phase,CStageProgressPhase.complete);assert(!JSON.stringify(diagnostic).includes('PRIVATE_CANARY'));
});
test('SIGKILL-style stderr with only completed progress retains exact last phase and aggregate counters',()=>{
 const r=progressRow(),diagnostic=cChild(progressLine(r));assert.equal(diagnostic.knownReason,null);assert.deepEqual(diagnostic.sourceFrames,[]);assert.deepEqual(diagnostic.stageProgress,r);

});
test('progress parser rejects unknown phases, extra fields and out-of-bound or noninteger counters',()=>{
 for(const r of [{...progressRow(),phase:'PRIVATE_CANARY'},{...progressRow(),secret:'PRIVATE_CANARY'},{...progressRow(),version:2},{...progressRow(),sequence:65},{...progressRow(),objects:100001},{...progressRow(),processedObjects:1600001},{...progressRow(),processedBytes:16*1024**3+1},{...progressRow(),guardCalls:12800001},{...progressRow(),elapsedMs:STAGE_BUDGET_MS+1},{...progressRow(),objects:-1},{...progressRow(),objects:0.5}]){assert.equal(stageProgressData(r),null);assert.equal(lastStageProgress(progressLine(r)),null);}
});
test('only a full canonical monotonic progress sequence is retained, never an arbitrary message substring',()=>{
 const a=progressRow(),b={...a,sequence:2,elapsedMs:6000};assert.deepEqual(lastStageProgress(Buffer.concat([progressLine(a),progressLine(b)])),b);
 for(const stderr of [Buffer.from('text '+JSON.stringify(a)+'\n'),Buffer.from(JSON.stringify(a,null,2)+'\n'),Buffer.from(JSON.stringify(a)+' \n'),Buffer.concat([progressLine(a),progressLine({...b,sequence:1})]),Buffer.concat([progressLine(a),progressLine({...b,elapsedMs:4000})]),Buffer.concat([progressLine(a),progressLine({...b,processedBytes:1})]),Buffer.concat([progressLine(a),progressLine({...b,extra:'PRIVATE_CANARY'})])])assert.equal(lastStageProgress(stderr),null);
});
test('progress DATA refuses proxy traps/revoked proxies/getters without invocation or raw-text disclosure',()=>{
 let calls=0;const p=new Proxy(progressRow(),{getPrototypeOf(){calls++;throw Error('PRIVATE_CANARY');}});assert.equal(stageProgressData(p),null);assert.equal(calls,0);
 const rev=Proxy.revocable(progressRow(),{});rev.revoke();assert.equal(stageProgressData(rev.proxy),null);
 const getter=Object.defineProperty(progressRow(),'phase',{enumerable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});assert.equal(stageProgressData(getter),null);assert.equal(calls,0);
 const buffer=new Proxy(Buffer.alloc(0),{get(){calls++;throw Error('PRIVATE_CANARY');}});assert.equal(lastStageProgress(buffer),null);assert.equal(calls,0);
 assert.equal(lastStageProgress(Buffer.alloc(65537)),null);assert.equal(lastStageProgress(Buffer.concat([progressLine(progressRow()),Buffer.from([255])])),null);
});

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('a real timed-out local Node child preserves pipe progress before SIGKILL without raw text',()=>{
 const moduleUrl=new URL('./stage-current-positive-public.mts',import.meta.url).href;
 const source="import {createCStageProgressEncoder,CStageProgressPhase} from "+JSON.stringify(moduleUrl)+";const emit=createCStageProgressEncoder();process.stderr.write(emit(CStageProgressPhase.initial_pins,0,{objects:0,processedObjects:0,processedBytes:0,guardCalls:0}));process.stderr.write(emit(CStageProgressPhase.tracked_modes,1,{objects:3,processedObjects:7,processedBytes:1024,guardCalls:12}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);";
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{PATH:process.env.PATH??''},timeout:1000,killSignal:'SIGKILL',maxBuffer:65536});
 assert.equal(r.signal,'SIGKILL');assert.equal((r.error as NodeJS.ErrnoException|undefined)?.code,'ETIMEDOUT');
 const diagnostic=cChild(r.stderr);assert.equal(diagnostic.stageProgress?.phase,CStageProgressPhase.tracked_modes);assert.equal(diagnostic.stageProgress?.processedObjects,7);assert.equal(diagnostic.stageProgress?.processedBytes,1024);assert.equal(diagnostic.knownReason,null);assert.equal(r.stdout.length,0);
});

test('genuine Buffer instance poison accessors are never read by either C stderr DATA reader',()=>{
 for(const property of ['length','toString','equals','buffer','byteLength','byteOffset',Symbol.iterator]){
  const row=progressRow(),bytes=progressLine(row);let calls=0;Object.defineProperty(bytes,property,{configurable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});
  assert.deepEqual(lastStageProgress(bytes),row);assert.deepEqual(cChild(bytes).stageProgress,row);assert.equal(calls,0);
 }
});

const counts=()=>({objects:4,processedObjects:10,processedBytes:8192,guardCalls:20});
test('observational progress emits phase changes and bounded budget-derived cadence without timers',()=>{
 const interval=Math.ceil(STAGE_BUDGET_MS/(64-Object.keys(CStageProgressPhase).length-1)),emit=createCStageProgressEncoder(),a=emit(CStageProgressPhase.initial_pins,0,counts());assert(a);assert.equal(JSON.parse(a.toString()).sequence,1);
 assert.equal(emit(CStageProgressPhase.initial_pins,interval-1,counts()),null);
 const b=emit(CStageProgressPhase.initial_pins,interval,counts());assert(b);assert.equal(JSON.parse(b.toString()).sequence,2);
 const c=emit(CStageProgressPhase.git_metadata_before,interval+1,counts());assert(c);assert.equal(JSON.parse(c.toString()).phase,'git_metadata_before');
});
test('progress reserves every finite phase and final record within64 records/16KiB',()=>{
 const emit=createCStageProgressEncoder(),rows:Buffer[]=[];const interval=Math.ceil(STAGE_BUDGET_MS/(64-Object.keys(CStageProgressPhase).length-1));
 const initial=emit(CStageProgressPhase.initial_pins,0,counts());assert(initial);rows.push(initial);
 for(let i=1;i<=64-Object.keys(CStageProgressPhase).length-1;i++){const r=emit(CStageProgressPhase.initial_pins,i*interval,counts());assert(r);rows.push(r);}
 assert.equal(emit(CStageProgressPhase.initial_pins,STAGE_BUDGET_MS,counts()),null);
 for(const phase of Object.values(CStageProgressPhase).slice(1)){const r=emit(phase,STAGE_BUDGET_MS,counts());assert(r);rows.push(r);}
 const final=emit(CStageProgressPhase.complete,STAGE_BUDGET_MS,counts(),true);assert(final);rows.push(final);
 assert.equal(rows.length,64);assert.equal(emit(CStageProgressPhase.complete,STAGE_BUDGET_MS,counts(),true),null);assert(rows.every(r=>r.length<=256));assert(Buffer.concat(rows).length<=16384);
 assert.deepEqual(rows.map(r=>JSON.parse(r.toString()).sequence),Array.from({length:64},(_,i)=>i+1));
});
test('progress counters reject foreign properties, accessors, proxies and values beyond original finite work bounds',()=>{
 const emit=createCStageProgressEncoder();let calls=0;const proxy=new Proxy(counts(),{getPrototypeOf(){calls++;throw Error('PRIVATE_CANARY');}});
 assert.equal(emit(CStageProgressPhase.initial_pins,0,proxy),null);assert.equal(calls,0);
 const getter=Object.defineProperty(counts(),'objects',{enumerable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});assert.equal(emit(CStageProgressPhase.initial_pins,0,getter),null);assert.equal(calls,0);
 for(const c of [{...counts(),objects:100001},{...counts(),processedObjects:1600001},{...counts(),processedBytes:16*1024**3+1},{...counts(),guardCalls:12800001},{...counts(),objects:-0},{...counts(),processedBytes:NaN},{...counts(),private:'PRIVATE_CANARY'}])assert.equal(emit(CStageProgressPhase.initial_pins,0,c),null);
 assert.equal(emit(CStageProgressPhase.initial_pins,-1,counts()),null);assert.equal(emit(CStageProgressPhase.initial_pins,STAGE_BUDGET_MS+1,counts()),null);
});

import ts from 'typescript';
import {readFileSync} from 'node:fs';
test('actual successful Stage close preserves original result when observational descriptor write fails',()=>{
 const text=readFileSync(new URL('./run-current-positive-public.mts',import.meta.url),'utf8'),ast=ts.createSourceFile('runner.mts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let success:ts.Block|undefined;
 const find=(node:ts.Node)=>{if(ts.isIfStatement(node)&&node.elseStatement&&ts.isBlock(node.elseStatement)&&node.elseStatement.getText(ast).includes("status:'C_STAGE_PROGRESS_OBSERVED'"))success=node.elseStatement;ts.forEachChild(node,find);};find(ast);assert(success);
 const body=ts.transpileModule(success.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const run=new Function('phase','PositiveTransportPhase','lastStageProgress','Buffer','stderrChunks','fs','resolve','chunks',body);
 for(const phase of ['stage','install','handoff']){let writes=0,resolved:Buffer|undefined;const expected=Buffer.from('original child bytes');
  run(phase,{Stage:'stage'},lastStageProgress,Buffer,[progressLine(progressRow())],{writeSync(fd:number){assert.equal(fd,2);writes++;throw Error('DATA descriptor failure');}},(v:Buffer)=>{resolved=v;},[expected]);
  assert.deepEqual(resolved,expected);assert.equal(writes,phase==='stage'?1:0);
 }
});


test('actual closed fd2 cannot replace successful child completion',()=>{
 const text=readFileSync(new URL('./run-current-positive-public.mts',import.meta.url),'utf8'),ast=ts.createSourceFile('runner.mts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let success:ts.Block|undefined;
 const find=(node:ts.Node)=>{if(ts.isIfStatement(node)&&node.elseStatement&&ts.isBlock(node.elseStatement)&&node.elseStatement.getText(ast).includes("status:'C_STAGE_PROGRESS_OBSERVED'"))success=node.elseStatement;ts.forEachChild(node,find);};find(ast);assert(success);
 const body=ts.transpileModule(success.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const script="import * as fs from 'node:fs';import {lastStageProgress,PositiveTransportPhase} from "+JSON.stringify(new URL('./run-current-positive-public.mts',import.meta.url).href)+";const phase=PositiveTransportPhase.Stage,stderrChunks=[Buffer.from("+JSON.stringify(progressLine(progressRow()).toString())+")],chunks=[Buffer.from('original child bytes')];const resolve=v=>process.stdout.write(v);fs.closeSync(2);"+body;
 const child=spawnSync(process.execPath,['--input-type=module','--eval',script],{timeout:5000,maxBuffer:65536,encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.stdout,'original child bytes');
});
