import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parseDelivery,selectedUnit,parseIds,PositiveTransportPhase,positiveTransportPhaseTimeout} from './run-current-positive-public.mts';
import {parseDelivery as parseBootstrap} from './bootstrap-current-positive-public.mts';
import {parseDelivery as parseInspector} from './inspect-current-positive-public.mts';
import {readFileSync} from 'node:fs';
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const names=['preparation-input.json','source.bundle','public-files.payload','stage-current-positive-public.mts','run-current-positive-public.mts','review.json','outer-input.json','public-input.json'];
const fixture=()=>({version:1,sourceSha:'a'.repeat(40),manifestSha256:'b'.repeat(64),reviewSha256:'c'.repeat(64),bootId:'f12bc43a-9252-42d4-919d-85b846a176a8',files:names.map((name,i)=>({name,bytes:100,sha256:i===0?'b'.repeat(64):i===3?'e6117f904e7d1d989165d196e61ac3d7ca36bf1c9c0877f63889e0d92b28acef':i===5?'c'.repeat(64):'d'.repeat(64)}))});
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v));
test('delivery requires exact reviewed bytes and finite original roster',()=>{const b=encode(fixture()),d=parseDelivery(b,digest(b));assert.equal(d.files.length,8);assert.throws(()=>parseDelivery(b,'e'.repeat(64)));for(const mutate of [(v:ReturnType<typeof fixture>)=>v.files[1]!.name='elsewhere.bundle',(v:ReturnType<typeof fixture>)=>v.files[2]!.bytes=1024**3+1,(v:ReturnType<typeof fixture>)=>v.files[5]!.sha256='f'.repeat(64),(v:ReturnType<typeof fixture>)=>v.files[3]!.sha256='f'.repeat(64)]){const v=fixture();mutate(v);const bad=encode(v);assert.throws(()=>parseDelivery(bad,digest(bad)));}});
test('unit identity binds both selected source and manifest without alternate-path input',()=>{const b=encode(fixture()),d=parseDelivery(b,digest(b)),first=selectedUnit(d);assert.match(first,/^subscription-runtime-installer-positive-[a-f0-9]{64}\.service$/);assert.equal(first,selectedUnit(d));assert.notEqual(first,selectedUnit({...d,sourceSha:'e'.repeat(40)}));assert.notEqual(first,selectedUnit({...d,manifestSha256:'e'.repeat(64)}));});
test('recursive-census parser rejects truncated, zero, whitespace and unsafe process ids',()=>{assert.deepEqual(parseIds(''),[]);assert.deepEqual(parseIds('12\n34\n'),[12,34]);for(const bad of ['12','0\n',' 12\n','12\r\n','9007199254740993\n','-1\n','12\n\n'])assert.throws(()=>parseIds(bad));});

test('bootstrap runner and same-attempt inspector retain the actual exact stager pin',()=>{
 const v=fixture(),b=encode(v),pin=digest(b);
 assert.equal(v.files[3]!.sha256,digest(readFileSync(new URL('./stage-current-positive-public.mts',import.meta.url))));
 for(const parse of [parseBootstrap,parseDelivery,parseInspector]){
  assert.deepEqual(parse(b,pin),v);
  const changed=fixture();changed.files[3]!.sha256='f'.repeat(64);const bad=encode(changed);
  assert.throws(()=>parse(bad,digest(bad)),/delivery_join/);
 }
});
test('finite C transport stage budget preserves installer and handoff bounds',()=>{
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Stage,1080000),900000);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Stage,900000),900000);
 assert.throws(()=>positiveTransportPhaseTimeout(PositiveTransportPhase.Stage,899999),/phase_budget/);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Install,180000),120000);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Install,120000),120000);
 assert.throws(()=>positiveTransportPhaseTimeout(PositiveTransportPhase.Install,119999),/phase_budget/);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Handoff,129999.9),120000);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Handoff,60000),60000);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Handoff,1),1);
 for(const invalid of [0,-1,NaN,Infinity])assert.throws(()=>positiveTransportPhaseTimeout(PositiveTransportPhase.Handoff,invalid),/phase_budget/);
 assert.throws(()=>positiveTransportPhaseTimeout('elsewhere' as PositiveTransportPhase,1080000),/phase_budget/);
 const afterStage=1080000-900000,afterInstall=afterStage-120000;
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Install,afterStage),120000);
 assert.equal(positiveTransportPhaseTimeout(PositiveTransportPhase.Handoff,afterInstall),60000);
});
