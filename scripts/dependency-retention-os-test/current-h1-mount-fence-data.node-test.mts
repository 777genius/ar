/** Actual private closure slices, with explicitly projected kernel DATA on Darwin.
 * These tests do not execute the stager, a privileged mount or native H1. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {assertRegularName} from './stage-current-positive-public.mts';
import {createH1ExactMountBoundaryValidator,INTAKE} from './stage-current-h1-public.mts';
const here=dirname(fileURLToPath(import.meta.url));
const candidate=fs.readFileSync(join(here,'stage-current-h1-public.mts'),'utf8'),before=" const baseGuard=()=>{hold(!cancelled&&performance.now()<deadline,\"cancelled_or_deadline\");hold(boot===fs.readFileSync(\"/proc/sys/kernel/random/boot_id\",\"utf8\")&&namespace===fs.readlinkSync(\"/proc/self/ns/mnt\"),\"boot_namespace_changed\");validateMountInfo(fs.readFileSync(\"/proc/self/mountinfo\",\"utf8\"));};\n"; // Exact f059 regression control; not a runtime implementation.
const hold=(ok:unknown,why:string):asserts ok=>{assert(ok,why);};
function line(source:string,start:string):string{const lines=source.split('\n').filter(l=>l.trimStart().startsWith(start));assert.equal(lines.length,1);return lines[0]!;}
function closure(source:string,variable:string,context:Record<string,unknown>):(...args:unknown[])=>unknown {
 return runInNewContext(stripTypeScriptTypes('(()=>{'+source+';return '+variable+';})()',{mode:'strip'}),context) as (...args:unknown[])=>unknown;
}
function base(source:string){let reads=0,bootReads=0,nsReads=0;const context={cancelled:false,deadline:900000,performance:{now:()=>1},boot:'actual-boot-data',namespace:'actual-ns-data',hold,validateMountInfo:createH1ExactMountBoundaryValidator(),fs:{readFileSync:(path:string)=>{if(path==='/proc/self/mountinfo'){reads++;return '1 0 0:1 / / rw - ext4 /dev/TEST rw\n';}assert.equal(path,'/proc/sys/kernel/random/boot_id');bootReads++;return 'actual-boot-data';},readlinkSync:(path:string)=>{assert.equal(path,'/proc/self/ns/mnt');nsReads++;return 'actual-ns-data';}}};const run=closure(line(source,'const baseGuard='),'baseGuard',context);return {run,context,counts:()=>({reads,bootReads,nsReads})};}
test('actual scoped base removes only full-table generation while boot/ns/deadline/cancel remain fresh DATA',()=>{
 const old=base(before),current=base(candidate);for(let i=0;i<100;i++){old.run();current.run();}assert.deepEqual(old.counts(),{reads:100,bootReads:100,nsReads:100});assert.deepEqual(current.counts(),{reads:0,bootReads:100,nsReads:100});
 current.context.cancelled=true;assert.throws(()=>current.run(),/cancelled_or_deadline/);current.context.cancelled=false;current.context.deadline=0;assert.throws(()=>current.run(),/cancelled_or_deadline/);
});
test('actual phase transition calls unchanged full fence and refuses unknown persistent intake mount before publication DATA',()=>{
 let table='1 0 0:1 / / rw - ext4 /dev/TEST rw\n',reads=0,progress=0;const context={guardCalls:0,cancelled:false,deadline:900000,performance:{now:()=>1},boot:'boot',namespace:'ns',anchors:[],sources:[],activeTarget:undefined,check:()=>assert.fail('no selected FD fixture'),hold,Set,progress:()=>{progress++;},validateMountInfo:createH1ExactMountBoundaryValidator(),progressPhase:'initial',fs:{readFileSync:(path:string)=>{if(path==='/proc/self/mountinfo'){reads++;return table;}assert.equal(path,'/proc/sys/kernel/random/boot_id');return 'boot';},readlinkSync:()=> 'ns'}};
 const guard=closure(line(candidate,'const guard='),'guard',context);Object.assign(context,{guard});
 const marker='const setProgress=',start=candidate.indexOf(marker),end=candidate.indexOf(';progress();const signal',start);assert(start>=0&&end>start);const set=closure(candidate.slice(start,end)+';','setProgress',context);
 set('tracked_census');assert.equal(reads,1);assert.equal(context.progressPhase,'tracked_census');table+='2 1 0:1 / '+INTAKE+'/future rw - ext4 /dev/TEST rw\n';assert.throws(()=>set('staging_receipt'),/intake_mount_boundary/);assert.equal(context.progressPhase,'tracked_census');assert.equal(reads,2);assert(progress>0);
});
function outputGuard(mount:(fd:number)=>string){const start=candidate.indexOf(' const guardOutput='),end=candidate.indexOf('\n const writeRecord=',start);assert(start>=0&&end>start);return closure(candidate.slice(start,end),'guardOutput',{fs,C:fs.constants,hold,mount,assertRegularName});}
function withFile(run:(path:string,fd:number,root:string)=>void){const root=fs.mkdtempSync(join(os.tmpdir(),'TEST-H1-output-mount-')),path=join(root,'output');fs.writeFileSync(path,'PUBLIC',{mode:0o600});const fd=fs.openSync(path,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{run(path,fd,root);}finally{fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true});}}
test('actual private output guard accepts unchanged real FD/name with projected same mount facts',()=>withFile((path,fd)=>{const guard=outputGuard(()=> '1');guard(fd,path,{dev:fs.fstatSync(fd,{bigint:true}).dev,mnt:'1'});assert.equal(fs.readFileSync(path,'utf8'),'PUBLIC');}));
test('same-inode output bind projection is refused by actual reopened mnt join before write DATA',()=>withFile((path,fd)=>{assertRegularName(fd,path);const guard=outputGuard(current=>current===fd?'1':'2');let wrote=false;assert.throws(()=>{guard(fd,path,{dev:fs.fstatSync(fd,{bigint:true}).dev,mnt:'1'});wrote=true;fs.writeSync(fd,'UNSAFE');},/reopened_mount/);assert.equal(wrote,false);assert.equal(fs.readFileSync(path,'utf8'),'PUBLIC');}));
test('actual output FD mount mismatch and real name replacement refuse before write',()=>withFile((path,fd,root)=>{const guard=outputGuard(()=> '2'),parent={dev:fs.fstatSync(fd,{bigint:true}).dev,mnt:'1'};assert.throws(()=>guard(fd,path,parent),/nested_mount/);fs.renameSync(path,join(root,'original'));fs.writeFileSync(path,'REPLACEMENT');assert.throws(()=>outputGuard(()=> '1')(fd,path,parent),/regular_name_substitution/);assert.equal(fs.readFileSync(path,'utf8'),'REPLACEMENT');}));
test('all three original notHeld output paths use private mount join; records retain full guard DATA',()=>{
 assert.match(candidate,/const recordGuard=\(\)=>\{guard\(\);scopedGuard\(parent\);guardOutput\(fd,path,parent\);\}/);
 for(const marker of ['const frameGuard=','const toolFrameGuard='])assert.match(line(candidate,marker),/guardOutput\(output,outputName,outputParent\)/);
 assert.equal(candidate.includes('export function guardOutput'),false);
});
