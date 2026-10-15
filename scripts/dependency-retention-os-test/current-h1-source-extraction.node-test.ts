import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {H1SemanticFamily,H1SemanticInputState,H1SourceObjectKind,readH1UbuntuPatchSeries,selectH1SemanticInputs,type H1SourceObject} from "./current-h1-source-semantics-TEST.ts";
import {censusH1PatchedSource,H1SourceCensusProfile} from "./current-h1-source-extraction-child-TEST.ts";
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex"),noop=()=>{};
test("Ubuntu quilt commitment requires exact vendor order and every original patch",()=>{
 const files=new Map<string,Buffer>([["debian/patches/ubuntu.series",Buffer.from("second.patch\nfirst.patch -p1\n")],["debian/patches/series",Buffer.from("foreign.patch\n")],["debian/patches/second.patch",Buffer.from("TEST second")],["debian/patches/first.patch",Buffer.from("TEST first")],[".pc/applied-patches",Buffer.from("second.patch\nfirst.patch\n")]]),read=(p:string)=>{assert.notEqual(p,"debian/patches/series","unused vendor fallback alias must not be read");return files.get(p);};
 const result=readH1UbuntuPatchSeries(read);assert.equal(result.path,"debian/patches/ubuntu.series");assert.deepEqual(result.patches.map(p=>p.path),["debian/patches/second.patch","debian/patches/first.patch"]);
 files.set(".pc/applied-patches",Buffer.from("first.patch\nsecond.patch\n"));assert.throws(()=>readH1UbuntuPatchSeries(read));files.set(".pc/applied-patches",Buffer.from("second.patch\nfirst.patch\n"));files.delete("debian/patches/second.patch");assert.throws(()=>readH1UbuntuPatchSeries(read));
});
test("quilt path escapes duplicate entries and unsupported options hold",()=>{
 for(const body of ["../outside\n","/outside\n","same\nsame\n","patch -p0\n","patch --shell=outside\n"]){const files=new Map([["debian/patches/series",Buffer.from(body)]]);assert.throws(()=>readH1UbuntuPatchSeries(p=>files.get(p)));}
});
test("selected source retains full bytes and reports absent generated inputs without a compile claim",()=>{
 const body=Buffer.from("TEST full getpath source\n"),row:H1SourceObject={path:"Modules/getpath.py",kind:H1SourceObjectKind.File,mode:0o644,bytes:body.length,sha256:sha(body),target:""};
 const value=selectH1SemanticInputs(H1SemanticFamily.Python,[row],()=>body,noop);assert.equal(value.compiledInputEquality,false);assert.equal(value.nativeQualified,false);assert(value.inputs.some(r=>r.path===row.path&&r.state===H1SemanticInputState.Present&&"bodyBase64" in r&&r.bodyBase64===body.toString("base64")));assert(value.generated.some(r=>r.path==="pyconfig.h"&&r.state===H1SemanticInputState.Absent));
 assert.throws(()=>selectH1SemanticInputs(H1SemanticFamily.Python,[row],()=>Buffer.from("substituted"),noop));assert.throws(()=>selectH1SemanticInputs(H1SemanticFamily.Python,[row],()=>body,()=>{throw Error("TEST expired");}),/expired/);
});
test("semantic aliases cannot stand in for retained source definitions",()=>{const row:H1SourceObject={path:"Modules/getpath.py",kind:H1SourceObjectKind.Alias,mode:0o777,bytes:5,sha256:sha("other"),target:"other"};assert.throws(()=>selectH1SemanticInputs(H1SemanticFamily.Python,[row],()=>{throw Error("must not read alias");},noop),/regular/);});
const rootLinux=process.platform==="linux"&&process.getuid?.()===0;
test("ROOT complete source census refuses external aliases hardlinks",{skip:!rootLinux},()=>{
 const parent=fs.mkdtempSync(join(tmpdir(),"TEST-H1-patched-source-")),root=join(parent,"root");fs.mkdirSync(root);try{
  fs.writeFileSync(join(root,"file"),"TEST original");assert.equal(censusH1PatchedSource(root,noop).rows.length,1);
  fs.symlinkSync("file",join(root,"valid"));assert.equal(censusH1PatchedSource(root,noop).rows.length,2);fs.unlinkSync(join(root,"valid"));
  fs.symlinkSync("../outside",join(root,"escape"));assert.throws(()=>censusH1PatchedSource(root,noop));fs.unlinkSync(join(root,"escape"));
  fs.linkSync(join(root,"file"),join(root,"hardlink"));assert.throws(()=>censusH1PatchedSource(root,noop));assert.equal(censusH1PatchedSource(root,noop,H1SourceCensusProfile.ToolImage).rows.length,2);fs.unlinkSync(join(root,"hardlink"));
  fs.symlinkSync("/outside",join(root,"absolute"));assert.throws(()=>censusH1PatchedSource(root,noop));fs.unlinkSync(join(root,"absolute"));
  fs.symlinkSync("missing",join(root,"dangling"));assert.throws(()=>censusH1PatchedSource(root,noop));fs.unlinkSync(join(root,"dangling"));
  fs.mkdirSync(join(root,"dir"));fs.writeFileSync(join(parent,"outside"),"TEST outside sentinel");fs.symlinkSync(".",join(root,"dir/up"));fs.symlinkSync("up/../../outside",join(root,"dir/escape"));assert.throws(()=>censusH1PatchedSource(root,noop),/outside/);assert.equal(fs.readFileSync(join(parent,"outside"),"utf8"),"TEST outside sentinel");fs.unlinkSync(join(root,"dir/escape"));
  fs.symlinkSync("cycle-b",join(root,"cycle-a"));fs.symlinkSync("cycle-a",join(root,"cycle-b"));assert.throws(()=>censusH1PatchedSource(root,noop));fs.unlinkSync(join(root,"cycle-a"));fs.unlinkSync(join(root,"cycle-b"));
  // Exact standard dpkg-source vendor-series layout remains accepted by the
  // complete physical census, while the lazy selector avoids reading its alias.
  fs.mkdirSync(join(root,"debian"));fs.mkdirSync(join(root,"debian/patches"));fs.writeFileSync(join(root,"debian/patches/ubuntu.series"),"# no patches\n");fs.symlinkSync("ubuntu.series",join(root,"debian/patches/series"));const inventory=censusH1PatchedSource(root,noop);assert(inventory.rows.some(row=>row.path==="debian/patches/series"&&row.kind===H1SourceObjectKind.Alias));
 }finally{fs.rmSync(parent,{recursive:true});}
});
test("ROOT source census propagates post-read expiry without a partial result",{skip:!rootLinux},context=>{
 const root=fs.mkdtempSync(join(tmpdir(),"TEST-H1-patched-expiry-")),read=fs.readSync;try{fs.writeFileSync(join(root,"file"),"TEST original");let expired=false;context.mock.method(fs,"readSync",(...args:Parameters<typeof fs.readSync>)=>{const n=Reflect.apply(read,fs,args) as number;expired=true;return n;});syncBuiltinESMExports();
 // Named ESM fs imports are synchronized only for this owned test, then restored.
 assert.throws(()=>censusH1PatchedSource(root,()=>{if(expired)throw Error("TEST expired");}));
 }finally{context.mock.restoreAll();syncBuiltinESMExports();fs.rmSync(root,{recursive:true});}
});
