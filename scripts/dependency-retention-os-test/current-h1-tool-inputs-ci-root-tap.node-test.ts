import assert from "node:assert/strict";
import test from "node:test";
import {assertCiRootProtocolTap} from "./current-h1-tool-inputs-ci.ts";

// Case names mirror the fixed mandatory ROOT inventory; summary counts mirror the fixed protocol inventory.
// This isolated parser test is not part of the fixed ROOT child invocation.
const cases=[
 "shared decoder adapters retain the CI scope and cannot turn expired/caller DATA into a native tool launch",
 "qualified package lock reproduces the previously measured complete signed image",
 "qualified acquisition pins every dependency and retains all five original seeds",
 "real acquired file hashes retained bytes and refuses post-read deadline/identity mutation",
 "retained original archive rejects equal-byte replacement between verification and extraction",
 "selected entry rejects inherited hooks without invocation",
 "selected ROOT requires exact recursively frozen original member row bindings before anchor",
 "selected ROOT preserves every object yield and live joins with one detached plan canonicalization",
 "selected ROOT detects nested caller mutations at real yields including frozen parents and complete fallback",
 "selected ROOT refuses inherited function and getter hooks at optimized fallback and publication windows"
];
const tap=cases.map((name,index)=>`ok ${index+1} - ${name}`).join("\n")+"\n# tests 45\n# pass 44\n# fail 0\n# skipped 1\n";
test("fixed ROOT inventory accepts expanded successful summary and refuses old counts or failures",()=>{
 assert.doesNotThrow(()=>assertCiRootProtocolTap(tap));
 for(const changed of [tap.replace("# tests 45","# tests 43").replace("# pass 44","# pass 42"),tap.replace("# fail 0","# fail 1"),tap.replace("# skipped 1","# skipped 2"),tap.replace("# pass 44","# pass 43")])assert.throws(()=>assertCiRootProtocolTap(changed));
});
test("each new and original mandatory ROOT case must pass without skipping or renaming",()=>{
 for(const name of cases){
  for(const changed of [tap.replace(name,name+" # SKIP"),tap.replace(name,name+" renamed"),tap.replace(name,"unrelated "+name),tap.replace(new RegExp(`ok [0-9]+ - ${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`),"not ok 1 - "+name)])assert.throws(()=>assertCiRootProtocolTap(changed));
 }
});
