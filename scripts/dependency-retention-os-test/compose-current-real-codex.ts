/** Separate FULL-cohort PUBLIC input copy; does not touch the CLOSED composer. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, realpathSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { readOriginalFullParentPaths, originalFullParentGuestRoot, assertRetainedCurrentFullParent } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { currentCodexPublicFiles } from "./current-codex-public-catalog.js";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { runtime } from "./common.ts";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function directory(path: string): void {
  const s = lstatSync(path); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022));
  assert.equal(realpathSync(path), path);
}
function ancestry(path: string): void { for (let p = dirname(path);; p = dirname(p)) { directory(p); if (p === "/") break; } }
function absent(path: string): void {
  assert.throws(() => lstatSync(path), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
}
/** Public package layout DATA only; Node alias resolution stays inside the
 * already granted frontend packageRoot. This selects no permission or source IO. */
export function currentCodexPublicRelativeDestination(relative: string): string {
  assert(/^(?:codex|codex-linux-x64)\/(?:[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\/)*[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/.test(relative));
  assert(relative.length <= 512 && !relative.split("/").some(part => part === "." || part === ".."));
  return relative.startsWith("codex-linux-x64/") ? "codex/node_modules/@openai/" + relative : relative;
}
/** Independently installed ROOT public input review, not a policy/grant issuer. */
export function readCurrentReviewedPublicCodex(parent:object,sourceSha: string) {
  const reviewPath=readOriginalFullParentPaths(parent).publicReviewRoot+"/input.json";
  assert(/^[a-f0-9]{40}$/.test(sourceSha));
  const review = readHostedPrivateBytes(reviewPath, 1024 * 1024); assert(review);
  const v: unknown = JSON.parse(review.toString("utf8"));
  assert(isDependencyCustodyObject(v, "files,reviewReference,schemaVersion,sourceSha"));
  assert.equal(v.schemaVersion, 1); assert.equal(v.sourceSha, sourceSha);
  assert(typeof v.reviewReference === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(v.reviewReference));
  assert(Array.isArray(v.files) && v.files.length === 49);
  assert.equal(review.toString("utf8"), JSON.stringify(v) + "\n");
  assert.deepEqual(v.files,currentCodexPublicFiles); // Exact SOURCE-pinned PUBLIC tree before capsule IO.
  assertRetainedCurrentFullParent(parent);
  return Object.freeze({reviewReference:v.reviewReference,files:currentCodexPublicFiles});
}
/** Consume only a separately attested exact PUBLIC package-file catalog. The
 * capsule producer must pin the actual configured command's official package
 * and Linux native platform dependency. This function cannot issue that review. */
export function composeCurrentRealCodex(parent:object,root: string, sourceSha: string): void {
  const {fullNativePublicCapsule:capsule}=readOriginalFullParentPaths(parent);
  assert.equal(process.getuid?.(), 0); assert.equal(process.geteuid?.(), 0);
  assert(originalFullParentGuestRoot(parent,basename(dirname(root)),root));
  directory(root); ancestry(root); assert(/^[a-f0-9]{40}$/.test(sourceSha));
  absent(root + "/var/lib/subscription-runtime-host-policy/host-installation.json");
  const v = readCurrentReviewedPublicCodex(parent,sourceSha);
  const files: {path:string;sha256:string;size:number;mode:number}[] = []; let total = 0;
  for (const row of v.files) {
    assert(isDependencyCustodyObject(row, "mode,path,sha256,size"));
    assert(typeof row.path === "string" && /^(?:codex|codex-linux-x64)\/(?:[A-Za-z0-9_+-][A-Za-z0-9_.+-]*\/)*[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/.test(row.path) && row.path.length <= 512);
    assert(typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256));
    assert(typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 289166920);
    assert(row.mode === 0o644 || row.mode === 0o755); total += row.size; assert(total <= 512 * 1024 * 1024);
    files.push({path:row.path,sha256:row.sha256,size:row.size,mode:row.mode});
  }
  assert.deepEqual(files.map(row => row.path), [...new Set(files.map(row => row.path))].sort());
  assert(files.some(row => row.path === "codex/package.json") && files.some(row => row.path === "codex/bin/codex.js"));
  assert(files.some(row => row.path.startsWith("codex-linux-x64/") && row.path === "codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" && row.mode === 0o755));
  directory(capsule); ancestry(capsule);
  const observed: string[] = [], pending = [""]; let directories = 0;
  while (pending.length) {
    const relative = pending.pop()!; assert(++directories <= 128 && pending.length <= 128 && observed.length <= 49);
    const parent = capsule + (relative ? "/" + relative : ""); directory(parent);
    const names = readdirSync(parent); assert(names.length <= 1024);
    for (const name of names) {
      const p = relative ? relative + "/" + name : name; assert(p.length <= 512);
      const s = lstatSync(capsule + "/" + p); assert(!s.isSymbolicLink());
      if (s.isDirectory()) { assert(files.some(row => row.path.startsWith(p + "/"))); pending.push(p); }
      else { assert(s.isFile()); assert(files.some(row => row.path === p)); observed.push(p); }
    }
  }
  assert.deepEqual(observed.sort(), files.map(row => row.path));
  const destination = root + runtime + "/toolchain/lib/node_modules/@openai";
  ancestry(destination); absent(destination); mkdirSync(destination, {mode:0o755});
  for (const row of files) {
    assertRetainedCurrentFullParent(parent);
    const relative = currentCodexPublicRelativeDestination(row.path);
    const from = capsule + "/" + row.path, to = destination + "/" + relative;
    ancestry(from); const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output: number | undefined;
    try {
      const before = fstatSync(input); assert(before.isFile() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022));
      assert.equal(before.size,row.size); assert.equal(before.mode & 0o7777,row.mode);
      mkdirSync(dirname(to),{recursive:true,mode:0o755}); ancestry(to);
      output = openSync(to,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,row.mode);
      fchmodSync(output,row.mode);
      const block = Buffer.alloc(65536), copied = createHash("sha256"); let length = 0;
      while (length < row.size) {
        const n = readSync(input,block,0,Math.min(block.length,row.size-length),length); assert(n > 0);
        copied.update(block.subarray(0,n)); let written = 0;
        while (written < n) { const amount = writeSync(output,block,written,n-written,length+written); assert(amount > 0); written += amount; }
        length += n;
      }
      assert.equal(readSync(input,block,0,1,row.size),0); assert.equal(copied.digest("hex"),row.sha256);
      for (const after of [fstatSync(input),lstatSync(from)]) for (const key of ["dev","ino","uid","gid","mode","nlink","size","ctimeMs","mtimeMs"] as const) assert.equal(after[key],before[key]);
      ancestry(from); fsyncSync(output);
      const copiedStat = fstatSync(output); assert.equal(copiedStat.size,row.size); assert.equal(copiedStat.mode & 0o7777,row.mode);
      assert.equal(copiedStat.uid,0); assert.equal(copiedStat.gid,0); assert.equal(copiedStat.nlink,1);
      const named = lstatSync(to); for (const key of ["dev","ino","uid","gid","mode","nlink","size"] as const) assert.equal(named[key],copiedStat[key]);
    } finally { if (output !== undefined) closeSync(output); closeSync(input); }
  }
  for (const path of [root+"/usr/local",root+"/usr/local/bin"]) { mkdirSync(path,{recursive:true,mode:0o755}); directory(path); }
  // Official frontend shebang uses env node. This fresh TEST alias selects the
  // SAME original pinned Node already mounted by the genuine provider Plan.
  const nodeAlias = root+"/usr/local/bin/node"; ancestry(nodeAlias); absent(nodeAlias);
  symlinkSync("../../../opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node",nodeAlias);
  assert.equal(realpathSync(nodeAlias),root+runtime+"/toolchain/bin/node");
  const frontend = root + "/usr/local/bin/codex"; ancestry(frontend); absent(frontend);
  symlinkSync("../../../opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/@openai/codex/bin/codex.js", frontend);
  assert.equal(realpathSync(frontend), destination + "/codex/bin/codex.js");
  assertRetainedCurrentFullParent(parent);
  const entry = files.find(row => row.path === "codex/bin/codex.js")!, metadata = files.find(row => row.path === "codex/package.json")!;
  const record = { executableSha256:entry.sha256, packageSha256:metadata.sha256, reviewReference:v.reviewReference, schemaVersion:1, sourceSha };
  const privateReviewRoot = root + "/run/TEST-real-codex-review"; ancestry(privateReviewRoot); absent(privateReviewRoot); mkdirSync(privateReviewRoot, {mode:0o700});
  const path = privateReviewRoot + "/input.json"; ancestry(path); absent(path);
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,JSON.stringify(record)+"\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
