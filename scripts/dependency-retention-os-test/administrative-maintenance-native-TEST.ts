/** Fixed TEST administrative inspection recipe. Production recipe has no
* control switch. Its material handle intentionally makes qualification veto. */
import assert from "node:assert/strict";
import {
  constants as C, closeSync, fsyncSync, openSync, readFileSync, writeFileSync
}
from "node:fs";
const control="/srv/workers/public-intake/TEST-dependency-full-native-20261007-r1/control";
const image=control+"/TEST-native-backing.img";
assert.equal(process.argv[1],control+"/administrative-public-maintenance.js");
assert.equal(process.argv[2],"--maintain");
assert.equal(process.getuid?.(),0);
assert.match(process.env.INVOCATION_ID??"",/^[a-f0-9]{32}$/);
// Initialization has completed. Fixed leaf-only publication does not open
// CONTROL or any target-ancestor directory after the marker becomes valid.
const raw=readFileSync("/proc/self/stat","utf8"),pid=/^([1-9][0-9]*) \(/.exec(raw)?.[1],birth=raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/)[19];
assert(pid && birth && /^[1-9][0-9]*$/.test(birth));
const ready=openSync(control+"/administrative-ready.json",C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o400);
try {writeFileSync(ready,JSON.stringify({schemaVersion:1,pid:Number(pid),birth,invocationId:process.env.INVOCATION_ID})+"\n");fsyncSync(ready);} finally {closeSync(ready);}
let imageFd:number|undefined,controlFd:number|undefined;
const deadline=process.hrtime.bigint()+300n*1000000000n;
try{
  while(process.hrtime.bigint()<deadline){
    try{
      assert.equal(readFileSync(control+"/TEST-inspection-control-open","utf8"),"INSPECT_FIXED_PARENT_CONTROL\n");
      if(controlFd===undefined)controlFd=openSync("/proc/1",C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    }
    try{
      const command=readFileSync(control+"/TEST-inspection-open","utf8");
      assert.equal(command,"INSPECT_FIXED_IMAGE_READONLY\n");
      if(imageFd===undefined)imageFd=openSync(image,C.O_RDONLY|C.O_NOFOLLOW);
    }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    }
    await new Promise<void>(resolve=>setTimeout(resolve,100));
  }
}
finally{
  if(imageFd!==undefined)closeSync(imageFd);
  if(controlFd!==undefined)closeSync(controlFd);
}
