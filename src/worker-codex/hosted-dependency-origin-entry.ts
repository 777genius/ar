import type { CurrentHostedDependencyOriginFacts } from "./hosted-current-dependency-origin";
import type { DependencyAttempt, DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedRetainedToolFiles } from "../provider-codex/app-server/adapters/hosted-retained-tool-files";
import type { RootPurposeState } from "./hosted-managed-dependency-session-state";
import type { HostedDependencyColdState } from "./hosted-dependency-cold-materialization-state";
import type { HostedDependencyWarmRetirementState } from "./hosted-dependency-warm-retirement-state";
import type { HostedDependencyGenerationState } from "./hosted-dependency-generation-state";
/** Types only. No map, issuer, constructor, registration or access dispatch. */
export type OriginalHostedDependencyOriginEntry = {
  digest:string;facts:CurrentHostedDependencyOriginFacts;scope?:HostedRetainedToolFiles;rootPurpose?:RootPurposeState;
  ordinaryEntry?:Readonly<{attempt:DependencyAttempt;producer:DependencyProtectedReference;entry:DependencyProtectedReference}>;
  ordinaryAdmitted?:boolean;cold?:HostedDependencyColdState;warmRetirement?:HostedDependencyWarmRetirementState;generation?:HostedDependencyGenerationState;
};
