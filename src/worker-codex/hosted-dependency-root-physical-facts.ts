import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import type { HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
function denied(): never { throw new Error("hosted_dependency_root_descriptor_denied"); }
/** Factual identity probes and close only. No source opener, purpose, map,
 * registration or authority transition exists in this module. */
export function readHostedDependencyRootDirectoryPin(path: string): HostedDependencyRootDirectoryPin {
  if (path !== "/" && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.exec(path)?.[0] !== path ||
      path.split("/").some(p => p === "." || p === "..")) invalid();
  const parents: {path:string;stat:BigIntStats}[] = [];
  for (let p = path;; p = dirname(p)) {
    const stat = lstatSync(p,{bigint:true});
    if (!stat.isDirectory() || (p !== path && (stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n)))) invalid();
    parents.push({path:p,stat}); if (p === "/") break;
  }
  const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd,{bigint:true}), named = parents[0]!.stat;
    if (stat.dev !== named.dev || stat.ino !== named.ino || stat.mode !== named.mode) invalid();
    const info = readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
    if (info.length > 16384) invalid(); const match = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
    if (match.length !== 1 || !match[0]?.[1]) invalid();
    for (const parent of parents) { const now = lstatSync(parent.path,{bigint:true});
      if (now.dev !== parent.stat.dev || now.ino !== parent.stat.ino || now.uid !== parent.stat.uid || now.gid !== parent.stat.gid || now.mode !== parent.stat.mode) invalid(); }
    return Object.freeze({canonicalPath:path,dev:String(stat.dev),ino:String(stat.ino),mountId:match[0][1]});
  } finally { closeSync(fd); }
}
export function rootDescriptorPhysicalInfo(fd: number) {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
  if (text.length > 4096) denied();
  const flags = [...text.matchAll(/^flags:\s+([0-7]{1,12})$/gm)], mounts = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (flags.length !== 1 || mounts.length !== 1) denied();
  const value = Number.parseInt(flags[0]![1]!,8);
  if (!Number.isSafeInteger(value) || (value & 3) || !(value & 0o2000000) || (value & 0o10000000)) denied();
  return {flags:value,mountId:mounts[0]![1]!};
}
export function sameRootDescriptorDirectory(a: BigIntStats, b: BigIntStats) {
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino &&
    a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
export function sameRootDescriptorFile(a: BigIntStats, b: BigIntStats) {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Retained nofollow traversal. Every ancestor remains open until the selected
 * leaf is pinned. This function returns facts only; the sole origin map owns
 * the later association, and unrelated raw opens never enter that map. */
export function assertHostedDependencyRootDescriptorMaterial(material: HostedDependencyRootDescriptorMaterial): void {
  if (material.closed) denied();
  const opened = fstatSync(material.fd,{bigint:true}), named = lstatSync(material.path,{bigint:true}), current = rootDescriptorPhysicalInfo(material.fd);
  if (!(material.directory ? sameRootDescriptorDirectory(material.stat,opened)&&sameRootDescriptorDirectory(opened,named):sameRootDescriptorFile(material.stat,opened)&&sameRootDescriptorFile(opened,named)) ||
      current.flags !== material.flags || current.mountId !== material.mountId || readlinkSync(`/proc/self/fd/${material.fd}`) !== material.path ||
      realpathSync(material.path) !== material.path) denied();
  for (const anchor of [...material.ancestors,...material.dependencies]) {
    const current = rootDescriptorPhysicalInfo(anchor.fd);
    if (!sameRootDescriptorDirectory(anchor.stat,fstatSync(anchor.fd,{bigint:true})) || !sameRootDescriptorDirectory(anchor.stat,lstatSync(anchor.path,{bigint:true})) ||
        current.flags !== anchor.flags || current.mountId !== anchor.mountId || readlinkSync(`/proc/self/fd/${anchor.fd}`) !== anchor.path ||
        realpathSync(`/proc/self/fd/${anchor.fd}`) !== anchor.path) denied();
  }
}


export function closePhysicalHostedDependencyRootDescriptor(material: HostedDependencyRootDescriptorMaterial): void {
      const handles = [...material.ancestors,...material.dependencies,material];
      for (const handle of handles) {
        const actual = fstatSync(handle.fd,{bigint:true}), pin = handle.stat;
        const text = readFileSync(`/proc/self/fdinfo/${handle.fd}`,"utf8");
        const flags = /^flags:\s+([0-7]{1,12})$/m.exec(text), mount = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(text);
        if (text.length > 4096 || actual.dev !== pin.dev || actual.ino !== pin.ino || actual.mode !== pin.mode || actual.uid !== pin.uid || actual.gid !== pin.gid ||
            readlinkSync(`/proc/self/fd/${handle.fd}`) !== handle.path || !flags || !mount ||
            Number.parseInt(flags[1]!,8) !== handle.flags || mount[1] !== handle.mountId) invalid();
      }
      // A revoked resource can still close its own physically authenticated
      // private handles. This cleanup grants no read, path, scope or new origin.
      for (const handle of handles.reverse()) closeSync(handle.fd);
}
export function sameRootDescriptorStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function assertHostedDependencyRootDirectoryPinFacts(pin:HostedDependencyRootDirectoryPin):void {
  if (!pin || Object.keys(pin).sort().join(",") !== "canonicalPath,dev,ino,mountId" ||
      JSON.stringify(readHostedDependencyRootDirectoryPin(pin.canonicalPath)) !== JSON.stringify(pin)) invalid();
}
