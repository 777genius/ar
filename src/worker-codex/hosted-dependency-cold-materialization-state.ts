import type { HostedDependencyColdInstallerCapture, HostedDependencyInstallerPhysicalFrame } from "./hosted-dependency-installer";
import type { DependencyAttempt, DependencyReceipt } from "@vioxen/subscription-runtime/worker-core";
import { DependencyReceiptState, DependencyTreeObservationStatus } from "@vioxen/subscription-runtime/worker-core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import type { DependencyCapturedTreeObservation } from "../worker-core/dependency-environment/domain/dependency-tree-manifest";
import type { DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import type { DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import type { DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { OriginalHostedDependencyColdHandoff } from "./hosted-dependency-cold-handoff-view";

export enum HostedDependencyColdPhase { Producing = "producing", Published = "published", Consumed = "consumed", Closed = "closed", Held = "held" }
export type HostedDependencyColdReady = Extract<DependencyReceipt,{state:DependencyReceiptState.Ready}>;
export type HostedDependencyColdObservation = Extract<DependencyCapturedTreeObservation,{status:DependencyTreeObservationStatus.Complete}>;
/** Facts owned by the original-origin map. This type and the physical result
 * neither register a phase nor authenticate an observation supplied by callers. */
export type HostedDependencyColdResult = Readonly<{
  inputs:HostedDependencyKeyInputs; ready:HostedDependencyColdReady; observed:HostedDependencyColdObservation;
  reference:DependencyProtectedReference; installerMapping:Buffer;
  source?:DependencySourceLinkSession; exposure:DependencySourceExposure;
}>;
export enum HostedDependencyColdInstallerPhase { Capturing="capturing", Prepared="prepared", Released="released", Waited="waited", Held="held" }
export type HostedDependencyColdState = {
  phase:HostedDependencyColdPhase; binding:HostedDependencyBinding; attempt:DependencyAttempt;
  handle?:OriginalHostedDependencyColdHandoff; result?:HostedDependencyColdResult;
  installerPhase?:HostedDependencyColdInstallerPhase;installerCapture?:HostedDependencyColdInstallerCapture;installerFrame?:HostedDependencyInstallerPhysicalFrame;
};
