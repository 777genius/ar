/** Finite fresh-VM TEST acceptance only; never hosted/native qualification. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifact="/usr/local/lib/subscription-runtime-dependency-TEST";
const reportName="explicit-preservation-root-result.json",stampName="explicit-preservation-root-run.json",summaryName="explicit-preservation-root-summary.json";
export const explicitPreservationRootCases = Object.freeze({
  "src/store-local-file/dependency-environment/tests/dependency-explicit-preservation-retirement.test.ts": [
    "explicit operator storage retirement retires pristine actual tree without changing bytes or original Ready evidence",
    "explicit operator storage retirement retires changed actual tree without changing bytes or original Ready evidence",
    "explicit operator storage retirement retires replaced actual tree without changing bytes or original Ready evidence",
    "explicit operator storage retirement retains original RetiredReady adjacency when explicit successor follows already-Unverified",
    "explicit operator storage retirement generic publication and old retirement cannot borrow configured explicit verifier",
    "explicit operator storage retirement refuses missing-issuer without receipt or filesystem mutation",
    "explicit operator storage retirement refuses forged-issuer without receipt or filesystem mutation",
    "explicit operator storage retirement refuses changed-reference without receipt or filesystem mutation",
    "explicit operator storage retirement refuses changed-generation without receipt or filesystem mutation",
    "explicit operator storage retirement refuses changed-coverage without receipt or filesystem mutation",
    "explicit operator storage retirement refuses changed-source without receipt or filesystem mutation",
    "explicit operator storage retirement refuses changed-tree without receipt or filesystem mutation"
  ],
  "src/worker-codex/tests/hosted-dependency-explicit-preservation-operator.test.ts": [
    "rejects a foreign caller before original selection or filesystem effect",
    "original begin failure occurs before receipt/effect",
    "released replay still refuses absent committed mapping before opening or releasing an effect",
    "original runner real disposable Linux effect (projected authority) durably prepares then moves full inode before mapping, closes handles before release, and replays released result",
    "original runner real disposable Linux effect (projected authority) recovers original prepared crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) recovers original rename-before crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) recovers original rename-after crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) recovers original committed crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) recovers original release-before crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) recovers original release-after crash without replacing preserved bytes or releasing early",
    "original runner real disposable Linux effect (projected authority) source-tree replacement fails before committed mapping and owner release"
  ],
  "src/worker-local/dependency-environment/tests/dependency-tree-preservation.test.ts": [
    "opaque whole-tree preservation moves the entire original inode and inventory without following unknown links",
    "opaque whole-tree preservation refuses bytes races without destroying either tree",
    "opaque whole-tree preservation refuses membership races without destroying either tree",
    "opaque whole-tree preservation refuses destination races without destroying either tree",
    "opaque whole-tree preservation refuses source-swap races without destroying either tree",
    "opaque whole-tree preservation refuses ancestor-swap races without destroying either tree",
    "opaque whole-tree preservation reopens the exact relocated inode to reconcile durable post-rename readback",
    "opaque whole-tree preservation invalidates both the effect and its genuine descriptor session on close",
    "preservation data durability barrier flushes every regular file and postorder directory before namespace parents",
    "preservation data durability barrier holds the operation at uncertain file fsync and reconciles the exact original inode",
    "preservation data durability barrier holds the operation at uncertain directory fsync and reconciles the exact original inode",
    "preservation data durability barrier holds the operation at uncertain namespace-parent fsync and reconciles the exact original inode",
    "preservation data durability barrier revalidates content after successful data/directory I/O and refuses before rename",
    "preservation data durability barrier revalidates source-alias after successful data/directory I/O and refuses before rename",
    "preservation data durability barrier refuses post-parent-sync content drift before reporting a committed effect",
    "preservation data durability barrier refuses post-parent-sync destination-alias drift before reporting a committed effect",
    "a copied descriptor DTO never grants a preservation reference exception",
    "refuses unsupported host primitives before attempting a preservation"
  ]
});
function object(v:unknown):Record<string,unknown> {assert(v && typeof v==="object" && !Array.isArray(v));return v as Record<string,unknown>;}
/** Validates actual reporter cases, not only optimistic suite/global totals. */
export function requireExplicitPreservationReport(input:unknown,root:string,started:number) {
  const v=object(input),entries=Object.entries(explicitPreservationRootCases),total=entries.reduce((n,[,cases])=>n+cases.length,0);
  assert.equal(v.success,true);assert.equal(v.numTotalTests,total);assert.equal(v.numPassedTests,total-1);assert.equal(v.numPendingTests,1);
  for(const key of ["numFailedTests","numTodoTests","numFailedTestSuites","numPendingTestSuites"])assert.equal(v[key],0);
  assert(typeof v.startTime==="number" && v.startTime>=started && v.startTime<=Date.now());
  assert(Array.isArray(v.testResults));assert.equal(v.testResults.length,entries.length);
  const seen=new Set<string>();let knownSkipped=0;
  for(const result of v.testResults) {
    const row=object(result);assert(typeof row.name==="string");const path=relative(root,row.name);
    const expected=entries.find(([name])=>name===path);assert(expected && row.name===join(root,path));assert(!seen.has(path));seen.add(path);
    assert.equal(row.status,"passed");assert.equal(row.message,"");assert(Array.isArray(row.assertionResults));assert.equal(row.assertionResults.length,expected[1].length);
    const names=new Set<string>();
    for(const raw of row.assertionResults) {
      const test=object(raw);
      if(path==="src/worker-local/dependency-environment/tests/dependency-tree-preservation.test.ts" &&
          test.fullName==="refuses unsupported host primitives before attempting a preservation") {
        assert.equal(test.title,test.fullName);assert.deepEqual(test.ancestorTitles,[]);assert.equal(test.status,"skipped");knownSkipped++;}
      else assert.equal(test.status,"passed");
      assert(Array.isArray(test.failureMessages));assert.equal(test.failureMessages.length,0);
      assert(typeof test.fullName==="string" && test.fullName.length>0 && !names.has(test.fullName));assert(expected[1].includes(test.fullName));names.add(test.fullName);
    }
  }
  assert.equal(seen.size,entries.length);assert.equal(knownSkipped,1);return {files:entries.length,cases:total,passed:total-1,knownPlatformNegativeSkipped:1,unexpectedSkipped:0,failed:0};
}
function owned(path:string,directory=false) {
  const st=lstatSync(path,{bigint:true});assert(!st.isSymbolicLink());assert(directory?st.isDirectory():st.isFile());
  assert.equal(st.uid,0n);assert.equal(st.mode&0o022n,0n);if(!directory)assert.equal(st.nlink,1n);return st;
}
function bytes(path:string,maximum:number) {const st=owned(path);assert(st.size>0n && st.size<=BigInt(maximum));return readFileSync(path);}
function sourceDigest() {
  const hash=createHash("sha256");let count=0,total=0;
  function walk(path:string) {
    owned(path,true);for(const name of readdirSync(path).sort()) {
      const leaf=join(path,name),st=lstatSync(leaf);if(st.isDirectory())walk(leaf);else {
        assert(st.isFile() && !st.isSymbolicLink());assert(++count<=12000);
        const data=bytes(leaf,4*1024*1024);total+=data.length;assert(total<=256*1024*1024);
        hash.update(relative(artifact,leaf)+"\0");hash.update(createHash("sha256").update(data).digest());
      }
    }
  }
  walk(join(artifact,"src"));
  for(const name of ["vitest.config.ts","tsconfig.json","scripts/dependency-retention-test/require-explicit-preservation-root-result.mts"]) {
    hash.update(name+"\0");hash.update(createHash("sha256").update(bytes(join(artifact,name),262144)).digest());
  }
  return hash.digest("hex");
}
const Mode = { Prepare:"prepare", Require:"require" } as const;
function main() {
  assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);assert.equal(realpathSync(process.cwd()),artifact);
  for(let path=artifact;;path=dirname(path)){owned(path,true);if(path==="/")break;}
  const source=process.env.TEST_SOURCE_SHA;assert(source && /^[a-f0-9]{40}$/.test(source));
  const mode=process.argv[2];assert(process.argv.length===3 && (mode===Mode.Prepare || mode===Mode.Require));
  const stamp=join(artifact,stampName),report=join(artifact,reportName),summary=join(artifact,summaryName);
  if(mode===Mode.Prepare) {
    assert(!existsSync(stamp) && !existsSync(report) && !existsSync(summary));
    writeFileSync(stamp,JSON.stringify({version:1,source,sourceDigest:sourceDigest(),started:Date.now()})+"\n",{mode:0o600,flag:"wx"});return;
  }
  const run=object(JSON.parse(bytes(stamp,4096).toString("utf8")));assert.equal(run.version,1);assert.equal(run.source,source);
  assert.equal(run.sourceDigest,sourceDigest());assert(typeof run.started==="number" && run.started>0 && Date.now()-run.started<10*60*1000);
  const actual=requireExplicitPreservationReport(JSON.parse(bytes(report,2*1024*1024).toString("utf8")),artifact,run.started);
  const result={kind:"TEST-explicit-preservation-root-storage-and-projected-runner",source,sourceDigest:run.sourceDigest,...actual};
  writeFileSync(summary,JSON.stringify(result)+"\n",{mode:0o600,flag:"wx"});console.log(JSON.stringify(result));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {main();}catch {console.error("explicit_preservation_root_result_required");process.exitCode=1;}
}
