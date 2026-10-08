import { isProxy } from "node:util/types";
import { copyBoundedHostedByteInput } from "./hosted-bounded-byte-input";
import { computeSessionGenerationHash, type RedactorPort, type SessionExecutionUse, type SessionArtifact, type SessionStorePort } from "@vioxen/subscription-runtime/core";
import { ManagedSessionUsePhase, type ManagedSessionUseState } from "./hosted-managed-dependency-session-state";
function invalid():never { throw new Error("hosted_dependency_session_artifact_denied"); }
/** Captured artifact data only. No identity registration, auth IO or home/use grant. */
export function captureManagedSessionArtifactFacts(artifact:SessionArtifact) {
  if (!artifact || isProxy(artifact) || Object.getPrototypeOf(artifact) !== Object.prototype && Object.getPrototypeOf(artifact) !== null) invalid();
  if (Object.getOwnPropertySymbols(artifact).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(artifact);
  const names = Object.keys(descriptors);
  if (names.some(name => !["kind","providerId","formatVersion","bytes","contentType","createdAt","updatedAt"].includes(name)) ||
      names.some(name => !("value" in descriptors[name]!)) || !["kind","providerId","formatVersion","bytes","contentType"].every(name => descriptors[name])) invalid();
  const data:Record<string,unknown> = Object.fromEntries(names.map(name => [name,descriptors[name]!.value]));
  if (data.kind !== "json-file" || data.providerId !== "codex" || typeof data.formatVersion !== "string" ||
      data.formatVersion.length > 128 || typeof data.contentType !== "string" || data.contentType.length > 256) invalid();
  const value:SessionArtifact = Object.freeze({kind:data.kind,providerId:data.providerId,formatVersion:data.formatVersion,contentType:data.contentType,bytes:copyBoundedHostedByteInput(data.bytes,1024*1024,1)});
  return {artifact:value,hash:computeSessionGenerationHash({artifact:value})};
}

/** Capture caller-visible request properties without running accessor/proxy callbacks. */
export function captureManagedSessionMaterializationInput(input:Readonly<{session:SessionArtifact;redactor:RedactorPort;sessionExecutionUse?:SessionExecutionUse}>) {
  if (!input || isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some(value => !("value" in value))) invalid();
  const session = descriptors.session?.value, redactor = descriptors.redactor?.value, use = descriptors.sessionExecutionUse?.value;
  if (!session || !redactor || !use) invalid();
  return Object.freeze({session,redactor,sessionExecutionUse:use});
}

/** Pure immutable write data. Genuine use/epoch/phase checks remain at the owner. */
export function captureManagedSessionWriteIntent(input:Parameters<SessionStorePort["write"]>[0], data:Readonly<Pick<ManagedSessionUseState,"account"|"snapshot"|"lease"|"pendingWrite">>) {
  if (data.account !== input.providerInstanceId || !data.snapshot || data.snapshot.artifact !== input.nextArtifact) writeDenied();
  const captured = captureManagedSessionArtifactFacts(input.nextArtifact);
  if (captured.hash !== data.snapshot.hash) writeDenied();
  if (data.lease && (data.lease.leaseId !== input.leaseId || data.lease.providerInstanceId !== input.providerInstanceId)) writeDenied();
  const pending = data.pendingWrite;
  if (pending && (pending.hash !== captured.hash || pending.input.providerInstanceId !== input.providerInstanceId || pending.input.expectedGeneration !== input.expectedGeneration ||
      pending.input.idempotencyKey !== input.idempotencyKey || pending.input.leaseId !== input.leaseId || captureManagedSessionArtifactFacts(pending.input.nextArtifact).hash !== pending.hash)) writeDenied();
  const selected = Object.freeze({...input,nextArtifact:captured.artifact});
  const intent = pending ?? Object.freeze({input:Object.freeze({...selected,nextArtifact:captureManagedSessionArtifactFacts(captured.artifact).artifact}),hash:captured.hash});
  return {input:selected,intent};
}
function writeDenied():never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Credential receipt comparison only; no owner lookup or phase transition. */
export function assertManagedSessionCredentialWritebackFacts(data:Readonly<Pick<ManagedSessionUseState,"snapshot"|"restoredHash"|"writeStatus"|"lease">>):void {
  if (!data.snapshot || !data.restoredHash) writeDenied();
  if (data.snapshot.hash !== data.restoredHash &&
      (data.writeStatus !== "accepted" && data.writeStatus !== "idempotent_replay" || data.lease && !data.lease.terminal)) writeDenied();
}
/** Original discharge predicate over data supplied by the genuine private owner. */
export function assertManagedSessionDischargedFacts(data:Readonly<{
  use:Readonly<{phase:ManagedSessionUsePhase;home?:object}>;
  state:Readonly<{sessionHome?:Readonly<{facade:object;leased:boolean}>;provider?:object;preparingHome?:object}>;
}>):void {
  const {state,use} = data;
  if (use.phase === ManagedSessionUsePhase.Begun && !use.home && !state.preparingHome && !state.sessionHome?.leased && !state.provider) return;
  if (use.phase !== ManagedSessionUsePhase.Released || !use.home || state.sessionHome?.facade !== use.home || state.sessionHome.leased || state.provider || state.preparingHome) writeDenied();
}
