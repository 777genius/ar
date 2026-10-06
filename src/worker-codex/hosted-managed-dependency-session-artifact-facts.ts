import { isProxy } from "node:util/types";
import { copyBoundedHostedByteInput } from "./hosted-bounded-byte-input";
import { computeSessionGenerationHash, type RedactorPort, type SessionExecutionUse, type SessionArtifact } from "@vioxen/subscription-runtime/core";
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
