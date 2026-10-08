// Only the external provider protocol is fake. Never discover a default pool.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, chmod, symlink, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Peer } from './codex-seed-publication.e2e.mts';
import type { CodexAppServerProcessFactory } from '../../provider-codex/index.js';
const repository = process.env.SR_SYNTHETIC_RUNTIME_COPY!;
const fixtures = process.env.SR_SYNTHETIC_FIXTURES!;
if (!repository?.includes('/artifacts/') || !fixtures?.includes('/artifacts/fixtures')) throw Error('owned_disposable_only');
const { FileBackendCodexWorker } = await import(pathToFileURL(join(repository,'dist/worker-codex/file-backend-codex-worker.js')).href) as typeof import('../file-backend-codex-worker.js');
const { FileBackendCodexSeedWriteback } = await import(pathToFileURL(join(repository,'dist/worker-codex/file-backend-codex-seed-writeback.js')).href) as typeof import('../file-backend-codex-seed-writeback.js');
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
function assert(v:unknown, message:string):asserts v { if(!v) throw Error(message); }
function auth(refresh:string, last:string|null):string {
  // Runtime-generated fixture identity, never a handwritten credential value.
  const syntheticRefresh = 'NOT-A-CREDENTIAL-' + refresh;
  return JSON.stringify({auth_mode:'chatgpt',...(last?{last_refresh:last}:{}),tokens:{account_id:'NOT-AN-ACCOUNT-REMEDIATION',access_token:'test-fixture-literal',refresh_token:syntheticRefresh,expiry:'2035-01-01T00:00:00Z'}});
}
async function fresh(tag:string) {
  const root = await mkdtemp(join(fixtures,'synthetic-effective-reader-'+tag+'-'));
  await mkdir(join(root,'auth/a'),{recursive:true,mode:0o700});
  const source = join(root,'auth/a/auth.json');
  const s0=auth(randomUUID(),'2026-10-06T19:00:00Z'), r=auth(randomUUID(),'2026-10-06T19:30:00Z');
  await writeFile(source,s0,{mode:0o600}); return {root,source,s0,r};
}
function worker(root:string, action:(p:Peer,home:string,bytes:string)=>Promise<void>, imports:string[]=[], tag='restarted') {
  const factory:CodexAppServerProcessFactory = input => {
    const home=input.env.CODEX_HOME!; assert(home.startsWith(root+'/'),'owned_provider_home');
    return new Peer(home,async(p,h)=>{const bytes=await readFile(join(h,'auth.json'),'utf8'); imports.push(hash(bytes)); await action(p,h,bytes);});
  };
  return new FileBackendCodexWorker({providerInstanceId:'synthetic-'+tag,stateRootDir:join(root,'jobs',tag),encryptionKey:new Uint8Array(32).fill(27),codexBinaryPath:'/SYNTHETIC-NONEXISTENT',model:'gpt-6.1-sol',reasoningEffort:'high',serviceTier:'default',sourceEnv:{SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH:'1'},appServerProcessFactory:factory,clock:{now:()=>new Date('2026-10-06T20:00:00Z'),monotonicMs:()=>performance.now()}});
}
async function restarted(root:string, expected:string) {
  const imports:string[]=[];
  const w=worker(root,async(p,_h,bytes)=>bytes===expected?p.complete():p.invalid(),imports);
  let completed=false;
  try { await w.start(); await w.seedCodexAuthJsonFile(join(root,'auth/a/auth.json')); try {completed=(await w.run({prompt:'Synthetic restart'})).outputText==='SYNTHETIC OK';}catch{} }
  finally{await w.dispose();}
  return {completed,imports};
}
type Facts=Record<string,unknown>;
const cases:{id:string;passed:boolean;facts:Facts;error?:string}[]=[];
async function scenario(id:string, invariant:string, run:(facts:Facts)=>Promise<void>) {
  console.log(JSON.stringify({invariant,test:id})); const facts:Facts={};
  try{await run(facts);cases.push({id,passed:true,facts});}catch(e){cases.push({id,passed:false,facts,error:e instanceof Error?e.message:'unknown'});}
  console.log(JSON.stringify(cases.at(-1)));
}
async function main(){
  // Distinct object and OS process lifecycles, with older and absent metadata.
  for(const lifecycle of ['reused','new-worker','new-process'] as const) for(const absent of [false,true]) {
    await scenario('new-authorization-'+lifecycle+'-'+absent,'Independent source S1 replaces persisted R regardless of source clock; provider accepts only S1',async f=>{
      const {root,source,s0,r}=await fresh('restart'); const s1=auth(randomUUID(),absent?null:'2026-10-06T18:30:00Z');
      let expected=s0; const imports:string[]=[]; let turn=0;
      const first=worker(root,async(p,h,bytes)=>{if(turn++===0){await writeFile(join(h,'auth.json'),r,{mode:0o600});p.complete();}else bytes===expected?p.complete():p.invalid();},imports);
      await first.start(); await first.seedCodexAuthJsonFile(source); assert((await first.run({prompt:'Synthetic rotate'})).outputText==='SYNTHETIC OK','initial_rotation_completed');
      if(lifecycle!=='reused') await first.dispose();
      await writeFile(source,s1,{mode:0o600}); expected=s1;
      let result:{completed:boolean;imports:string[]};
      if(lifecycle==='reused'){let completed=false;try{completed=(await first.run({prompt:'Synthetic owner replacement'})).outputText==='SYNTHETIC OK';}catch{}finally{await first.dispose();}result={completed,imports:imports.slice(1)};}
      else if(lifecycle==='new-worker')result=await restarted(root,s1);
      else {const output=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--restart',root,hash(s1)],{env:{...process.env},timeout:20000});result=JSON.parse(output.stdout) as typeof result;}
      Object.assign(f,{result,expectedHash:hash(s1),staleHash:hash(r),sourceHash:hash(await readFile(source,'utf8'))});
      assert(result.completed&&result.imports[0]===hash(s1),'restart_kept_obsolete_local_authorization');
    });
  }
  await scenario('unchanged-source-restart-retains-usable-rotation','Unchanged S0 must retain provider-rotated R in a new process',async f=>{
    const {root,source,s0,r}=await fresh('unchanged');const first=worker(root,async(p,h)=>{await writeFile(join(h,'auth.json'),r,{mode:0o600});p.complete();});await first.start();await first.seedCodexAuthJsonFile(source);await first.run({prompt:'Synthetic rotation'});await first.dispose();
    // Metadata changes do not constitute a new authorization.
    await writeFile(source,s0+'\n');await writeFile(join(root,'expected.hash'),hash(r));
    const out=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--restart',root,hash(r)],{env:{...process.env},timeout:20000});const result=JSON.parse(out.stdout) as {completed:boolean;imports:string[]};Object.assign(f,{result,expectedHash:hash(r)});assert(result.completed&&result.imports[0]===hash(r),'healthy_rotation_overwritten_on_restart');
  });
  await scenario('unchanged-source-restart-retains-unpublished-local-rotation','Durably bound S0 retains encrypted local R despite publication loss and a future source metadata rewrite; NEW process imports R, never resets from clock alone',async f=>{
    const {root,source,s0,r}=await fresh('local-custody');const loss=join(root,'auth/a/.subscription-runtime-auth-writeback');
    const first=worker(root,async(p,h)=>{await writeFile(join(h,'auth.json'),r,{mode:0o600});await writeFile(loss,'synthetic publication unavailable',{mode:0o600});p.complete();});
    let failed=false;try{await first.start();await first.seedCodexAuthJsonFile(source);try{await first.run({prompt:'Synthetic publication loss'});}catch{failed=true;}}finally{await first.dispose();}
    const files=(await readdir(join(root,'jobs/restarted/sessions'),{withFileTypes:true}))
      .filter(entry=>entry.isFile()).map(entry=>entry.name);
    for(const file of files){const path=join(root,'jobs/restarted/sessions',file);assert(!(await readFile(path,'utf8')).includes('NOT-A-CREDENTIAL-'),'encrypted_source_binding_plaintext');assert(((await stat(path)).mode&0o777)===0o600,'source_binding_record_private');}
    await rm(loss);const metadata=JSON.stringify({...JSON.parse(s0),last_refresh:'2032-01-01',tokens:{...JSON.parse(s0).tokens,access_token:'test-fixture-literal'}})+'\n';await writeFile(source,metadata);
    const out=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--restart',root,hash(r)],{env:{...process.env},timeout:20000});const result=JSON.parse(out.stdout) as {completed:boolean;imports:string[]};
    Object.assign(f,{publicationFailed:failed,result,expectedHash:hash(r),encryptedRecordCount:files.length,recordMode:'0600',sourceHash:hash(await readFile(source,'utf8')),expectedSourceHash:hash(metadata)});
    assert(failed&&result.completed&&result.imports[0]===hash(r)&&await readFile(source,'utf8')===metadata,'metadata_overwrote_bound_rotated_local');
  });
  for(const mode of ['auth-root','codex-home'] as const) await scenario('supported-quota-cli-'+mode,'Existing caller input imports effective R and retains successful probe N through shared encrypted publication, source S0 untouched',async f=>{
    const {root,source,s0,r}=await fresh('cli');const next=auth(randomUUID(),'2026-10-06T19:40:00Z');const custody=new FileBackendCodexSeedWriteback(source);await custody.publishRefresh({source:s0,expected:s0,next:r});
    // Use a separate fake executable whose only authority is its fixture home.
    const binary=join(root,'fake-provider.mts');await copyFile(fileURLToPath(new URL('./codex-remediation-fake-probe.mts',import.meta.url)),binary);await chmod(binary,0o700);await mkdir(join(root,'bin'));await symlink(binary,join(root,'bin/codex'));
    await writeFile(join(root,'accepted.hash'),hash(r));await writeFile(join(root,'next.fixture'),next,{mode:0o600});
    const args=mode==='auth-root'?['--auth-root',join(root,'auth'),'--accounts','a']:['--auth-root',join(root,'auth'),'--codex-home',join(root,'auth/a')];
    const out=await promisify(execFile)(process.execPath,[join(repository,'scripts/ops/codex-account-quota-table.mjs'),...args,'--json','--timeout-ms','3000','--min-launch-interval-ms','0'],{env:{...process.env,HOME:root,PATH:join(root,'bin')+':'+(process.env.PATH??'')},timeout:10000});
    const rows=(JSON.parse(out.stdout) as {rows:{available:boolean;rawStatus:string;reason:string}[]}).rows;const imports=(await readFile(join(root,'imports.jsonl'),'utf8')).trim().split('\n').map(l=>(JSON.parse(l) as {digest:string}).digest);const effectiveHash=hash(await custody.read(s0));
    Object.assign(f,{exitCode:0,rows,imports,expectedHash:hash(r),expectedNextHash:hash(next),effectiveHash,sourceHash:hash(await readFile(source,'utf8')),expectedSourceHash:hash(s0)});
    assert(rows[0]?.available&&imports[0]===hash(r),'supported_quota_cli_still_reads_revoked_login_source');assert(effectiveHash===hash(next),'successful_probe_refresh_lost');assert(await readFile(source,'utf8')===s0,'unsafe_source_overwrite');
  });
  for (const mode of ['auth-root','codex-home'] as const) await scenario('supported-quota-cli-canonical-holds-'+mode,'Canonical invalid S0 survives metadata and available observations; new S1 releases only session invalid and retains account quota hold; no provider spawn while held',async f=>{
    const {root,source,s0}=await fresh('holds');
    const {codexAccountCapacityStore}=await import(pathToFileURL(join(repository,'dist/worker-codex/application/codex-account-capacity-store.js')).href) as typeof import('../application/codex-account-capacity-store.js');
    const store=codexAccountCapacityStore(join(root,'auth'));const now=new Date();
    store.observe({accountId:'a',observedAt:now,capacity:{availability:'disabled',reason:'provider_session_invalid'}});
    store.observe({accountId:'a',observedAt:now,capacity:{availability:'available'}});
    await writeFile(source,s0+'\n');
    const args=mode==='auth-root'?['--auth-root',join(root,'auth'),'--accounts','a']:['--auth-root',join(root,'auth'),'--codex-home',join(root,'auth/a')];
    await mkdir(join(root,'bin'));const binary=join(root,'fake-provider.mts');await copyFile(fileURLToPath(new URL('./codex-remediation-fake-probe.mts',import.meta.url)),binary);await chmod(binary,0o700);await symlink(binary,join(root,'bin/codex'));
    const invoke=async()=>{const out=await promisify(execFile)(process.execPath,[join(repository,'scripts/ops/codex-account-quota-table.mjs'),...args,'--json','--timeout-ms','3000','--min-launch-interval-ms','0'],{env:{...process.env,HOME:root,PATH:join(root,'bin')+':'+(process.env.PATH??'')},timeout:10000});return (JSON.parse(out.stdout) as {rows:{available:boolean;rawStatus:string;reason:string}[]}).rows[0]!;};
    const invalid=await invoke();assert(!invalid.available&&invalid.rawStatus==='relogin_required','cli_cleared_canonical_invalid');
    store.observe({accountId:'a',observedAt:now,capacity:{availability:'quota_exhausted',reason:'quota_limited',cooldownUntil:new Date('2035-01-01')}});
    await writeFile(source,auth(randomUUID(),null));const quota=await invoke();
    const noSpawn=await readFile(join(root,'imports.jsonl')).then(()=>false,()=>true);Object.assign(f,{invalid,quota,noSpawn});
    assert(!quota.available&&quota.reason==='quota_limited'&&noSpawn,'cli_new_authorization_bypassed_quota_hold');
  });
  for(const fault of ['revoked','publication-loss'] as const)await scenario('supported-quota-cli-'+fault,'Probe rejection persists canonical source and effective invalidation; successful rotation with publication failure reports unavailable and retains private 0700/0600 recovery custody without source overwrite',async f=>{
    const {root,source,s0,r}=await fresh('probe-fault');const next=auth(randomUUID(),'2026-10-06T19:40:00Z');
    if(fault==='revoked')await new FileBackendCodexSeedWriteback(source).publishRefresh({source:s0,expected:s0,next:r});
    await mkdir(join(root,'bin'));const binary=join(root,'fake-provider.mts');await copyFile(fileURLToPath(new URL('./codex-remediation-fake-probe.mts',import.meta.url)),binary);await chmod(binary,0o700);await symlink(binary,join(root,'bin/codex'));
    await writeFile(join(root,'accepted.hash'),fault==='revoked'?hash(auth(randomUUID(),null)):hash(s0));await writeFile(join(root,'next.fixture'),next,{mode:0o600});
    if(fault==='publication-loss')await writeFile(join(root,'publication-denial.fixture'),'owned synthetic failure');
    const before=new Set(await readdir(fixtures));
    const out=await promisify(execFile)(process.execPath,[join(repository,'scripts/ops/codex-account-quota-table.mjs'),'--auth-root',join(root,'auth'),'--accounts','a','--json','--timeout-ms','3000','--min-launch-interval-ms','0'],{env:{...process.env,HOME:root,PATH:join(root,'bin')+':'+(process.env.PATH??'')},timeout:10000});
    const row=(JSON.parse(out.stdout) as {rows:{available:boolean;rawStatus:string;reason:string}[]}).rows[0]!;assert(!row.available,'failed_probe_falsely_available');assert(await readFile(source,'utf8')===s0,'probe_overwrote_source');
    if(fault==='revoked'){
      const {codexAccountCapacityStore}=await import(pathToFileURL(join(repository,'dist/worker-codex/application/codex-account-capacity-store.js')).href) as typeof import('../application/codex-account-capacity-store.js');
      const {codexSessionCapacityAccountId}=await import(pathToFileURL(join(repository,'dist/worker-codex/codex-session-capacity-identity.js')).href) as typeof import('../codex-session-capacity-identity.js');
      const store=codexAccountCapacityStore(join(root,'auth'));const sourceState=store.read({accountId:'a',demand:{provider:'codex',model:'gpt-5.6-sol'},now:new Date('2035-01-01')}),actual=store.read({accountId:codexSessionCapacityAccountId(JSON.parse(r))!,now:new Date('2035-01-01')});
      Object.assign(f,{row,sourceReason:sourceState?.reason??null,actualReason:actual?.reason??null});assert(sourceState?.reason==='provider_session_invalid'&&actual?.reason==='provider_session_invalid','quota_probe_lost_shared_invalid_lineage');
    }else{
      const recovery=(await readdir(fixtures)).filter(name=>!before.has(name)&&name.startsWith('subscription-runtime-codex-effective-'));assert(recovery.length===1,'probe_refresh_recovery_home_lost');const home=join(fixtures,recovery[0]!),bytes=await readFile(join(home,'auth.json'),'utf8');const homeMode=(await stat(home)).mode&0o777,recordMode=(await stat(join(home,'auth.json'))).mode&0o777;
      Object.assign(f,{row,recoveryHash:hash(bytes),expectedHash:hash(next),homeMode:'0'+homeMode.toString(8),recordMode:'0'+recordMode.toString(8),encryptedPublicationSucceeded:false});assert(bytes===next&&homeMode===0o700&&recordMode===0o600,'probe_refresh_recovery_privacy_or_custody_lost');
    }
  });
  await writeFile(join(dirname(repository),(process.env.SR_SYNTHETIC_PHASE??'remediation')+'-cases.json'),JSON.stringify(cases,null,2)+'\n');process.exitCode=cases.some(c=>!c.passed)?1:0;
}
export { worker, fresh, auth, hash, assert, restarted };
if(process.argv[1] === fileURLToPath(import.meta.url)) {
if(process.argv[2]==='--restart'){
  const root=process.argv[3]!,expectedHash=process.argv[4]!;assert(root.startsWith(fixtures+'/synthetic-effective-reader-'),'owned_restart_fixture');
  const imports:string[]=[];const w=worker(root,async(p,_h,b)=>hash(b)===expectedHash?p.complete():p.invalid(),imports);let completed=false;
  try{await w.start();await w.seedCodexAuthJsonFile(join(root,'auth/a/auth.json'));try{completed=(await w.run({prompt:'Synthetic new process'})).outputText==='SYNTHETIC OK';}catch{}console.log(JSON.stringify({completed,imports}));}finally{await w.dispose();}
}else await main();
}
