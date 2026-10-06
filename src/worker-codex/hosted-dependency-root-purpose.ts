/** One genuine provider-owned origin map retains all purpose provenance.
 * This worker facade has no context registry, state setter or issuing DTO.
 */
export { HostedDependencyRootPurpose, isHostedDependencySignedTaskId, captureCurrentHostedDependencyRootPurpose,
  HostedDependencyRootDescriptorRecipe, openCurrentHostedDependencyRootDescriptor, type HostedDependencyRootDescriptor,
  assertCurrentHostedDependencyRootPurpose, assertCurrentHostedDependencyRetiredReady, retireCurrentHostedDependencySourceCleanup,
  type HostedDependencyRootPurposeContext, type HostedDependencyManagedGitScope,
  type HostedDependencyRootScope, type HostedDependencyRootDirectoryPin,
} from "../provider-codex/app-server/adapters/hosted-current-dependency-origin";
