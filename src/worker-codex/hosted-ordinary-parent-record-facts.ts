import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyBindingName } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyRootDirectoryPin, rootDescriptorPhysicalInfo } from "./hosted-dependency-root-physical-facts";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex"),encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function held():never {throw new Error("hosted_ordinary_reader_completion_held");}
export enum HostedOrdinaryParentRecordKind { Start="start", Producer="producer", Completion="completion", AttemptFence="attempt_fence", ZeroCompletion="zero_completion", Binding="binding" }
/** Closed factual recipes only. No arbitrary path, max bytes, flags, pin,
 * callback or descriptor association can be supplied by a caller. */
export function readHostedOrdinaryParentRecord(fence:HostedActivationFence,kind:HostedOrdinaryParentRecordKind,identity:string) {
  assertHostedActivationFence(fence);assertHostedActivationOperator();
  if (typeof identity!=="string" || identity.length<1 || identity.length>128 || /^[A-Za-z0-9_@.-]+$/.exec(identity)?.[0]!==identity) held();
  if (kind===HostedOrdinaryParentRecordKind.Binding) return fixedPin(`/var/lib/subscription-runtime-host-policy/${hostedDependencyBindingName(identity)}`);
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(identity)?.[0]!==identity) held();
  let directory:string;
  switch (kind) {
    case HostedOrdinaryParentRecordKind.Start:directory="ordinary-starts";break;
    case HostedOrdinaryParentRecordKind.Producer:directory="dependency-reader-starts";break;
    case HostedOrdinaryParentRecordKind.Completion:directory="dependency-ordinary-reader-completions";break;
    case HostedOrdinaryParentRecordKind.AttemptFence:directory="dependency-attempt-fences";break;
    case HostedOrdinaryParentRecordKind.ZeroCompletion:directory="ordinary-completed";break;
    default:return held();
  }
  return fixedPin(`/var/lib/subscription-runtime-host-policy/${directory}/${identity}.json`);
}
function sameFile(a: BigIntStats,b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Paths come only from fixed local recipes below, never an exported opener. */
function fixedPin(path: string, maximum = 16384) {
  const parts = path.split("/").filter(Boolean); if (parts.length < 2 || parts.length > 128) held();
  const directories: {path:string;fd:number;stat:BigIntStats;mountId:string;flags:number}[] = [], openedDirectories: number[] = []; let fd: number | undefined;
  try {
    let parent = "/";
    for (let i = 0; i < parts.length; i++) {
      const selected = i === 0 ? "/" : `/proc/self/fd/${directories[i-1]!.fd}/${parts[i-1]}`;
      const directoryFd = openSync(selected,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      openedDirectories.push(directoryFd);
      const stat = fstatSync(directoryFd,{bigint:true}),physical=rootDescriptorPhysicalInfo(directoryFd);
      directories.push({path:parent,fd:directoryFd,stat,...physical});
      if (!stat.isDirectory() || stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n) ||
          (i === parts.length-1 && (stat.mode & 0o7777n) !== 0o700n)) held();
      parent = parent === "/" ? "/"+parts[i] : parent+"/"+parts[i];
    }
    const leaf = directories.at(-1)!;
    fd = openSync(`/proc/self/fd/${leaf.fd}/${parts.at(-1)!}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before = fstatSync(fd,{bigint:true}),leafPhysical=rootDescriptorPhysicalInfo(fd);
    if (leafPhysical.mountId!==leaf.mountId) held();
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n ||
        (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maximum)) held();
    const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    if (!encode(rootDescriptorPhysicalInfo(fd)).equals(encode(leafPhysical)) || BigInt(length) !== before.size || !sameFile(before,fstatSync(fd,{bigint:true})) || !sameFile(before,lstatSync(path,{bigint:true}))) held();
    for (const directory of directories) {
      const current = lstatSync(directory.path,{bigint:true}), retained = fstatSync(directory.fd,{bigint:true});
      const physical=rootDescriptorPhysicalInfo(directory.fd),named=readHostedDependencyRootDirectoryPin(directory.path);
      if (physical.flags!==directory.flags || physical.mountId!==directory.mountId || named.mountId!==directory.mountId) held();
      if (!current.isDirectory() || [current,retained].some(stat => stat.dev !== directory.stat.dev || stat.ino !== directory.stat.ino ||
          stat.uid !== directory.stat.uid || stat.gid !== directory.stat.gid || stat.mode !== directory.stat.mode)) held();
    }
    return {bytes:bytes.subarray(0,length),reference:{path,identity:{dev:String(before.dev),ino:String(before.ino)},sha256:hash(bytes.subarray(0,length))}};
  } finally {
    let failure: unknown;
    for (const retained of [...(fd === undefined ? [] : [fd]),...openedDirectories.reverse()]) {
      try { closeSync(retained); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}
