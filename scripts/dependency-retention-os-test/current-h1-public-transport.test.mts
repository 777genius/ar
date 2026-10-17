import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseDelivery as bootstrap,selectedUnit,packetNames,packetMode as bootstrapMode,H1InstallPhase,h1UnitRuntime} from './bootstrap-current-h1-public.mts';
import {parseDelivery as runner,packetMode as runnerMode,h1PhaseBudget} from './run-current-h1-public.mts';
import {parseDelivery as inspector,packetMode as inspectorMode} from './inspect-current-h1-public.mts';
import {createH1ExactMountBoundaryValidator,INTAKE as H} from './stage-current-h1-public.mts';
import {INTAKE} from './stage-current-positive-public.mts';
import {knownChildFailure as cChild,transportFailureDiagnostic as cFailure} from './run-current-positive-public.mts';
import {knownChildFailure as hChild,transportFailureDiagnostic as hFailure} from './run-current-h1-public.mts';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),helper='6e5b0c00c93fc4a7a6db82ea81654fd98a4aa2acce1a51184a08aea665fe234a';
function header(phase:H1InstallPhase){return {version:1,phase,sourceSha:'a'.repeat(40),manifestSha256:'b'.repeat(64),prepareDeliverySha256:phase===H1InstallPhase.Prepare?'':'c'.repeat(64),bootId:'11111111-1111-1111-1111-111111111111',files:packetNames(phase).map((name,i)=>({name,bytes:1,sha256:phase===H1InstallPhase.Prepare&&i===0?'b'.repeat(64):phase===H1InstallPhase.Prepare&&i===3?helper:'d'.repeat(64)}))};}
function invoke(value:unknown,parse=bootstrap){const bytes=Buffer.from(JSON.stringify(value)+'\n');return parse(bytes,sha(bytes));}
for(const phase of Object.values(H1InstallPhase))test('original '+phase+' exact positional DATA agrees in all independently pinned controls',()=>{const input=header(phase);for(const parse of [bootstrap,runner,inspector])assert.deepEqual(invoke(input,parse),input);assert.equal(selectedUnit(invoke(input)),'subscription-runtime-h1-installation-'+phase+'-'+createHash('sha256').update(input.sourceSha+':'+input.manifestSha256).digest('hex')+'.service');});
test('prepare helper must be the unchanged positional source before H1 stager evaluation',()=>{const h=header(H1InstallPhase.Prepare);for(const change of [{...h,files:h.files.filter(r=>r.name!=='stage-current-positive-public.mts')},{...h,files:h.files.map(r=>r.name==='stage-current-positive-public.mts'?{...r,sha256:'0'.repeat(64)}:r)},{...h,files:[...h.files.slice(0,3),h.files[4],h.files[3],...h.files.slice(5)]}])for(const parse of [bootstrap,runner,inspector])assert.throws(()=>invoke(change,parse));});
test('finalize positively names the complete original prepare header without admitting review text',()=>{const h=header(H1InstallPhase.Finalize);for(const change of [{...h,prepareDeliverySha256:''},{...h,approved:true},{...h,reviewText:'approved'},{...h,phase:'install'},{...h,files:[...h.files,{name:'allow.json',bytes:1,sha256:'a'.repeat(64)}]}])for(const parse of [bootstrap,runner,inspector])assert.throws(()=>invoke(change,parse));});
test('unknown paths, renamed slots, duplicate rows, aggregate and per-phase limits refuse',()=>{const h=header(H1InstallPhase.Prepare);for(const change of [{...h,files:h.files.map((r,i)=>i===0?{...r,name:'../preparation-input.json'}:r)},{...h,files:h.files.map((r,i)=>i===1?{...r,bytes:128*1024**2+1}:r)},{...h,files:h.files.map((r,i)=>i===7?{...r,bytes:512*1024**2+1}:r)},{...h,files:h.files.map((r,i)=>i===6?{...r,bytes:4*1024**2+1}:r)},{...h,files:h.files.map((r,i)=>i===2?{...r,sha256:'INVALID'}:r)}])assert.throws(()=>invoke(change));});
test('same source with different operation manifest gets a different once-only phase identity',()=>{const a=invoke(header(H1InstallPhase.Finalize)),b=invoke({...header(H1InstallPhase.Finalize),manifestSha256:'f'.repeat(64)});assert.notEqual(selectedUnit(a),selectedUnit(b));assert.throws(()=>bootstrap(Buffer.from('{}'),'a'.repeat(64)));});

test('actual producer mode DATA matches protected Finalize JSON and immutable preparation leaves',()=>{
 const expectedPrivate=new Set(['review.json','h1-staged-subject.json','h1-distro-facts.json','h1-verifier-bootstrap-review.json']);
 for(const phase of Object.values(H1InstallPhase))for(const name of packetNames(phase))for(const mode of [bootstrapMode,runnerMode,inspectorMode])assert.equal(mode(phase,name),phase===H1InstallPhase.Finalize&&expectedPrivate.has(name)?0o600:0o400);
 for(const mode of [bootstrapMode,runnerMode,inspectorMode]){assert.throws(()=>mode(H1InstallPhase.Prepare,'review.json'));assert.throws(()=>mode(H1InstallPhase.Finalize,'../review.json'));assert.throws(()=>mode(H1InstallPhase.Finalize,'allow.json'));}
});


