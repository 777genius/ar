import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {join} from 'node:path';
import {rejoinH1ActiveChains,createH1ExactMountBoundaryValidator,INTAKE} from './stage-current-h1-public.mts';
type Held={parentHeld:Held|undefined;live:boolean;fd:number;name:string;directory:boolean;identity:string};
const identity=(s:fs.BigIntStats,directory:boolean)=>[s.dev,s.ino,s.mode,s.uid,s.gid,...(directory?[]:[s.nlink,s.size,s.mtimeNs,s.ctimeNs])].join(':');
function fixture(run:(v:{root:string;ancestor:string;file:string;leaf:Held;unrelated:Held;all:Held[];check:(h:Held)=>void})=>void){
 const root=fs.mkdtempSync(join(os.tmpdir(),'TEST-h1-scoped-'));const ancestor=join(root,'ancestor'),file=join(ancestor,'public.txt');fs.mkdirSync(ancestor);fs.writeFileSync(file,'PUBLIC');fs.writeFileSync(join(root,'unrelated.txt'),'UNRELATED');const all:Held[]=[];
 const hold=(name:string,directory:boolean,parentHeld:Held|undefined):Held=>{const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const h={name,fd,directory,parentHeld,live:true,identity:identity(fs.fstatSync(fd,{bigint:true}),directory)};all.push(h);return h;};
 const r=hold(root,true,undefined),a=hold(ancestor,true,r),leaf=hold(file,false,a),unrelated=hold(join(root,'unrelated.txt'),false,r);
 const check=(h:Held)=>{assert(h.live);assert.equal(identity(fs.fstatSync(h.fd,{bigint:true}),h.directory),h.identity);assert.equal(identity(fs.lstatSync(h.name,{bigint:true}),h.directory),h.identity);};
 try{run({root,ancestor,file,leaf,unrelated,all,check});}finally{for(const h of all.reverse()){h.live=false;fs.closeSync(h.fd);}fs.rmSync(root,{recursive:true,force:true});}
}
test('active FD remains readable while unrelated held drift is deferred only until the full fence',()=>fixture(({leaf,unrelated,all,check})=>{
 fs.chmodSync(unrelated.name,0o600);rejoinH1ActiveChains([leaf],check,()=>{});const b=Buffer.alloc(6);assert.equal(fs.readSync(leaf.fd,b,0,6,0),6);rejoinH1ActiveChains([leaf],check,()=>{});assert.equal(b.toString(),'PUBLIC');assert.throws(()=>{for(const h of all)check(h);});
}));
test('relevant leaf name replacement is refused before any output write',()=>fixture(({file,leaf,check})=>{
 fs.renameSync(file,file+'.old');fs.writeFileSync(file,'REPLACEMENT');let written=false;assert.throws(()=>{rejoinH1ActiveChains([leaf],check,()=>{});written=true;fs.writeFileSync(file,'UNSAFE');});assert.equal(written,false);assert.equal(fs.readFileSync(file,'utf8'),'REPLACEMENT');
}));
test('actual ancestor replacement and closed ancestry are refused before write',()=>fixture(({ancestor,leaf,check})=>{
 fs.renameSync(ancestor,ancestor+'.old');fs.mkdirSync(ancestor);let written=false;assert.throws(()=>{rejoinH1ActiveChains([leaf],check,()=>{});written=true;});assert.equal(written,false);
 leaf.parentHeld!.live=false;assert.throws(()=>rejoinH1ActiveChains([leaf],()=>{},()=>{}),/active_parent_chain/);leaf.parentHeld!.live=true;
}));
test('every scoped call invokes fresh mount, cancellation and deadline checks including after success',()=>fixture(({leaf,check})=>{
 const validate=createH1ExactMountBoundaryValidator();const safe='1 0 0:1 / / rw - ext4 /dev/TEST rw\n';let mount=safe,cancelled=false,expired=false,reads=0;
 const base=()=>{reads++;assert(!cancelled,'cancelled');assert(!expired,'deadline');validate(mount);};
 rejoinH1ActiveChains([leaf],check,base);mount=safe+'2 1 0:1 / '+INTAKE+'/source rw - ext4 /dev/TEST rw\n';assert.throws(()=>rejoinH1ActiveChains([leaf],check,base),/intake_mount_boundary/);mount=safe;
 cancelled=true;assert.throws(()=>rejoinH1ActiveChains([leaf],check,base),/cancelled/);cancelled=false;expired=true;assert.throws(()=>rejoinH1ActiveChains([leaf],check,base),/deadline/);assert.equal(reads,4);
}));
