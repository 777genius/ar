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
