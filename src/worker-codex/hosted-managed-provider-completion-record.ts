import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { sameDependencyAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readOriginalHostedManagedProviderWaitFacts, readCurrentHostedManagedDependencyProviderParent, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readHostedDependencyRootDirectoryPin, sameRootDescriptorStat as sameStat } from "./hosted-dependency-root-physical-facts";
import { collectHostedManagedProviderDrain } from "./hosted-managed-provider-drain-observation";
import { matchesManagedProviderProxyWait } from "./hosted-managed-provider-terminal-facts";
import { completionPath, completionBytes } from "./hosted-readonly-host-kernel";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
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
// Fixed genuine context/unit reader -> actual drain -> fixed receipt. No caller wait/terminal facts or epoch publication.
export function publishOriginalHostedManagedProviderCompletion(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string) {
  const selected = readOriginalHostedManagedProviderWaitFacts(context,fence,unit), parent = selected.parent;
  try { lstatSync(`/proc/${selected.pid}`); invalid(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const reservation = parent.facts.epoch.reservations.find(row => row.unit === unit);
  if (!reservation || reservation.startId !== unit.slice("subscription-runtime-hosted-".length,-".service".length) || reservation.creatorId !== reservation.startId) invalid();
  const terminal = collectHostedManagedProviderDrain(unit);
  if (!matchesManagedProviderProxyWait(terminal,selected.invocationId,selected.waitStatus)) invalid();
  const after = readOriginalHostedManagedProviderWaitFacts(context,fence,unit);
  if (!encode(selected).equals(encode(after))) invalid();
  const completion = encode({schemaVersion:1,parentAttempt:parent.attempt,unit,providerStartId:reservation.startId,
    providerReference:selected.reference,invocationId:selected.invocationId,proxyBirth:selected.birth,waitStatus:selected.waitStatus,terminal:terminal ?? null});
  const directory = root+"/dependency-managed-provider-completions";
  try { mkdirSync(directory,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const pin = readHostedDependencyRootDirectoryPin(directory), protectedRoot = readHostedDependencyRootDirectoryPin(root), stat = lstatSync(directory);
  if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700 || pin.dev !== protectedRoot.dev || pin.mountId !== protectedRoot.mountId) invalid();
  const path = `${directory}/${reservation.startId}.json`; createReadonlyPrivateRecord(path,completion);
  if (selected.waitStatus === 0) createReadonlyPrivateRecord(completionPath(reservation),completionBytes(reservation,0));
  if (!selectedFile(path,16384).bytes.equals(completion)) invalid();
  const current = readCurrentHostedManagedDependencyProviderParent(context,fence);
  if (!sameDependencyAttempt(current.attempt,parent.attempt) || !encode(current.facts.epoch).equals(encode(after.parent.facts.epoch))) invalid();
  return {parent:current,reservation};
}
