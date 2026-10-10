import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const entry=process.env.NP_RETAINED_V2_ENTRY;
if(!entry)throw new Error("missing actual separately compiled NativeRetainedV2A1 entry");
for(const args of [[],[JSON.stringify({schemaVersion:2,producerId:"forged",qualified:true})]]) {
  test(args.length?"JSON cannot construct original native custody":"unfunded entry cannot mint original native custody",()=>{
    const fixture=mkdtempSync(join(tmpdir(),"sr-retained-v2-refusal-TEST-"));
    try {
      const result=spawnSync(entry,args,{cwd:fixture,env:{PATH:"/usr/bin:/bin"},stdio:["ignore","pipe","pipe"],timeout:2000});
      assert.equal(result.error,undefined);
      assert.equal(result.signal,null);
      assert.equal(result.status,77);
      assert.equal(result.stdout.length,0);
      assert.deepEqual(readdirSync(fixture),[]);
    }finally{rmSync(fixture,{recursive:true,force:false});}
  });
}
