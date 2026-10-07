import type { DependencyAttempt } from "@vioxen/subscription-runtime/core";
import { decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { dependencyToolAdmittedGuestConfig, parseDependencyToolAdmissionQualification } from "../core/dependency-environment/dependency-tool-execution";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { hostedCodexExecutableReadPath } from "../provider-codex/hosted-codex-permissions";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { managedDependencyHomeConfig } from "./hosted-managed-dependency-home-config";
function invalid():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
// Fixed path/config facts only, with no home context, state transition, raw writer or registration.
export function formManagedDependencyHomePreparationFacts(bytes:Buffer,jobRootDir:string,attempt:DependencyAttempt,
  profile:CodexProviderEgressProfileId.TestManagedQualification|CodexProviderEgressProfileId.TestNpmQualification=CodexProviderEgressProfileId.TestManagedQualification) {
  if (profile!==CodexProviderEgressProfileId.TestManagedQualification && profile!==CodexProviderEgressProfileId.TestNpmQualification) invalid();
  const policy = codexProviderEgressPolicy(profile);
  const executable = hostedCodexExecutableReadPath({codexBinaryPath:"codex",sourceEnv:process.env}); if (!executable) invalid();
  const configBytes = managedDependencyHomeConfig(policy,executable,dependencyToolAdmittedGuestConfig(parseDependencyToolAdmissionQualification(decodeHostedActivationBytes(bytes))));
  return Object.freeze({jobRoot:readHostedDependencyRootDirectoryPin(jobRootDir),
    rootPath:jobRootDir+"/home/codex-session-cache/dependency-"+attempt.attemptId,configBytes,attempt:attempt});
}
