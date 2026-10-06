import type { HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import type { OriginalHostedDependencyRootPurpose as RootPurposeFacade } from "./hosted-dependency-root-purpose-view";
import type { OriginalHostedDependencyRootDescriptor as RootDescriptor } from "./hosted-dependency-root-resource-view";
import type { OriginalHostedDependencySessionHome as ManagedSessionHomeFacade } from "./hosted-managed-dependency-home-view";
import type { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import type { CurrentHostedDependencyOriginKind } from "./hosted-current-dependency-origin";
import type { LeaseStorePort, SessionStorePort, SessionExecutionUse, SessionExecutionLifecyclePort, SessionArtifact } from "@vioxen/subscription-runtime/core";
import type { CodexJsonAgentDriver } from "../provider-codex/codex-json-agent-driver";
import type { CodexMaterializedSession } from "../provider-codex/codex-json-execution-engine";
import type { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
import type { ChildProcess } from "node:child_process";
import type { CodexAppServerChildProcess } from "../provider-codex/app-server/application/app-server-process-port";
import type { DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { DependencyToolQualification } from "../core/dependency-environment/dependency-tool-profile";
import type { DependencyToolReadyFacts } from "../core/dependency-environment/dependency-tool-ready-reader";
import type { HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedDependencyRootPurpose } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedDependencyRootDescriptor, CurrentHostedDependencySessionHome } from "./hosted-current-dependency-origin";
/** Types only, no constructors, map, state lookup, mutation, callbacks or grants. */
export type ManagedProviderState = {
  readonly unit: string; readonly reference: DependencyProtectedReference; readonly root: HostedDependencyRootDirectoryPin;
  readonly qualification: DependencyToolQualification; readonly ready: DependencyToolReadyFacts;
  readonly record: HostedDependencyRootDescriptor; readonly capsule: HostedDependencyRootDescriptor; readonly capsulePath: string;
  invocation?: object; child?: ChildProcess; command?: string; args?: readonly string[];
  proxyPid?: number; proxyBirth?: string; proxyClosed?: boolean; proxyCode?: number | null; proxySignal?: NodeJS.Signals | null;
  modelProbe?: true; inputTail?: Promise<void>; inputBytes?: number; inputPending?:number; inputEnding?: true;
  executionUse?:ManagedSessionUseState;
  ordinaryTerminal?:import("./hosted-ordinary-provider-terminal-view").OriginalHostedOrdinaryProviderTerminal;
  ordinaryCompletion?:import("../core/scoped-termination-contract").ScopedProviderOnlyReceipt;
  facade?: CodexAppServerChildProcess; wait?: Promise<void>; invocationId?: string; spawnAttempted?: boolean; stopping?: true; home?: ManagedSessionHomeState;
};

export type ManagedSessionHomeState = {
  readonly facade: CurrentHostedDependencySessionHome; readonly root: HostedDependencyRootDirectoryPin;
  readonly home: HostedDependencyRootDirectoryPin; readonly codexHome: HostedDependencyRootDirectoryPin;
  readonly emptyWorkdir: HostedDependencyRootDirectoryPin; readonly config: DependencyProtectedReference; readonly configBytes: Buffer; leased: boolean; purpose: HostedDependencyRootPurpose.ManagedGitReadV1 | HostedDependencyRootPurpose.SessionRefreshV1;
};

export enum ManagedSessionModelCatalogEvidence { CatalogObservedCandidate = "catalog_observed_candidate" }
export enum ManagedSessionUsePhase { Begun = "begun", Preparing = "preparing", Active = "active", Released = "released", Complete = "complete" }
export type ManagedSessionUseState = {
  readonly handle: SessionExecutionUse; readonly unlock: () => void; phase: ManagedSessionUsePhase;
  home?: CurrentHostedDependencySessionHome; materialized?: CodexMaterializedSession; release?: Promise<void>;
  account?:string; restoredHash?:string; snapshot?:{readonly artifact:SessionArtifact;readonly hash:string}; writebackKey?:string; acquiring?: true; lease?: { readonly leaseId: string; readonly providerInstanceId: string; readonly restoredHash:string; terminal: boolean };
  modelCatalogObserved?: {readonly kind:ManagedSessionModelCatalogEvidence;readonly model:string;readonly authSha256:string;readonly profile:DependencyProtectedReference;readonly executable:DependencyProtectedReference};
  credentialUnknown?: true; writing?: true; writeStatus?: "accepted" | "idempotent_replay" | "stale_generation";
};
export type ManagedSessionRuntimeState = {
  readonly originKind:CurrentHostedDependencyOriginKind;
  readonly lifecycle: SessionExecutionLifecyclePort; readonly driver: CodexJsonAgentDriver;
  readonly materializer: HostedManagedDependencySessionMaterializer;
  readonly sessionStore: SessionStorePort; readonly leaseStore: LeaseStorePort;
  idleWrites: number; readonly model: string; readonly stateRoot:HostedDependencyRootDirectoryPin; readonly sessionRoot:HostedDependencyRootDirectoryPin;
  readonly sessionReads:WeakMap<SessionArtifact,{readonly account:string;readonly hash:string}>; tail: Promise<void>; use?: ManagedSessionUseState; retired?: ManagedSessionUseState;
};

export type RootPurposeState = {
  readonly record: HostedDependencyRootPreparationRecord; readonly reference: DependencyProtectedReference;
  readonly ready: ReturnType<LocalDependencyReceiptStore["getCommittedReady"]>;
  readonly managed: RootPurposeFacade; cleanup?: RootPurposeFacade; refresh?: RootPurposeFacade;
  readonly descriptors: Map<RootDescriptor, HostedDependencyRootDescriptorMaterial>;
  provider?: ManagedProviderState; sessionHome?: ManagedSessionHomeState; sessionCache?: ManagedSessionHomeState; preparingHome?: ManagedSessionHomeFacade; sessionRuntime?: ManagedSessionRuntimeState;
};
