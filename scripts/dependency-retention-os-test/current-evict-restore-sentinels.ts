/** Public disposable TEST files only. Credential bytes are never read or hashed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertRootScope, type CurrentOrdinaryRoots } from "./current-cold-hot-root.js";
function ancestry(path:string) {
  for(let parent=dirname(path);;parent=dirname(parent)) {
    const stat=lstatSync(parent);assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid===0 && !(stat.mode&0o022));
    assert.equal(realpathSync(parent),parent);if(parent==="/")break;
  }
}
function publicFile(path:string) {
  ancestry(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
    assert(before.isFile() && !named.isSymbolicLink() && before.uid===0n && before.nlink===1n && !(before.mode&0o022n));
    assert(before.size>=0n && before.size<=8n*1024n*1024n);
    const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<bytes.length) {const n=readSync(fd,bytes,length,bytes.length-length,length);if(n===0)break;length+=n;}
    assert.equal(length,Number(before.size));
    for(const stat of [fstatSync(fd,{bigint:true}),lstatSync(path,{bigint:true})])
      for(const key of ["dev","ino","mode","uid","gid","nlink","size","mtimeNs","ctimeNs"] as const)assert.equal(stat[key],before[key]);
    return Object.freeze({path,dev:String(before.dev),ino:String(before.ino),mode:String(before.mode),size:length,
      sha256:createHash("sha256").update(bytes.subarray(0,length)).digest("hex")});
  } finally {closeSync(fd);}
}
function authMetadata(roots:CurrentOrdinaryRoots) {
  // Stat only, including the mounted leaf. No open/read/hash/copy of auth.json.
  const path=roots.jobRoot+"/auth/"+roots.accountName+"/auth.json";ancestry(path);
  const s=lstatSync(path,{bigint:true});assert(s.isFile() && !s.isSymbolicLink() && s.uid===0n && s.gid===0n && s.nlink===1n);
  assert((s.mode&0o7777n)===0o600n && s.size>0n && s.size<=65536n);
  return [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String);
}
/** Called only after actual fresh ROOT preparation and before first consumer.
 * These literals are synthetic preservation markers, never credentials/grants. */
export function prepareEvictRestoreSentinels(roots:CurrentOrdinaryRoots) {
  assertRootScope(roots);
  for(const path of [roots.jobRoot+"/TEST-public-key-marker",roots.jobRoot+"/state/TEST-retention-state-marker",
    roots.jobRoot+"/TEST-retention-output-marker",roots.workspace+"/TEST-untracked-authored-cache",
    roots.workspace+"/.git/TEST-ignored-state-marker"]) {
    ancestry(path);writeFileSync(path,"TEST preservation marker only\n",{flag:"wx",mode:0o600});
  }
}
export function captureEvictRestoreSentinels(roots:CurrentOrdinaryRoots) {
  assertRootScope(roots);
  const workspacePaths=["source-sentinel",".gitignore",".git/HEAD",".git/config",".git/index",".git/TEST-ignored-state-marker",
    "package.json","package-lock.json","TEST-current-local.test.ts","packages/live/package.json","packages/live/index.ts",
    "packages/pack-input/package.json","packages/pack-input/index.ts","packages/packed/test-native-packed-1.0.0.tgz",
    "TEST-readonly-local-custody/input.txt","TEST-untracked-authored-cache"];
  const paths=[...workspacePaths.map(path=>roots.workspace+"/"+path),...[
    "prompt","TEST-public-key-marker","state/TEST-retention-state-marker","TEST-retention-output-marker"].map(path=>roots.jobRoot+"/"+path)];
  const files=paths.map(publicFile);assert(files.reduce((sum,file)=>sum+file.size,0)<=32*1024*1024);
  return Object.freeze({files:Object.freeze(files),auth:authMetadata(roots)});
}
export function assertEvictRestoreSentinels(roots:CurrentOrdinaryRoots,expected:ReturnType<typeof captureEvictRestoreSentinels>) {
  assert.deepEqual(captureEvictRestoreSentinels(roots),expected);
  // Export only known public marker count/digests. Auth metadata stays private.
  return Object.freeze({publicFiles:expected.files.length,sha256:createHash("sha256").update(JSON.stringify(expected.files)).digest("hex")});
}
