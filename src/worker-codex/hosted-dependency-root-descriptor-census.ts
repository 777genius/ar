import { fstatSync,readdirSync } from "node:fs";
import type { RootPurposeState } from "./hosted-managed-dependency-session-state";
import { assertHostedDependencyRootDescriptorMaterial } from "./hosted-dependency-root-physical-facts";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
function invalid():never{throw new Error("hosted_dependency_current_origin_unresolved");}
export function assertOriginalHostedDependencyRootDescriptorCensus(state:RootPurposeState,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  if (state.descriptors.size > 256) invalid();
  for (const material of state.descriptors.values()) assertHostedDependencyRootDescriptorMaterial(material);
  for (const fd of [0,1,2]) { const stat = fstatSync(fd); if (!stat.isFIFO() && !stat.isSocket()) invalid(); }
  const names = readdirSync("/proc/self/fd"); if (names.length > 512) invalid();
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) invalid(); const fd = Number(name); if (fd <= 2) continue;
    try {
      const stat = fstatSync(fd); if (!stat.isFile() && !stat.isDirectory()) continue;
      const associated = [...state.descriptors.values()].find(material => material.fd === fd ||
        [...material.ancestors,...material.dependencies].some(anchor => anchor.fd === fd));
      if (!associated) invalid(); assertHostedDependencyRootDescriptorMaterial(associated);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
  }
}
