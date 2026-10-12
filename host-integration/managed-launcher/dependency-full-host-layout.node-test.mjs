import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const source=process.env.HOST_LAYOUT_SOURCE_ROOT,emitted=process.env.HOST_LAYOUT_EMITTED_ROOT;
assert.ok(source&&emitted,'actual complete strict emission and source roots required');
const oldSource=process.env.HOST_LAYOUT_OLD_SOURCE_ROOT,oldEmitted=process.env.HOST_LAYOUT_OLD_EMITTED_ROOT;
assert.equal(Boolean(oldSource),Boolean(oldEmitted),'old control needs both real frozen roots');
const native=readFileSync(join(oldSource||source,'host-integration/managed-launcher/dependency-full-native-TEST.ts'),'utf8');
// The copied layout derives from the private production literal, not a parallel
// test list. No public mutable mapping becomes installation authority.
function productionRows(text){
 const literal=/const fullPositiveTestCohort = Object\.freeze\(\[([\s\S]*?)\] as const\);/.exec(text);assert.ok(literal);
 return literal[1].split('\n').map(row=>row.trim()).filter(row=>row&&!row.startsWith('//')).map(row=>{
  const match=/^\["([^"]+)", "([^"]+)"\],$/.exec(row);assert.ok(match,row);return [match[1],match[2]];
 });
}
function install(text){
 const root=mkdtempSync(join(tmpdir(),'TEST-full-host-layout-'));
 writeFileSync(join(root,'package.json'),'{"type":"module"}\n');
 for(const [selected,target] of productionRows(text)){
  const candidate=selected.startsWith('dist/')||selected.startsWith('host-integration/')?selected:'host-integration/'+selected;
  const build=oldEmitted&&['dependency-full-native-TEST.js','dependency-full-provider-setup-TEST.js'].some(name=>candidate.endsWith('/'+name))?oldEmitted:emitted;
  const original=candidate.startsWith('dist/')?join(build,candidate):candidate.endsWith('.js')||candidate.endsWith('/hosted-host-policy.mjs')?join(build,candidate):join(source,candidate);
  if(!existsSync(original)){assert.ok(['host-integration/managed-launcher/full-positive-test-profile.mjs','host-integration/managed-launcher/launch-full-positive-TEST.mjs','host-integration/host-jobs/full-positive-manager-TEST.mjs'].includes(candidate),'actual emitted/source leaf '+candidate);continue;}const destination=join(root,target);mkdirSync(dirname(destination),{recursive:true});copyFileSync(original,destination);
  assert.deepEqual(readFileSync(destination),readFileSync(original),'same canonical copied bytes');
 }
 return root;
}
function staticClosure(root,entry){
 const seen=new Set();function visit(path){assert.ok(path.startsWith(root+'/'),'installed import escapes cohort '+relative(root,path));assert.ok(existsSync(path),'missing installed dependency '+relative(root,path));if(seen.has(path))return;seen.add(path);
  const code=readFileSync(path,'utf8'),imports=[...code.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)].map(row=>row[1]);
  for(const specifier of imports){if(specifier.startsWith('node:'))continue;assert.ok(specifier.startsWith('./')||specifier.startsWith('../'),'unexpected external import '+specifier);visit(resolve(dirname(path),specifier));}
 }visit(join(root,entry));return seen;
}
test('original copied HOST static module graph loads with canonical lifecycle leaves',()=>{
 const root=install(native);try{const graph=staticClosure(root,'managed-launcher/dependency-full-native-TEST.mjs');assert.ok(graph.has(join(root,'managed-launcher/hosted-fd-unit-lifecycle.js')));assert.ok(graph.has(join(root,'managed-launcher/hosted-fd-unit-policy.js')));
  const child=spawnSync(process.execPath,['--input-type=module','-e','const m=await import('+JSON.stringify(pathToFileURL(join(root,'managed-launcher/dependency-full-native-TEST.mjs')).href)+'); if(typeof m.retainCurrentFullParent!=="function")throw Error("entry missing");'],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.equal(child.signal,null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('checkpoint5 relative HOST imports fail in actual copied layout',()=>{
 const root=install(native);try{const path=join(root,'managed-launcher/dependency-full-provider-setup-TEST.js');writeFileSync(path,readFileSync(path,'utf8').replaceAll('./hosted-fd-unit-lifecycle.js','../../src/provider-codex/app-server/adapters/hosted-fd-unit-lifecycle.js').replaceAll('./hosted-fd-unit-policy.js','../../src/provider-codex/app-server/adapters/hosted-fd-unit-policy.js'));
 assert.throws(()=>staticClosure(root,'managed-launcher/dependency-full-native-TEST.mjs'),/escapes cohort/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('omitted canonical lifecycle or policy copied leaf refuses before module execution',()=>{
 for(const name of ['hosted-fd-unit-lifecycle','hosted-fd-unit-policy']){const root=install(native);try{rmSync(join(root,'managed-launcher/'+name+'.js'));assert.throws(()=>staticClosure(root,'managed-launcher/dependency-full-native-TEST.mjs'),/missing installed dependency/);}finally{rmSync(root,{recursive:true,force:true});}}
});
