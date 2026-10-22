import { closeSync, constants, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { sameDependencyAttempt, sameDependencyProtectedReference, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertCurrentHostedDependencySessionAuthWritable, assertOriginalHostedDependencySessionHomeIdentity, type CurrentHostedDependencySessionHome } from "./hosted-current-dependency-origin";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Auth IO only after and before actual original-map assertions. No caller path,
 * scope facts, descriptor flags, callback or independent registration edge. */
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function selectedFile(path: string, maximum: number, privateFile = true) {
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) || path.split("/").some(p => p === "." || p === "..")) invalid();
  const ancestors: { path: string; stat: BigIntStats }[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const stat = lstatSync(p, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) ||
        (privateFile && p === dirname(path) && (stat.mode & 0o077n))) invalid();
    ancestors.push({ path: p, stat }); if (p === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & (privateFile ? 0o077n : 0o022n)) ||
        before.size < 1n || before.size > BigInt(maximum) || !sameStat(before,entry)) invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true})) || !sameStat(before,lstatSync(path,{bigint:true}))) invalid();
    for (const p of ancestors) { const now = lstatSync(p.path,{bigint:true});
      if (!now.isDirectory() || now.dev !== p.stat.dev || now.ino !== p.stat.ino || now.uid !== p.stat.uid || now.mode !== p.stat.mode) invalid(); }
    const data = bytes.subarray(0,length), reference: DependencyProtectedReference = { path,
      identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(data) };
    return { bytes:data, reference };
  } finally { closeSync(fd); }
}
/** Synchronous bounded writer closes its FD before every actual collector. */
export function writeOriginalHostedDependencySessionAuth(home: CurrentHostedDependencySessionHome, authJson: string): void {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  withHostedActivationFence(fence => {
    const held = assertCurrentHostedDependencySessionAuthWritable(home,fence);
    if (typeof authJson !== "string" || Buffer.byteLength(authJson)>1024*1024 ||
        !authJson.length || Buffer.from(authJson).toString("utf8") !== authJson) invalid();
    const path = held.codexHome+"/auth.json";
    let prior: BigIntStats | undefined;
    try { prior = lstatSync(path,{bigint:true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior && (!prior.isFile() || prior.uid !== 0n || prior.gid !== 0n || prior.nlink !== 1n || (prior.mode & 0o7777n) !== 0o600n)) invalid();
    const fd = openSync(path,constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|
      (prior ? 0 : constants.O_CREAT|constants.O_EXCL),0o600);
    try {
      const before = fstatSync(fd,{bigint:true});
      if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o600n ||
          prior && !sameStat(before,prior)) invalid();
      // Existing auth is rewritten only while this same origin owns an exclusive
      // home lease and has no actual retained provider; there is no generic cache
      // callback that may release a warm account slot early.
      ftruncateSync(fd,0); writeFileSync(fd,authJson); fsyncSync(fd);
      const after = fstatSync(fd,{bigint:true}), named = lstatSync(path,{bigint:true});
      if (!sameStat(after,named) || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode ||
          after.nlink !== 1n || after.uid !== 0n || after.gid !== 0n || after.size !== BigInt(Buffer.byteLength(authJson))) invalid();
    } finally { closeSync(fd); }
    const after = assertCurrentHostedDependencySessionAuthWritable(home,fence);
    if (after.codexHome !== held.codexHome || !sameDependencyAttempt(after.attempt,held.attempt)) invalid();
  });
}

export function snapshotOriginalHostedDependencySessionAuth(home:CurrentHostedDependencySessionHome):string {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  return withHostedActivationFence(fence => snapshotOriginalHostedDependencySessionAuthWithHeldFence(home,fence));
}
/** Same fixed reader, when the producer already owns the common fence. */
export function snapshotOriginalHostedDependencySessionAuthWithHeldFence(home:CurrentHostedDependencySessionHome,fence:HostedActivationFence):string {
  assertOriginalHostedDependencySessionHomeIdentity(home);
  const held = assertCurrentHostedDependencySessionAuthWritable(home,fence);
  const selected = selectedFile(held.codexHome+"/auth.json",1024*1024), authJson = new TextDecoder("utf-8",{fatal:true}).decode(selected.bytes);
  const after = assertCurrentHostedDependencySessionAuthWritable(home,fence), reread = selectedFile(held.codexHome+"/auth.json",1024*1024);
  if (after.codexHome !== held.codexHome || !sameDependencyProtectedReference(reread.reference,selected.reference) || !reread.bytes.equals(selected.bytes)) invalid();
  return authJson;
}
