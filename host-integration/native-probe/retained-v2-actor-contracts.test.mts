import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture=process.env.NP_RETAINED_V2_ACTOR_TEST,entry=process.env.NP_RETAINED_V2_ACTOR_ENTRY;
if(!fixture||!entry)throw new Error("actual separately compiled native actor TEST/entry required");
for(const mode of ["protocol","whole-group","observer","refuse","birth-close","notifications"]) {
  test(`real original syscall boundary: ${mode}`,()=>{
    const directory=mkdtempSync(join(tmpdir(),"sr-native-b1a-contract-TEST-"));
    try {
      const result=spawnSync(fixture,[mode],{cwd:directory,env:{PATH:"/usr/bin:/bin"},timeout:6000});
      assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr.toString());
      assert.deepEqual(readdirSync(directory),[]);
    }finally{rmSync(directory,{recursive:true,force:false});}
  });
}
// This is a real privilege-drop/filter syscall test on a harmless owned child,
// not an original Root/manager qualification or a substituted success receipt.
test("actual post-READY filter denies new clone, path open and exec",{skip:process.getuid?.()!==0||process.getgid?.()!==0},()=>{
  const directory=mkdtempSync(join(tmpdir(),"sr-native-b1a-seal-TEST-"));
  try {
    const result=spawnSync(fixture,["seal"],{cwd:directory,env:{PATH:"/usr/bin:/bin"},timeout:6000});
    assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr.toString());
    assert.deepEqual(readdirSync(directory),[]);
  }finally{rmSync(directory,{recursive:true,force:false});}
});
for(const args of [[],[JSON.stringify({generation:1,held:true,pidfd:7,qualified:true})]]) {
  test(args.length?"serialized actor facts cannot supply original cell":"unfunded B1a entry refuses before clone/scope effect",()=>{
    const directory=mkdtempSync(join(tmpdir(),"sr-native-b1a-entry-TEST-"));
    try {
      const result=spawnSync(entry,args,{cwd:directory,env:{PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"],timeout:2000});
      assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,77);assert.equal(result.stdout.length,0);assert.deepEqual(readdirSync(directory),[]);
    }finally{rmSync(directory,{recursive:true,force:false});}
  });
}
