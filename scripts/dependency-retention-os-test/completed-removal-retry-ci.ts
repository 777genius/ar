/** Fresh GitHub TEST VM only; exact two-case old-red / fifteen-case new-green.
 * This proves immutable-file retry behavior, not genuine native actor authority. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { JsonTestResults } from "vitest/reporters";
// Exact historical source bytes are committed as TEST data. Public source-only
// history need not contain, fetch or claim ancestry to the original private commit.
const base="798edef247cfd43fbc7a07745b3cf8384374624d",ownership="src/worker-codex/hosted-dependency-removal-ownership.ts";
const baselineFixture="scripts/dependency-retention-os-test/fixtures/completed-removal-retry/hosted-dependency-removal-ownership.ts.txt",baselineProvenance="scripts/dependency-retention-os-test/fixtures/completed-removal-retry/provenance.json";
const baselineBlob="4ac41a8cd1c33a91d51f34c1a9bda5e1dbf11d08",baselineSha256="436f411ffb51cd47ad105545d62d83c7627dee26134f2b8929780e7bdf2f08b2",provenanceSha256="ae6b1512591745146cc9c9fe6220e420e096e79e0c34282a96a68d305028e7db";
const baselineBytes=17201;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);assert.equal(process.argv.length,5);
const [workspaceArg,tempArg,sourceSha]=process.argv.slice(2);assert(workspaceArg && tempArg && sourceSha && /^[a-f0-9]{40}$/.test(sourceSha));
assert(isAbsolute(workspaceArg) && isAbsolute(tempArg));
const workspace=realpathSync(workspaceArg),temp=realpathSync(tempArg);
assert(lstatSync(workspace).isDirectory() && lstatSync(temp).isDirectory());
const env={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",HOME:"/nonexistent",CI:"true"};
const git=(args:string[])=>execFileSync("/usr/bin/git",["-c",`safe.directory=${workspace}`,...args],{cwd:workspace,env,timeout:30000,maxBuffer:64*1024*1024});
assert.equal(git(["rev-parse","HEAD"]).toString("utf8").trim(),sourceSha);
// Bind both fixture and provenance to this exact tested public commit. SHA pins
// refuse modified baseline bytes; provenance records origin without ancestry.
const old=git(["show","HEAD:"+baselineFixture]),provenanceBytes=git(["show","HEAD:"+baselineProvenance]);
assert.equal(old.length,baselineBytes);assert.equal(hash(old),baselineSha256);
assert.equal(createHash("sha1").update(Buffer.from(`blob ${old.length}\0`)).update(old).digest("hex"),baselineBlob);
assert.equal(hash(provenanceBytes),provenanceSha256);
const provenance:unknown=JSON.parse(provenanceBytes.toString("utf8"));
assert.deepEqual(provenance,{schemaVersion:1,purpose:"TEST_completed_immutable_idle_retry_baseline_only",
  sourceCommit:base,sourcePath:ownership,sourceBlob:baselineBlob,fixturePath:baselineFixture,
  fixtureSha256:baselineSha256,fixtureBytes:baselineBytes,historyImported:false,nativeAuthority:"NONE"});
const original=git(["show","HEAD:"+ownership]);
assert(!old.equals(original),"fixed ownership must differ from exact baseline");
const archive=git(["archive","HEAD","src","package.json","vitest.config.ts"]),owned=mkdtempSync(join(temp,"TEST-completed-removal-retry-"));
const evidencePath=join(workspace,"dependency-completed-removal-retry-evidence.json");
const evidence:Record<string,unknown>={schemaVersion:1,purpose:"TEST_completed_immutable_idle_retry_only",sourceSha,baseSha:base,
  baselineMode:"pinned_public_TEST_source_fixture",baselineFixture,baselineSourceBlob:baselineBlob,baselineProvenanceSha256:provenanceSha256,
  baselineAncestry:"NOT_ASSERTED",
  fixedOwnershipSha256:hash(original),baselineOwnershipSha256:hash(old),
  sourceAliasConfigSha256:hash(git(["show","HEAD:vitest.config.ts"])),
  testSourceSha256:hash(git(["show","HEAD:src/worker-codex/tests/hosted-dependency-completed-removal-retry.test.ts"])),qualification:"pending",nativeCrashQualification:"NOT_RUN"};
// Finite TEST diagnostics survive failed collection/validation without publishing
// provider data, arbitrary paths, raw process output or exception text.
const RetryDiagnosticCause = { SourceImportResolution:"source_import_resolution", CollectionFailed:"collection_failed", ReportUnavailable:"report_unavailable", ReportCollected:"report_collected" } as const;
function retryDiagnostics(reportBytes:Buffer|undefined,diagnostic:string) {
  let report:JsonTestResults|undefined;
  try { if(reportBytes)report=JSON.parse(reportBytes.toString("utf8")) as JsonTestResults; } catch { /* Finite unavailable result below. */ }
  const count=(value:unknown)=>typeof value==="number" && Number.isSafeInteger(value) && value>=0 && value<=100 ? value : null;
  const messages=Array.isArray(report?.testResults) ? report.testResults.map(file=>typeof file?.message==="string" ? file.message : "").join("\n") : "";
  const cause=/Cannot find (?:package|module)|Failed to resolve import|ERR_MODULE_NOT_FOUND/.test(diagnostic+messages) ? RetryDiagnosticCause.SourceImportResolution :
    !report ? RetryDiagnosticCause.ReportUnavailable : report.numTotalTests===0 ? RetryDiagnosticCause.CollectionFailed : RetryDiagnosticCause.ReportCollected;
  return {cause,diagnosticSha256:hash(Buffer.from(diagnostic)),reportSha256:reportBytes ? hash(reportBytes) : null,
    total:count(report?.numTotalTests),passed:count(report?.numPassedTests),failed:count(report?.numFailedTests),
    pending:count(report?.numPendingTests),todo:count(report?.numTodoTests)};
}
function run(label:"fixed"|"baseline",bytes:Buffer) {
  const project=join(owned,label);mkdirSync(project,{mode:0o700});
  execFileSync("/usr/bin/tar",["-xf","-","-C",project],{input:archive,env,timeout:30000});
  writeFileSync(join(project,ownership),bytes);
  symlinkSync(join(workspace,"node_modules"),join(project,"node_modules"),"dir");
  writeFileSync(join(project,"vitest.completed-removal.config.mts"),`import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { alias } from "./vitest.config.ts";
export default defineConfig({cacheDir:resolve("test-cache"),resolve:{alias:Object.fromEntries(Object.entries(alias).map(([name,path])=>[name,resolve("."+path)]))},test:{include:["src/worker-codex/tests/hosted-dependency-completed-removal-retry.test.ts"],maxWorkers:1}});
`);
  const reportPath=join(project,"report.json"),result=spawnSync(process.execPath,[join(workspace,"node_modules/vitest/vitest.mjs"),"run","--config","vitest.completed-removal.config.mts","--reporter=default","--reporter=json","--outputFile="+reportPath],
    {cwd:project,env:{...env,TMPDIR:owned},timeout:240000,maxBuffer:8*1024*1024,encoding:"utf8"});
  const diagnostic=result.stdout+result.stderr;
  let reportBytes:Buffer|undefined;
  try { reportBytes=readFileSync(reportPath); } catch { /* Record absence before enforcing the unchanged result contract. */ }
  const finite=retryDiagnostics(reportBytes,diagnostic);
  evidence[label]={phase:"result_validation",exitCode:result.status,signalled:result.signal!==null,runnerError:!!result.error,...finite};
  console.log(JSON.stringify({scope:"TEST_completed_removal_retry",label,...evidence[label] as object}));
  assert(!result.error && result.signal===null,label+" runner failed or timed out");
  assert(!/Unhandled Errors?|Unhandled Rejection|Uncaught Exception/.test(diagnostic),label+" unhandled runner error");
  const report=JSON.parse(readFileSync(reportPath,"utf8")) as JsonTestResults;
  assert.equal(report.numTotalTests,15);assert.equal(report.numPendingTests,0);assert.equal(report.numTodoTests,0);assert.equal(report.testResults.length,1);
  const tests=report.testResults.flatMap(file=>file.assertionResults);assert.equal(tests.length,15);
  assert(tests.every(test=>test.status==="passed" || test.status==="failed"),label+" skipped/nonexecuted case");
  if(label==="fixed") {
    assert.equal(result.status,0);assert.equal(report.numPassedTests,15);assert.equal(report.numFailedTests,0);assert(report.success);assert(tests.every(test=>test.status==="passed"));
  } else {
    assert.equal(result.status,1);assert.equal(report.numPassedTests,13);assert.equal(report.numFailedTests,2);assert.equal(report.success,false);
    const failed=tests.filter(test=>test.status==="failed"),titles=failed.map(test=>test.title).sort();
    assert.deepEqual(titles,["reuses exact durable idle without replacing its inode (lock present=false)","reuses exact durable idle without replacing its inode (lock present=true)"].sort());
    assert(failed.every(test=>test.failureMessages?.some(message=>/\bEEXIST\b/.test(message))),"baseline must fail at original exclusive idle creation");
  }
  evidence[label]={exitCode:result.status,reportSha256:hash(readFileSync(reportPath)),passed:report.numPassedTests,failed:report.numFailedTests,skipped:0,
    cases:tests.map(test=>({title:test.title,status:test.status,failureMessages:test.failureMessages}))};
}
try {run("fixed",original);run("baseline",old);evidence.qualification="root_linux_exact_baseline_red2_fixed_green15";}
finally {
  // Persist finite failure facts before removing this harness's owned source copies.
  writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+"\n",{mode:0o644,flag:"wx"});
  rmSync(owned,{recursive:true,force:true});
}
assert.equal(evidence.qualification,"root_linux_exact_baseline_red2_fixed_green15");
console.log("TEST completed-removal retry: exact baseline red2, fixed green15, skipped0; native crash NOT_RUN");
