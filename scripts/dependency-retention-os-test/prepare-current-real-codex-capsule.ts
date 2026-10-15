/** Public-only official input staging on a NEW owned ROOT TEST outer. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, renameSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { readCurrentReviewedPublicCodex } from "./compose-current-real-codex.js";
import { readOriginalFullParentPaths, assertRetainedCurrentFullParent } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
const packages = [
  {name:"codex",version:"0.160.1",maximum:4904,sha512:"f1yrJhwgimKQI1kYQlxdPJcFwkNZxZrbz7Hf89EAcnLqkQ7TiESzr2FgSZn13Ga5RuHjlVUfurzwq10wk9zw2g=="},
  {name:"codex-linux-x64",version:"0.160.1-linux-x64",maximum:163294814,sha512:"sIDhqV+bsZKKVaVFVY5iB+pAzyOz2XRm3H1KXCsSJwGj5p98qnrT0Fweo1Hfe7WnyTp8mfBNdbVzUeO+mHYugA=="},
] as const;
function directory(path: string) {
  const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && !(stat.mode & 0o022));
  assert.equal(realpathSync(path),path);
}
function ancestry(path: string) { for(let parent=dirname(path);;parent=dirname(parent)) { directory(parent); if(parent==="/")break; } }
function absent(path: string) { assert.throws(()=>lstatSync(path),(error:unknown)=>error instanceof Error && "code" in error && error.code==="ENOENT"); }
/** No auth/npm commands or installer work. Fixed PUBLIC fetch only after the
 * independently reviewed exact catalogue has been supplied. No automatic retry.
 * Failed partial staging is retained; an unknown existing prefix is never reused. */
export async function prepareCurrentRealCodexCapsule(parent:object,sourceSha: string) {
  const {fullNativePublicDownloadBase:staging,fullNativePublicCapsule:capsule,fullNativeTmpDir}=readOriginalFullParentPaths(parent);
  assert.equal(process.platform,"linux"); assert.equal(process.getuid?.(),0); assert.equal(process.geteuid?.(),0);
  const review = readCurrentReviewedPublicCodex(parent,sourceSha);
  ancestry(staging); absent(staging); mkdirSync(staging,{mode:0o700});
  ancestry(dirname(capsule)); absent(dirname(capsule)); mkdirSync(dirname(capsule),{mode:0o755}); mkdirSync(capsule,{mode:0o755});
  for (const pkg of packages) {
    assertRetainedCurrentFullParent(parent);
    const destination = staging+"/"+pkg.name+".tgz", fd=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const abort = AbortSignal.timeout(180000); let length=0; const digest=createHash("sha512");
    try {
      fchmodSync(fd,0o600);
      const response = await fetch("https://registry.npmjs.org/@openai/codex/-/codex-"+pkg.version+".tgz",{redirect:"error",signal:abort});
      assertRetainedCurrentFullParent(parent);assert.equal(response.status,200); assert(response.body);
      const reader = response.body.getReader();
      try {
        for (;;) {
          const item=await reader.read(); assertRetainedCurrentFullParent(parent);if(item.done)break; const bytes=item.value;
          assert(bytes.byteLength>0 && length+bytes.byteLength<=pkg.maximum); digest.update(bytes);
          let offset=0; while(offset<bytes.byteLength) { const n=writeSync(fd,bytes,offset,bytes.byteLength-offset,length+offset); assert(n>0);offset+=n; }
          length+=bytes.byteLength;
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      assert(length>0); assert.equal(digest.digest("base64"),pkg.sha512); fsyncSync(fd);
    } finally { closeSync(fd); }
    const extraction=staging+"/"+pkg.name; mkdirSync(extraction,{mode:0o700});
    // Extraction sees only the exact SRI-verified immutable official archive.
    const result=spawnSync("/usr/bin/tar",["--extract","--gzip","--file",destination,"--directory",extraction,
      "--no-same-owner","--no-same-permissions","--no-overwrite-dir"],{env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",TMPDIR:fullNativeTmpDir},
      stdio:["ignore","ignore","ignore"],timeout:30000});
    assert(!result.error && result.status===0 && result.signal===null,"TEST public capsule extraction failed");
    const packageRoot=extraction+"/package"; directory(packageRoot);
    assert.deepEqual(readdirSync(extraction),["package"]); renameSync(packageRoot,capsule+"/"+pkg.name);
  }
  // Fixed source catalogue selects every chmod; no caller/environment path can
  // redirect this PUBLIC producer into auth or another installed package.
  for(const row of review.files) {
    const path=capsule+"/"+row.path; ancestry(path);const stat=lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && stat.nlink===1 && stat.size===row.size);
    chmodSync(path,row.mode);assert.equal(lstatSync(path).mode & 0o7777,row.mode);
  }
  assertRetainedCurrentFullParent(parent);
  return Object.freeze({version:"0.160.1",publicFiles:49,reviewReference:review.reviewReference});
}
