/** Owned PID1 supervisor keeps the genuine parent service alive after guest. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { json, node, runtime } from "./common.ts";
import { currentFullEnvironment } from "./current-full-env.js";
assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);assert.equal(process.argv.length,3);assert.equal(process.argv[2],"supervisor");
assert.equal(process.argv[1],runtime+"/scripts/dependency-retention-os-test/current-full-supervisor.js");
assert.match(process.env.TEST_SOURCE_SHA??"",/^[a-f0-9]{40}$/);
json(runtime+"/guest-started.json",{schemaVersion:1,purpose:"TEST_bootstrap_observation_only",sourceSha:process.env.TEST_SOURCE_SHA,
  machineId:readFileSync("/etc/machine-id","utf8").trim(),pid:process.pid});
const child=spawn(node,[runtime+"/scripts/dependency-retention-os-test/current-full-guest.js","qualify"],
  {env:{...currentFullEnvironment(),TEST_SOURCE_SHA:process.env.TEST_SOURCE_SHA},stdio:["pipe","pipe","pipe"]});
// Real pipes satisfy the unchanged descriptor boundary. Never persist output.
child.stdin.on("error",()=>{});child.stdin.end();child.stdout.resume();child.stderr.resume();
const timeout=setTimeout(()=>child.kill("SIGTERM"),27*60*1000);
const failed=(reason:"spawn_failed"|"child_exited_without_evidence",code:number|null,signal:NodeJS.Signals|null)=>{
  clearTimeout(timeout);
  if(!existsSync(runtime+"/guest-evidence.json") && !existsSync(runtime+"/guest-child-exit.json"))
    json(runtime+"/guest-child-exit.json",{schemaVersion:1,purpose:"TEST_child_failure_observation_only",sourceSha:process.env.TEST_SOURCE_SHA,reason,code,signal});
};
child.once("error",()=>failed("spawn_failed",null,null));child.once("close",(code,signal)=>failed("child_exited_without_evidence",code,signal));
// Actual supervisor unit lifetime, not the guest process, supplies operator birth.
setInterval(()=>{},60000);
