import assert from "node:assert/strict";
import test from "node:test";
import {assertCiRootProtocolTap} from "./current-h1-tool-inputs-ci.ts";

// Names and summary transcribed from run38003156594 artifact11650535204.
// This isolated parser test is not part of the fixed ROOT child invocation.
const cases=[
 "real acquired file hashes retained bytes and refuses post-read deadline/identity mutation",
 "retained original archive rejects equal-byte replacement between verification and extraction",
 "selected entry rejects inherited hooks without invocation",
 "selected ROOT requires exact recursively frozen original member row bindings before anchor",
 "selected ROOT preserves every object yield and live joins with one detached plan canonicalization",
 "selected ROOT detects nested caller mutations at real yields including frozen parents and complete fallback",
 "selected ROOT refuses inherited function and getter hooks at optimized fallback and publication windows"
];
const tap=cases.map((name,index)=>`ok ${index+1} - ${name}`).join("\n")+"\n# tests 41\n# pass 40\n# fail 0\n# skipped 1\n";
test("fixed ROOT inventory accepts expanded successful summary and refuses old counts or failures",()=>{
 assert.doesNotThrow(()=>assertCiRootProtocolTap(tap));
 for(const changed of [tap.replace("# tests 41","# tests 36").replace("# pass 40","# pass 35"),tap.replace("# fail 0","# fail 1"),tap.replace("# skipped 1","# skipped 2"),tap.replace("# pass 40","# pass 39")])assert.throws(()=>assertCiRootProtocolTap(changed));
});
test("each new and original mandatory ROOT case must pass without skipping or renaming",()=>{
 for(const name of cases){
  for(const changed of [tap.replace(name,name+" # SKIP"),tap.replace(name,name+" renamed"),tap.replace(name,"unrelated "+name),tap.replace(new RegExp(`ok [0-9]+ - ${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`),"not ok 1 - "+name)])assert.throws(()=>assertCiRootProtocolTap(changed));
 }
});