const row=(id:number,path:string,options='rw')=>`${id} 1 0:1 / ${path} ${options} - ext4 /dev/TEST ${options}\n`;
const safe=row(1,'/')+row(2,'/srv/workers')+row(3,'/unrelated');
test('exact-text cache still denies every changed intake or ancestor mount, including after prior success',()=>{
 const intake=H;{const validate=createH1ExactMountBoundaryValidator();validate(safe);validate(Buffer.from(safe).toString());
  validate(safe.replace('/unrelated','/another-unrelated'));
  for(const path of ['/srv','/srv/workers/public-intake',intake,intake+'/source']){
   assert.throws(()=>validate(safe+row(4,path)),/intake_mount_boundary/);
   validate(safe); // Failed text never becomes an accepted cache entry.
  }
  assert.throws(()=>validate('broken\n'),/mountinfo/);assert.throws(()=>validate(' '.repeat(8*1024**2+1)),/mountinfo_bound/);validate(safe);
 }
});
test('both transport sanitizers expose only finite guard/owned source facts, no raw child text or getters',()=>{
 for(const [child,own,root,prefix] of [[cChild,cFailure,INTAKE,'PUBLIC_TRANSPORT_HOLD:'],[hChild,hFailure,H,'H1_TRANSPORT_HOLD:']] as const){
  const stderr=Buffer.from('SECRET raw unrelated\nError: PUBLIC_STAGE_HOLD:cancelled_or_deadline\n    at hold (file://'+root+'/stage-current-positive-public.mts:25:60)\n    at guard (file://'+root+'/stage-current-positive-public.mts:122:12)\n');
  const parsed=child(stderr);assert.equal(parsed.knownReason,'cancelled_or_deadline');assert.equal(parsed.sourceFrames.length,2);assert(!JSON.stringify(parsed).includes('SECRET'));
  assert.equal(child(Buffer.from('Error: PUBLIC_STAGE_HOLD:SECRET')).knownReason,null);assert.equal(child(Buffer.alloc(65537)).sourceFrames.length,0);
  let getters=0;const foreign=Object.defineProperties({}, {message:{get(){getters++;return 'SECRET';}},stack:{get(){getters++;return 'SECRET';}}});
  assert.deepEqual(own(foreign),{reason:null,sourceFrames:[],child:null});assert.equal(getters,0);
  assert.equal(own(Error(prefix+'phase_budget')).reason,'phase_budget');assert.equal(own(Error(prefix+'SECRET')).reason,null);
 }
});

test('formatter refuses proxy traps/revoked proxies and Error accessor fields without invoking them',()=>{
 for(const own of [cFailure,hFailure]){
  let calls=0;const trap=new Proxy({}, {getOwnPropertyDescriptor(){calls++;throw Error('PRIVATE_CANARY');}});
  assert.deepEqual(own(trap),{reason:null,sourceFrames:[],child:null});assert.equal(calls,0);
  const rev=Proxy.revocable({},{});rev.revoke();assert.deepEqual(own(rev.proxy),{reason:null,sourceFrames:[],child:null});
  const custom=Error();for(const key of ['message','name','stack'])Object.defineProperty(custom,key,{configurable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});
  const result=own(custom);assert.equal(calls,0);assert.equal(result.reason,null);assert.deepEqual(result.sourceFrames,[]);assert(!JSON.stringify(result).includes('PRIVATE_CANARY'));
  for(const key of ['name','message']){const lazy=Error();Object.defineProperty(lazy,key,{get(){calls++;throw Error('PRIVATE_CANARY');}});assert.deepEqual(own(lazy).sourceFrames,[]);assert.equal(calls,0);}
  const dataStack=Object.create(null) as Record<string,unknown>;dataStack.message='PRIVATE_CANARY';dataStack.stack='PRIVATE_CANARY';assert.deepEqual(own(dataStack),{reason:null,sourceFrames:[],child:null});
 }
});

