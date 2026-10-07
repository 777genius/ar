/** Finite ROOT-staged TEST input, consumed inside an existing managed outer. */
import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { assertConfiguredAccountName } from "./current-configured-auth-mount.js";
import { command, fileDigest } from "./common.ts";
function ancestry(path:string) {for(let p=path;;p=dirname(p)){const s=lstatSync(p);assert(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && !(s.mode&0o022));assert.equal(realpathSync(p),p);if(p==="/")break;}}
/** No transport/bootstrap is created. Manifest presence is not managed ingress
 * availability; ROOT must separately authenticate the actual managed job/unit. */
export function readCurrentFullOuterInput() {
  assert.equal(process.platform,"linux");assert.equal(process.getuid?.(),0);assert.equal(process.geteuid?.(),0);assert.equal(process.arch,"x64");
  assert.equal(process.version,"v22.23.3","TEST original pinned Node toolchain required");
  const bytes=readHostedPrivateBytes("/run/TEST-full-outer-review/input.json",4096);assert(bytes);
  const v:unknown=JSON.parse(bytes.toString("utf8"));assert(isDependencyCustodyObject(v,"accountName,nodeSha256,reviewReference,schemaVersion,sourceSha") && v.schemaVersion===1);
  assert(Buffer.from(JSON.stringify(v)+"\n").equals(bytes));assert(typeof v.sourceSha==="string" && /^[a-f0-9]{40}$/.test(v.sourceSha));
  assert.equal(v.sourceSha,process.env.TEST_SOURCE_SHA);assert(typeof v.accountName==="string");assertConfiguredAccountName(v.accountName);
  assert(typeof v.nodeSha256==="string" && /^[a-f0-9]{64}$/.test(v.nodeSha256));
  assert(typeof v.reviewReference==="string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(v.reviewReference));
  const input="/var/lib/subscription-runtime-full-TEST-input/"+v.sourceSha,source=input+"/source",toolchain=input+"/toolchain";
  ancestry(source);ancestry(toolchain);ancestry(toolchain+"/bin");
  const executable=toolchain+"/bin/node";assert.equal(realpathSync(process.execPath),executable);assert.equal(realpathSync(executable),executable);
  const fd=openSync(executable,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const s=fstatSync(fd),named=lstatSync(executable);assert(s.isFile() && s.uid===0 && s.gid===0 && s.nlink===1 && !(s.mode&0o022));
    assert.equal(s.dev,named.dev);assert.equal(s.ino,named.ino);assert.equal(fileDigest(executable),v.nodeSha256);
    const after=fstatSync(fd);for(const key of ["dev","ino","size","mtimeMs","ctimeMs"] as const)assert.equal(after[key],s[key]);
  }finally{closeSync(fd);}
  assert.equal(command("/usr/bin/git",["-C",source,"rev-parse","--verify","HEAD"]).trim(),v.sourceSha);
  assert.equal(command("/usr/bin/git",["-C",source,"status","--porcelain","--untracked-files=no"]),"");
  for(const path of [source+"/dist/worker-codex/codex-goal-cli.js",source+"/scripts/dependency-retention-os-test/current-full-guest.js"]) {
    const s=lstatSync(path);assert(s.isFile() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && s.nlink===1 && !(s.mode&0o022));assert.equal(realpathSync(path),path);
  }
  return Object.freeze({source,toolchain,sourceSha:v.sourceSha,accountName:v.accountName,reviewReference:v.reviewReference});
}
