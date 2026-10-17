/** Original owned ROOT assembly publication, before boot/producer birth.
* This fixed TEST profile is not an administrative actor/role registry. */
import assert from "node:assert/strict";
import {
  createHash
}
from "node:crypto";
import {
  closeSync, constants as C, copyFileSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync
}
from "node:fs";
const runtime="/opt/subscription-runtime-dependency-os-TEST";
const base="/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1";
const control=base+"/control";
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
function source(path:string):void{
  const s=lstatSync(path);
  assert(s.isFile() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && s.nlink===1 && !(s.mode&0o022));
  assert.equal(realpathSync(path),path);
}
function put(path:string,value:unknown):void{
  const fd=openSync(path,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);
  try{
    writeFileSync(fd,JSON.stringify(value)+"\n");
    fsyncSync(fd);
  }
  finally{
    closeSync(fd);
  }
}
export function publishOriginalAdministrativeTestControl(root:string):void{
  assert.match(root,/^\/var\/lib\/subscription-runtime-os-TEST\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/root$/);
  assert.equal(process.getuid?.(),0);
  assert.equal(process.env.GITHUB_ACTIONS,"true");
  assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
  assert.equal(realpathSync(root),root);
  const rootStat=lstatSync(root,{
    bigint:true
  }
  );
  assert(rootStat.isDirectory() && rootStat.uid===0n && rootStat.gid===0n && !(rootStat.mode&0o022n));
  let prefix=root;
  for(const part of base.slice(1).split("/")){
    prefix+="/"+part;
    try{
      mkdirSync(prefix,{
        mode:0o700
      }
      );
    }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    }
    const s=lstatSync(prefix);
    assert(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && !(s.mode&0o022));
  }
  for(const name of ["control","bootstrap-tmp","results","administrative-work"]){
    mkdirSync(root+base+"/"+name,{
      mode:0o700
    }
    );
    assert.equal(lstatSync(root+base+"/"+name).mode&0o7777,0o700);
  }
  const producer=runtime+"/scripts/dependency-retention-os-test/registration-guest.js";
  const operation=runtime+"/scripts/dependency-retention-os-test/current-administrative-installation.js";
  const recipe=runtime+"/scripts/dependency-retention-os-test/administrative-maintenance-native-TEST.js";
  const node=runtime+"/toolchain/bin/node",parent=runtime+"/scripts/dependency-retention-os-test/common.ts";
  const fragment="/etc/systemd/test-units/TEST-retention-supervisor.service";
  for(const path of [producer,operation,recipe,node,parent,fragment])source(root+path);
  for(const [from,to] of [[operation,"administrative-installation.js"],[recipe,"administrative-public-maintenance.js"]]){
    copyFileSync(root+from!,root+control+"/"+to,C.COPYFILE_EXCL);
    const path=root+control+"/"+to;
    // Source copy preserves the independently selected assembly bytes. It is
    // sealed below before the original supervisor/guest can exist.
    const fd=openSync(path,C.O_RDONLY|C.O_NOFOLLOW);
    try{
      assert(fstatSync(fd).isFile());
      fchmodSync(fd,0o400);
      fsyncSync(fd);
    }
    finally{
      closeSync(fd);
    }
  }
  const boundary={
    schemaVersion:1,entry:"registration-outer.ts",sourceSha:process.env.TEST_SOURCE_SHA,guestProducerSha256:hash(root+producer),supervisorSha256:hash(root+parent),supervisorUnitSha256:hash(root+fragment),rootIdentity:{
      dev:String(rootStat.dev),ino:String(rootStat.ino),mode:String(rootStat.mode),uid:"0",gid:"0"
    }
  }
  ;
  const boundarySha=createHash("sha256").update(JSON.stringify(boundary)+"\n").digest("hex");
  const catalog={
    schemaVersion:1,sourceReviewSha256:boundarySha,sourceSha:process.env.TEST_SOURCE_SHA,producer:{
      path:producer,sha256:hash(root+producer)
    }
    ,operation:{
      path:control+"/administrative-installation.js",sha256:hash(root+operation)
    }
    ,actor:{
      path:control+"/administrative-public-maintenance.js",sha256:hash(root+recipe)
    }
    ,node:{
      path:node,sha256:hash(root+node)
    }
  }
  ;
  put(root+control+"/administration-reviewed-source.json",catalog);
  put(root+control+"/original-bootstrap-boundary-FREEZE.json",boundary);
  const directory=openSync(root+control,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try{
    fsyncSync(directory);
  }
  finally{
    closeSync(directory);
  }
}
