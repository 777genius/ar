import { fstatSync, readSync } from "node:fs";
import { sameRootDescriptorStat as sameStat } from "./hosted-dependency-root-physical-facts";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
function invalid():never{throw new Error("hosted_dependency_current_origin_unresolved");}
export function readOriginalHostedManagedProviderDescriptor(fd:number,access:symbol):Buffer {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  const before = fstatSync(fd,{bigint:true}); if (!before.isFile() || before.size < 1n || before.size > 16384n) invalid();
  const bytes = Buffer.alloc(Number(before.size)+1); let length = 0;
  while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
  if (BigInt(length) !== before.size || !sameStat(before,fstatSync(fd,{bigint:true}))) invalid(); return bytes.subarray(0,length);
}