import {createH1StageProgressEncoder,H1StageProgressPhase,STAGE_BUDGET_MS} from './stage-current-h1-public.mts';
import {stageProgressData,lastStageProgress} from './run-current-h1-public.mts';
const progressCounters=()=>({objects:4,processedObjects:10,processedBytes:8192,guardCalls:20});
const progressRow=()=>({kind:'H1_STAGE_PROGRESS' as const,version:1 as const,sequence:1,phase:H1StageProgressPhase.tracked_modes,elapsedMs:5000,...progressCounters()});
const progressLine=(v:unknown)=>Buffer.from(JSON.stringify(v)+'\n');
test('actual encoder and closed standalone runner parser agree for every original finite phase',()=>{
 const emit=createH1StageProgressEncoder(),rows=[] as Buffer[];let elapsed=0;
 for(const phase of Object.values(H1StageProgressPhase)){const r=emit(phase,elapsed++,progressCounters());assert(r);assert(stageProgressData(JSON.parse(r.toString())));rows.push(r);}
 const stderr=Buffer.concat(rows);assert.equal(lastStageProgress(stderr)?.phase,H1StageProgressPhase.complete);assert.equal(lastStageProgress(stderr)?.sequence,rows.length);
 const diagnostic=hChild(Buffer.concat([Buffer.from('PRIVATE_CANARY\n'),stderr,Buffer.from('Error: H1_PREPARE_HOLD:cancelled_or_deadline\n')]));assert.equal(diagnostic.knownReason,'cancelled_or_deadline');assert.equal(diagnostic.stageProgress?.phase,H1StageProgressPhase.complete);assert(!JSON.stringify(diagnostic).includes('PRIVATE_CANARY'));
});
test('SIGKILL-style stderr with only completed progress retains exact last phase and aggregate counters',()=>{
 const r=progressRow(),diagnostic=hChild(progressLine(r));assert.equal(diagnostic.knownReason,null);assert.deepEqual(diagnostic.sourceFrames,[]);assert.deepEqual(diagnostic.stageProgress,r);
 assert.equal(cChild(progressLine(r)).knownReason,null); // Other original C transport is unchanged.
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
 const moduleUrl=new URL('./stage-current-h1-public.mts',import.meta.url).href;
 const source="import {createH1StageProgressEncoder,H1StageProgressPhase} from "+JSON.stringify(moduleUrl)+";const emit=createH1StageProgressEncoder();process.stderr.write(emit(H1StageProgressPhase.initial_pins,0,{objects:0,processedObjects:0,processedBytes:0,guardCalls:0}));process.stderr.write(emit(H1StageProgressPhase.tracked_modes,1,{objects:3,processedObjects:7,processedBytes:1024,guardCalls:12}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);";
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{PATH:process.env.PATH??''},timeout:1000,killSignal:'SIGKILL',maxBuffer:65536});
 assert.equal(r.signal,'SIGKILL');assert.equal((r.error as NodeJS.ErrnoException|undefined)?.code,'ETIMEDOUT');
 const diagnostic=hChild(r.stderr);assert.equal(diagnostic.stageProgress?.phase,H1StageProgressPhase.tracked_modes);assert.equal(diagnostic.stageProgress?.processedObjects,7);assert.equal(diagnostic.stageProgress?.processedBytes,1024);assert.equal(diagnostic.knownReason,null);assert.equal(r.stdout.length,0);
});

test('genuine Buffer instance poison accessors are never read by either H1 stderr DATA reader',()=>{
 for(const property of ['length','toString','equals','buffer','byteLength','byteOffset',Symbol.iterator]){
  const row=progressRow(),bytes=progressLine(row);let calls=0;Object.defineProperty(bytes,property,{configurable:true,get(){calls++;throw Error('PRIVATE_CANARY');}});
  assert.deepEqual(lastStageProgress(bytes),row);assert.deepEqual(hChild(bytes).stageProgress,row);assert.equal(calls,0);
 }
});

test('successful child result survives an actual closed diagnostic fd without async stderr errors',()=>{
 const moduleUrl=new URL('./run-current-h1-public.mts',import.meta.url).href;
 const source="import assert from 'node:assert/strict';import * as fs from 'node:fs';import {observeSuccessfulH1StageProgress} from "+JSON.stringify(moduleUrl)+";const result=Buffer.from('ORIGINAL_CHILD_RESULT');fs.closeSync(2);assert.throws(()=>fs.writeSync(2,Buffer.from('x')),e=>e.code==='EBADF');observeSuccessfulH1StageProgress(Buffer.from("+JSON.stringify(JSON.stringify(progressRow())+'\n')+"));process.stdout.write(result);";
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{PATH:process.env.PATH??''},timeout:5000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0);assert.equal(r.stdout.toString(),'ORIGINAL_CHILD_RESULT');assert.equal(r.stderr.length,0);
});

test('Prepare-only fixed QoS joins stager child runner and unit while Finalize stays exact',()=>{
 const prepare=h1PhaseBudget(H1InstallPhase.Prepare),finalize=h1PhaseBudget(H1InstallPhase.Finalize);
 assert.deepEqual(prepare,{childMs:900000,runnerMs:930000,unitRuntime:'16min'});
 assert.equal(STAGE_BUDGET_MS,prepare.childMs);assert.equal(h1UnitRuntime(H1InstallPhase.Prepare),prepare.unitRuntime);
 assert(prepare.childMs<prepare.runnerMs&&prepare.runnerMs<16*60000);
 assert.deepEqual(finalize,{childMs:120000,runnerMs:270000,unitRuntime:'5min'});
 assert.equal(h1UnitRuntime(H1InstallPhase.Finalize),finalize.unitRuntime);assert(finalize.childMs<finalize.runnerMs&&finalize.runnerMs<5*60000);
 assert(Object.isFrozen(prepare)&&Object.isFrozen(finalize));
});
test('installation budgets reject unknown phases without caller or environment override',()=>{
 for(const phase of ['',undefined,null,0,'PREPARE','install','prepare ',{}, {phase:'prepare'}]){assert.throws(()=>h1PhaseBudget(phase));assert.throws(()=>h1UnitRuntime(phase));}
});
