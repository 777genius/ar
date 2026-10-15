import { readOriginalHostedManagedProviderBirthFacts, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, fsyncSync, openSync, readSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { sameRootDescriptorStat as sameStat, readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
const root = "/var/lib/subscription-runtime-host-policy";
const hash = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)+"\n");
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
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
/** Publishes only the existing supervisor's actual reserved provider. */
export function publishCurrentHostedManagedDependencyProvider(context: CurrentHostedDependencyOrigin,
  fence: HostedActivationFence, unit: string): void {
  const before = readOriginalHostedManagedProviderBirthFacts(context,fence,unit), directory = `${root}/dependency-managed-provider-starts`;
  try { mkdirSync(directory,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const parent = readHostedDependencyRootDirectoryPin(directory), protectedRoot = readHostedDependencyRootDirectoryPin(root), stat = lstatSync(directory);
  if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700 ||
      parent.dev !== protectedRoot.dev || parent.mountId !== protectedRoot.mountId) invalid();
  const path = `${directory}/${before.providerStartId}.json`, bytes = encode(before);
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  // Every temporary publication FD has closed before the actual collector.
  const after = readOriginalHostedManagedProviderBirthFacts(context,fence,unit);
  if (!encode(after).equals(bytes) || !selectedFile(path,16384).bytes.equals(bytes) ||
      !encode(readHostedDependencyRootDirectoryPin(directory)).equals(encode(parent))) invalid();
}
