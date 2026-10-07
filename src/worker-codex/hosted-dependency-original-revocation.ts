import { assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import type { OriginalHostedDependencyOriginEntry } from "./hosted-dependency-origin-entry";
import { revokeOriginalHostedDependencyColdState } from "./hosted-dependency-cold-controller";
import { hostedFdLaunch } from "../provider-codex/app-server/adapters/hosted-fd-launch";
/** Cleanup never retains authority. The original map deletes its entry even
 * if any real gate or descriptor close fails. No receiver/input grant escapes. */
export function revokeOriginalHostedDependencyOriginResources(context:CurrentHostedDependencyOrigin,retained:OriginalHostedDependencyOriginEntry|undefined,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);let failure:unknown;
  try {revokeOriginalHostedDependencyColdState(context,access);}catch(error){failure=error;}
  const provider=retained?.rootPurpose?.provider;
  if(provider?.child){provider.stopping=true;try{hostedFdLaunch(provider.child).invalidate();}catch(error){failure=error;}}
  for(const descriptor of [...(retained?.rootPurpose?.descriptors.keys()??[])]) {
    try{descriptor.close();}catch(error){failure??=error;}
  }
  if(failure!==undefined)throw failure;
}
