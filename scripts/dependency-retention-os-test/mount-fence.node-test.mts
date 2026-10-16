/** Exact candidate lexical guards against real Linux private-namespace mounts.
 * All source/target objects belong to a new TEST fixture; no intake is read.
 * The fixed production INTAKE is a private lexical fixture binding only here. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {assertRegularName} from './stage-current-positive-public.mts';
const input=fs.readFileSync(new URL('./stage-current-positive-public.mts',import.meta.url),'utf8');
const ast=ts.createSourceFile('candidate.mts',input,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),expressions=new Map<string,string>();let validator:string|undefined;
function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name?.text==='createCExactMountBoundaryValidator')validator=n.getText(ast).replace(/^export /,'');if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer&&['check','open','baseGuard','guard','scopedGuard','guardOutput','setProgress'].includes(n.name.text))expressions.set(n.name.text,n.initializer.getText(ast));ts.forEachChild(n,visit);}visit(ast);
assert.equal(expressions.size,7);
assert(validator);
const validatorJs=ts.transpileModule(validator,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const definitions=[...expressions].map(([n,e])=>'const '+n+'='+e+';').join('\n');
const js=ts.transpileModule(definitions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const self=fileURLToPath(import.meta.url),C=fs.constants;
function runCase(which:string){
 assert.equal(process.platform,'linux');assert.equal(process.getuid!(),0);
 const originalNamespace=process.env.TEST_PARENT_MOUNT_NAMESPACE;assert(originalNamespace);assert.notEqual(fs.readlinkSync('/proc/self/ns/mnt'),originalNamespace);
 function command(args:string[]){const r=spawnSync('/usr/bin/mount',args,{encoding:'utf8',timeout:5000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);}
 command(['--make-rprivate','/']);
 const temporary=fs.mkdtempSync('/usr/local/lib/TEST-C-mount-fence-');fs.chmodSync(temporary,0o700);
 let workersFixture:string|undefined,createdWorkersParent=false;
 const INTAKE=temporary+'/intake';fs.mkdirSync(INTAKE,{mode:0o700});
 const createCExactMountBoundaryValidator=new Function('INTAKE','hold','Buffer',validatorJs+';return createCExactMountBoundaryValidator;')(INTAKE,(v:unknown,w:string)=>assert(v,w),Buffer) as ()=>((text:string)=>void);
 type H={fd:number;name:string;real:string;directory:boolean;dev:bigint;ino:bigint;mode:bigint;mnt:string;size:bigint;ctime:bigint;mtime:bigint;live:boolean;parentHeld:H|undefined};
 const handles:H[]=[],anchors:H[]=[],sources:H[]=[];let workers:H|undefined;
 const mount=(fd:number)=>{const m=/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'));assert(m);return m[1]!;};
 const fdPath=(h:H)=>'/proc/self/fd/'+h.fd;
 const hold=(v:unknown,w:string)=>assert(v,w);
 const maker=new Function('fs','hold','C','mount','fdPath','assertRegularName','createCExactMountBoundaryValidator','INTAKE','handles','anchors','sources','getWorkers','payload','outputParent','output','outputPath',
  `const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8'),namespace=fs.readlinkSync('/proc/self/ns/mnt'),cancelled=false,deadline=Infinity;let guardCalls=0,progressPhase;const progress=()=>{},activeTarget=undefined;const validateMountInfo=createCExactMountBoundaryValidator();${js.replaceAll('if (workers &&','if (getWorkers() &&').replaceAll('workers.dev','getWorkers().dev').replaceAll('workers.mnt','getWorkers().mnt')}return {check,open,guard,scopedGuard,guardOutput,setProgress};`);
 const helper=(payload?:H,outputParent?:H,output?:number,outputPath?:string)=>maker(fs,hold,C,mount,fdPath,assertRegularName,createCExactMountBoundaryValidator,INTAKE,handles,anchors,sources,()=>workers,payload,outputParent,output,outputPath) as {check:(h:H)=>void;open:(n:string,d:boolean)=>H;guard:()=>void;scopedGuard:(...h:H[])=>void;guardOutput:()=>void;setProgress:(p:string)=>void};
 let helpers=helper();
 function path(name:string,directory:boolean):H{let h:H=handles.find(h=>h.name==='/'&&h.directory)??helpers.open('/',true);const parts=name.split('/').slice(1);for(const [index,part] of parts.entries()){const p:string=fdPath(h)+'/'+part;const next:H=handles.find(x=>x.name===p&&x.directory)??helpers.open(p,directory||index<parts.length-1);h=next;}return h;}
 const source=INTAKE+'/source';fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(INTAKE+'/toolchain',{mode:0o700});
 const sourceHeld=path(source,true);
 anchors.push(sourceHeld);helpers.guard();
 const mountTargets:string[]=[];
 const bind=(from:string,to:string)=>{command(['--bind',from,to]);mountTargets.push(to);};
 try{
  if(which==='ancestor'){
   bind(source,source);assert.throws(()=>helpers.scopedGuard(sourceHeld),/reopened_mount/);
  }else if(which==='output_same_inode'){
   const outputPath=temporary+'/output';fs.writeFileSync(outputPath,'owned DATA',{mode:0o600});const output=fs.openSync(outputPath,C.O_RDWR|C.O_NOFOLLOW);
   const outputParent=path(temporary,true);
   helpers=helper(sourceHeld,outputParent,output,fdPath(outputParent)+'/output');
   try{helpers.guardOutput();const before=fs.fstatSync(output,{bigint:true});bind(outputPath,outputPath);assert.equal(fs.statSync(outputPath,{bigint:true}).ino,before.ino);assertRegularName(output,fdPath(outputParent)+'/output');assert.throws(()=>helpers.guardOutput(),/reopened_mount/);}finally{fs.closeSync(output);}
  }else if(which==='persistent_descendant'){
   const target=INTAKE+'/toolchain';assert(fs.statSync(target).isDirectory());bind(source,target);assert.throws(()=>helpers.setProgress('catalog'),/intake_mount_boundary/);
  }else if(which==='new_foreign_mount'){
   assert.equal(process.env.GITHUB_ACTIONS,'true','this /srv/workers fixture is CI ephemeral only');
   try{fs.mkdirSync('/srv/workers',{mode:0o700});createdWorkersParent=true;}catch(e){assert.equal((e as NodeJS.ErrnoException).code,'EEXIST');}
   workersFixture=fs.mkdtempSync('/srv/workers/TEST-C-mount-fence-');fs.chmodSync(workersFixture,0o700);
   workers=path('/srv/workers',true);const parent=path(workersFixture,true),target=workersFixture+'/new-child';fs.mkdirSync(target,{mode:0o700});
   const before=fs.statSync(target,{bigint:true});assert.equal(before.dev,workers.dev);bind(target,target);
   const after=fs.statSync(target,{bigint:true});assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
   assert.throws(()=>helpers.open(fdPath(parent)+'/new-child',true),/nested_mount/);
  }else if(which==='unrelated_allowance'){
   const target=temporary+'/other';fs.mkdirSync(target,{mode:0o700});bind(target,target);helpers.scopedGuard(sourceHeld);helpers.setProgress('catalog');
  }else assert.fail('unknown test case');
  console.log(JSON.stringify({case:which,actualPrivateNamespace:true,fixtureOnly:true,originalInputDiskWrites:false,nativeQualified:false}));
 }finally{
  for(const h of handles.reverse())fs.closeSync(h.fd);
  for(const target of mountTargets.reverse()){const r=spawnSync('/usr/bin/umount',[target],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);}
  if(workersFixture)fs.rmSync(workersFixture,{recursive:true,force:true});
  if(createdWorkersParent)try{fs.rmdirSync('/srv/workers');}catch(e){assert.equal((e as NodeJS.ErrnoException).code,'ENOTEMPTY');}
  fs.rmSync(temporary,{recursive:true,force:true});
 }
}
if(process.argv[2]==='--mount-child'){runCase(process.argv[3]!);}else{
 for(const name of ['ancestor','output_same_inode','persistent_descendant','new_foreign_mount','unrelated_allowance'])test('real private mount: '+name,{skip:process.platform!=='linux'||process.getuid?.()!==0||name==='new_foreign_mount'&&process.env.GITHUB_ACTIONS!=='true'},t=>{
  const r=spawnSync('/usr/bin/unshare',['--mount','--fork',process.execPath,self,'--mount-child',name],{encoding:'utf8',timeout:20000,maxBuffer:1024**2,env:{...process.env,TEST_PARENT_MOUNT_NAMESPACE:fs.readlinkSync('/proc/self/ns/mnt')}});
  if(r.status!==0&&/^unshare: unshare failed: Operation not permitted\s*$/.test(r.stderr)){t.skip('existing ROOT CI capabilities refuse private mount namespace; NOT qualified');return;}
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim()).case,name);
 });
}
