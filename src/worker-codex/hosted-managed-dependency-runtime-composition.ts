import { createLocalFileBackendRuntimeAdapters } from "../store-local-file/session-custody/application/local-file-backend-adapters";
import { createFixedCodexAgentDriver } from "./file-backend-codex-agent-driver-factory";
import { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
import { CodexJsonAgentDriver } from "../provider-codex/codex-json-agent-driver";
import type { RedactorPort } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { prepareOriginalHostedSessionRuntimeFacts } from "./hosted-managed-dependency-runtime-recipe-facts";
import { readCurrentHostedManagedDependencyProviderParent,assertOriginalHostedSessionRuntimeCompositionAccess,type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
/** Fixed configured composition only. Actual original context/signed recipe
 * precede directory/store IO. No supplied StorePort/driver constructor or map
 * registration exists; accounting is retained by the ONE original issuer. */
export type OriginalHostedSessionRuntimeCompositionInput = Omit<Parameters<typeof createFixedCodexAgentDriver>[0],"managedSession"|"managedRunStore"> & {readonly redactor:RedactorPort};
export function createOriginalHostedSessionRuntimeComposition(context:CurrentHostedDependencyOrigin,
  input:OriginalHostedSessionRuntimeCompositionInput,access:symbol) {
  assertOriginalHostedSessionRuntimeCompositionAccess(context,access);
  const state=withHostedActivationFence(fence=>{
    readCurrentHostedManagedDependencyProviderParent(context,fence);
    const selected=prepareOriginalHostedSessionRuntimeFacts(context,fence,input.options);
    readCurrentHostedManagedDependencyProviderParent(context,fence);return selected;
  });
  const physical=createLocalFileBackendRuntimeAdapters({providerId:"codex",rootDir:state.root+"/sessions",
    encryptionKey:input.options.encryptionKey,metadata:{adapter:"file-backend-codex-worker"}});
  const managedRunStore=new LocalFileManagedRunStore(state.root+"/managed-runs",input.redactor);
  const materializer=new HostedManagedDependencySessionMaterializer(context);
  const driver=createFixedCodexAgentDriver({...input,managedRunStore,managedSession:materializer});
  if (!(driver instanceof CodexJsonAgentDriver)) invalid();Object.freeze(driver);
  withHostedActivationFence(fence=>{readCurrentHostedManagedDependencyProviderParent(context,fence);});
  return {...state,physical,managedRunStore,materializer,driver};
}
