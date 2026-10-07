import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import type { DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { sameRootDescriptorStat as sameStat } from "./hosted-dependency-root-physical-facts";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
/** Fixed caller composition owns current origin/fence selection before this
 * factual reader. Private original-module access is checked before path IO;
 * no public path/opener/descriptor grant or raw context is accepted. */
export function readOriginalHostedDependencyPinnedRecord(access:symbol,path: string, maximum: number, privateFile = true) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
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
