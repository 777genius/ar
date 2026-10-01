import { createHash } from "node:crypto";
import { parseScopedActorChain, ScopedActorDischargeMethod, ScopedEnqueueActorRole } from "./scoped-termination-contract";

/** V2 describes durable DATA only. None of these DTOs, digests, parsers or
 * read results authenticate a producer, retain a native handle, or grant authority.
 * Private authenticated provenance must be checked by the consuming adapter.
 * V1 is deliberately not dispatched, converted or retried by this parser. */
export enum RetainedTargetKind { KeyedChild = "keyed_child", OrdinaryAllocation = "ordinary_allocation" }
export enum RetainedTopology { RuntimeWithProviders = "runtime_with_providers", SingleOwnedService = "single_owned_service" }
export enum RetainedMemberRole {
  Runtime = "runtime", Provider = "provider", Controller = "controller", Qualification = "qualification", QRoot = "qroot",
  FixtureHelper = "fixture_helper", FaultHelper = "fault_helper",
}
export enum RetainedPreparation {
  Reserved = "reserved", ResourceBound = "resource_bound", ActorsHeld = "actors_held",
  EnqueueReleased = "enqueue_released", ServiceAdmitted = "service_admitted", PayloadReleased = "payload_released",
}
export enum RetainedServiceObservation { Original = "original", NotFound = "not_found" }
export enum RetainedResourceLifecycle {
  Declared = "declared", CreationStarted = "creation_started", Retained = "retained", AdmissionClosed = "admission_closed",
  EmptyProved = "empty_proved", RetirementAuthorized = "retirement_authorized", Retired = "retired", FinalReceiptDurable = "final_receipt_durable",
}
export enum RetainedResourceDisposition { NeverCreated = "never_created", PositiveEmpty = "positive_empty" }
export enum RetainedRetirementStep { StopTarget = "stop_target", StopSlice = "stop_slice", SliceAlreadyRetired = "slice_already_retired" }
export enum RetainedManagerLoad { Loaded = "loaded", NotFound = "not_found" }
export enum RetainedManagerActive { Active = "active", Inactive = "inactive" }
export enum RetainedManagerSubstate { Active = "active", Dead = "dead" }
export enum RetainedKernelRemoval { PinnedEventsENODEVAndPathAbsent = "pinned_events_enodev_and_path_absent" }
export enum RetainedTaskHold { AllTasks = "all_tasks" }
export enum RetainedPidfdSemantics { WholeThreadGroupExit = "whole_thread_group_exit" }
export enum RetainedJobResult { Done = "done" }
export enum RetainedRecordKind {
  Target = "target", Reservation = "reservation", ResourceObligation = "resource_obligation",
  ResourceBinding = "resource_binding", Correlation = "correlation", ActorAdmission = "actor_admission",
  ServiceAdmission = "service_admission", PayloadGate = "payload_gate", Closure = "closure", ResourceUncreated = "resource_uncreated",
  EmptyProof = "empty_proof", RetirementIntent = "retirement_intent", RetirementFacts = "retirement_facts",
  RetirementPublication = "retirement_publication", FinalReceipt = "final_receipt",
  OrdinaryTerminal = "ordinary_terminal", KeyedTerminal = "keyed_terminal",
}

export const RETAINED_RESOURCE_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, records: 4096, allocations: 256, actors: 64, cgroups: 256 });
export const RETAINED_RESOURCE_NAMESPACES: Readonly<Record<RetainedRecordKind, string>> = Object.freeze({
  [RetainedRecordKind.Target]: "retained-v2-targets", [RetainedRecordKind.Reservation]: "retained-v2-reservations",
  [RetainedRecordKind.ResourceObligation]: "retained-v2-resource-obligations", [RetainedRecordKind.ResourceBinding]: "retained-v2-resource-bindings",
  [RetainedRecordKind.Correlation]: "retained-v2-correlations", [RetainedRecordKind.ActorAdmission]: "retained-v2-actor-admissions",
  [RetainedRecordKind.ServiceAdmission]: "retained-v2-service-admissions", [RetainedRecordKind.PayloadGate]: "retained-v2-payload-gates", [RetainedRecordKind.Closure]: "retained-v2-closures",
  [RetainedRecordKind.ResourceUncreated]: "retained-v2-uncreated", [RetainedRecordKind.EmptyProof]: "retained-v2-empty-proofs",
  [RetainedRecordKind.RetirementIntent]: "retained-v2-retirement-intents", [RetainedRecordKind.RetirementFacts]: "retained-v2-retirement-facts",
  [RetainedRecordKind.RetirementPublication]: "retained-v2-retirement-publications", [RetainedRecordKind.FinalReceipt]: "retained-v2-final-receipts",
  [RetainedRecordKind.OrdinaryTerminal]: "retained-v2-ordinary-terminals", [RetainedRecordKind.KeyedTerminal]: "retained-v2-keyed-terminals",
});

export function retainedResourceInvalid(predicate: string): never { throw new Error(`retained_v2_${predicate}`); }

/** Sorted object keys; ordered arrays; exactly one trailing LF in record bytes.
 * Bounded plain JSON only: no prototype behavior, getters, sparse arrays or cycles.
 * Equality with these bytes also rejects duplicate/escaped duplicate JSON keys. */
export function retainedResourceCanonicalJson(value: unknown): string {
  let count = 0;
  const visit = (v: unknown, depth: number): string => {
    if (++count > 65536 || depth > 32) return retainedResourceInvalid("json_bound");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0)) return String(v);
    if (typeof v === "string" && v.length <= 262144) return JSON.stringify(v);
    if (!v || typeof v !== "object") return retainedResourceInvalid("json_value");
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 4096 || Object.keys(v).length !== v.length ||
          Reflect.ownKeys(v).length !== v.length + 1 || Object.keys(v).some(k => !("value" in Object.getOwnPropertyDescriptor(v, k)!))) return retainedResourceInvalid("json_bound");
      return `[${Array.from(v, x => visit(x, depth + 1)).join(",")}]`;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return retainedResourceInvalid("json_object");
    const keys = Object.keys(v).sort();
    if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => ["__proto__", "constructor", "prototype"].includes(k) ||
        !Object.getOwnPropertyDescriptor(v, k)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(v, k)!))) return retainedResourceInvalid("json_object");
    return `{${keys.map(k => `${JSON.stringify(k)}:${visit((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  };
  const json = visit(value, 0);
  if (Buffer.byteLength(json, "utf8") > RETAINED_RESOURCE_LIMITS.bytes) return retainedResourceInvalid("json_bound");
  return json;
}
export const retainedResourceDigest = (value: unknown): string => createHash("sha256").update(retainedResourceCanonicalJson(value) + "\n").digest("hex");
export const retainedResourceBytes = (value: unknown): string => retainedResourceCanonicalJson(value) + "\n";

// Internal, finite schema combinators. They are not a public schema/evaluator API.
type Parser<T> = (value: unknown) => T;
type Parsed<P> = P extends Parser<infer T> ? T : never;
const object = <S extends Record<string, Parser<unknown>>>(shape: S): Parser<{ readonly [K in keyof S]: Parsed<S[K]> }> => value => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== Object.keys(shape).sort().join(",")) return retainedResourceInvalid("fields");
  return Object.freeze(Object.fromEntries(Object.entries(shape).map(([key, parse]) => [key, parse((value as Record<string, unknown>)[key])]))) as { readonly [K in keyof S]: Parsed<S[K]> };
};
const text = (pattern: RegExp): Parser<string> => v => typeof v === "string" && pattern.test(v) ? v : retainedResourceInvalid("text");
const integer = (min = 1): Parser<number> => v => Number.isSafeInteger(v) && (v as number) >= min ? v as number : retainedResourceInvalid("integer");
const literal = <T extends string | number | boolean>(expected: T): Parser<T> => v => v === expected ? expected : retainedResourceInvalid("literal");
const enumeration = <T extends string>(values: Readonly<Record<string, T>>): Parser<T> => v => Object.values(values).includes(v as T) ? v as T : retainedResourceInvalid("enum");
const nullable = <T>(parse: Parser<T>): Parser<T | null> => v => v === null ? null : parse(v);
const list = <T>(parse: Parser<T>, max = 256, min = 0): Parser<readonly T[]> => v => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return retainedResourceInvalid("array_bound");
  return Object.freeze(v.map(parse));
};
const digest = text(/^[a-f0-9]{64}$/), uuid = text(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const id = text(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/), birth = text(/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/);
const invocation = text(/^[a-f0-9]{32}$/), serviceUnit = text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/);
const group: Parser<string> = v => {
  const path = text(/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/)(v);
  if (path.length > 4096 || path.split("/").some(p => p === "." || p === "..")) return retainedResourceInvalid("group");
  return path;
};
const component: Parser<string> = v => { const s = text(/^[A-Za-z0-9_.@+-]{1,240}$/)(v); return s === "." || s === ".." ? retainedResourceInvalid("component") : s; };
const kernelIdentity = object({ device: integer(0), inode: integer() });
const publication = object({ producerId: id, generation: integer(), admittedAtEpochMs: integer(), durableAtEpochMs: integer(), finalValidatedAtEpochMs: integer() });
// Original, pre-effect limits contain no forecast of an actual cleanup start.
const originalCleanupAuthority = object({ attemptId: uuid, deadlineEpochMs: integer(), totalAllowanceMs: integer(), N: integer(), joinDigest: digest });
const cleanupAttempt = object({ originalAuthorityDigest: digest, attemptId: uuid, startedAtEpochMs: integer(), endEpochMs: integer(), joinDigest: digest });
const installation = object({ installationId: id, bootId: id, hostId: id, namespaceDigest: digest, managerDigest: digest, producerId: id });
const keyed = object({ authorityDigest: digest, slotId: id, childAllocationId: id, parentRuntimeAllocationId: id, parentRuntimeStartDigest: digest, dispatchIntentDigest: digest, dispatchIntentGeneration: integer() });
const allocation = object({
  allocationId: id, startId: uuid, allocationDigest: digest, permissionDigest: digest, installationAssociationDigest: digest,
  role: enumeration(RetainedMemberRole), purpose: id, grantDigest: nullable(digest), installedGrantDigest: nullable(digest),
  // The original guest qualification association is independent of a helper's
  // own-role identifier used in qualification/qroot unit names.
  unit: serviceUnit, qualificationLocator: digest, qualificationId: nullable(digest), leafProfileDigest: digest, effectiveFilterPolicyDigest: digest, requiredFilterDigests: list(digest, 64, 1),
});
const target = object({
  scopeDigest: digest, kind: enumeration(RetainedTargetKind), topology: enumeration(RetainedTopology), installation,
  qualificationLocator: digest, workEndEpochMs: integer(), originalCleanupAuthority, keyed: nullable(keyed), ordinaryAllocationId: nullable(id),
  allocations: list(allocation, 256, 1),
});
const obligation = object({ resourceDigest: digest, sliceUnit: text(/^subscription-runtime-hosted-[a-f0-9]{64}\.slice$/),
  targetUnit: text(/^subscription-runtime-retain-[a-f0-9]{64}\.target$/), creationGateDigest: digest,
  lifecycle: enumeration({ Declared: RetainedResourceLifecycle.Declared, CreationStarted: RetainedResourceLifecycle.CreationStarted, Retained: RetainedResourceLifecycle.Retained }),
  originalAuthorityDigest: digest, installationAssociationDigest: digest,
  manifest: object({ nonExecuting: literal(true), requiresSlice: literal(true), afterSlice: literal(true), cpuWeight: literal(100), denyReuseRestartRecreation: literal(true) }),
});
const reservation = object({ reservationId: uuid, reservationGeneration: integer(), startId: uuid, startDigest: digest,
  allocationDigest: digest, obligationDigest: digest, originalGateDigest: digest,
  parentRuntime: nullable(object({ allocationId: id, startDigest: digest })),
});
const sliceUnit = text(/^subscription-runtime-hosted-[a-f0-9]{64}\.slice$/);
const resourceIdentity = object({ sliceUnit, invocationId: invocation, controlGroup: group, kernel: kernelIdentity });
const binding = object({ obligationDigest: digest, installationAssociationDigest: digest, identity: resourceIdentity,
  retentionTarget: object({ unit: text(/^subscription-runtime-retain-[a-f0-9]{64}\.target$/), invocationId: invocation,
    requires: list(sliceUnit, 1, 1), after: list(sliceUnit, 1, 1), nonExecuting: literal(true), active: literal(RetainedManagerActive.Active) }),
  cpuWeight: literal(100), creationStartedAtEpochMs: integer(), pinnedBeforeAdmissionAtEpochMs: integer(), directoryCustodyDigest: digest, eventsCustodyDigest: digest,
});
const correlation = object({ reservationDigest: digest, bindingDigest: digest, startDigest: digest, reservationGeneration: integer(),
  intendedUnit: serviceUnit, intendedControlGroup: group, creatorPidBirth: birth, creatorControlGroup: group,
});
const actorAdmission = object({ correlationDigest: digest, originalGateDigest: digest, submitter: object({ pidBirth: birth, controlGroup: group }),
  chain: parseScopedActorChain, custodyProducerId: id, hold: literal(RetainedTaskHold.AllTasks),
  pidfdSemantics: literal(RetainedPidfdSemantics.WholeThreadGroupExit), holdDigest: digest, pidfdCustodyDigest: digest,
  tasks: list(object({ actorPidBirth: birth, taskBirths: list(birth, 64, 1) }), 64, 2), finalHeldRereadAtEpochMs: integer(),
});
// Original created native gate/custody observation, including preparation that
// stops before actor/service admission. References are DATA, never native authority.
const payloadGate = object({ reservationDigest: digest, bindingDigest: digest, originalEnqueueGateDigest: digest,
  custodyProducerId: id, originalGateDigest: digest, payloadCustodyDigest: digest, createdAtEpochMs: integer(),
});
const serviceAdmission = object({ correlationDigest: digest, actorAdmissionDigest: digest, acceptedAtEpochMs: integer(),
  unit: serviceUnit, invocationId: invocation, invocationAnchor: object({ invocationId: invocation, kernel: kernelIdentity }),
  mainPidBirth: birth, controlGroup: group, kernel: kernelIdentity,
  payloadAncestry: list(object({ pidBirth: birth, parentPidBirth: nullable(birth), controlGroup: group }), 64, 1),
  payloadCustodyDigest: digest, closedPayloadGateDigest: digest, leafProfileDigest: digest, effectiveFilterPolicyDigest: digest,
  effectiveFilterAttachments: list(digest, 64, 1),
});
const preparation = object({ reservationDigest: digest, state: enumeration(RetainedPreparation),
  correlationDigest: nullable(digest), actorAdmissionDigest: nullable(digest), serviceAdmissionDigest: nullable(digest), payloadGateDigest: nullable(digest),
  enqueueReleasedAtEpochMs: nullable(integer()), payloadReleasedAtEpochMs: nullable(integer()),
});
// The create-only Closure is the authoritative first cleanup publication. Its
// attempt is consumed once under the producer's shared interlock; subsequent
// requests must join these exact bytes. This schema does not implement JOIN.
const closure = object({ cleanupAttempt, attemptDigest: digest, closureGeneration: integer(), admissionClosedAtEpochMs: integer(),
  admissionDenialDigest: digest, reservationDigests: list(digest), obligationDigests: list(digest, 256, 1), preparations: list(preparation),
});
const uncreated = object({ obligationDigest: digest, closureDigest: digest, creationGateDigest: digest, closedAtEpochMs: integer(), noCreationAccepted: literal(true) });
const node = object({ path: group, kernel: kernelIdentity, events: text(/^(?:populated [01]\n)(?:frozen [01]\n)?$/),
  processes: literal(""), children: list(component),
});
const emptyResource: Parser<
  | { readonly disposition: RetainedResourceDisposition.NeverCreated; readonly obligationDigest: string; readonly uncreatedDigest: string }
  | { readonly disposition: RetainedResourceDisposition.PositiveEmpty; readonly obligationDigest: string; readonly bindingDigest: string;
      readonly identityBefore: Parsed<typeof resourceIdentity>; readonly identityAfter: Parsed<typeof resourceIdentity>;
      readonly observedBeforeAtEpochMs: number; readonly observedAfterAtEpochMs: number; readonly nodes: readonly Parsed<typeof node>[] }
> = v => {
  if ((v as { disposition?: unknown } | null)?.disposition === RetainedResourceDisposition.NeverCreated) return object({
    disposition: literal(RetainedResourceDisposition.NeverCreated), obligationDigest: digest, uncreatedDigest: digest,
  })(v);
  return object({ disposition: literal(RetainedResourceDisposition.PositiveEmpty), obligationDigest: digest, bindingDigest: digest,
    identityBefore: resourceIdentity, identityAfter: resourceIdentity, observedBeforeAtEpochMs: integer(), observedAfterAtEpochMs: integer(), nodes: list(node, 256, 1),
  })(v);
};
const queue = object({ managerDigest: digest, relevantUnits: list(text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:service|slice|target)$/), 768, 1),
  jobs: list(object({ jobId: integer(), unit: text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:service|slice|target)$/) }), 4096), observedAtEpochMs: integer(),
});
// The shared actor/discharge meaning is unchanged. Exact fields are checked here;
// V2 semantic validation uses canonical V2 digests rather than V1's ordered JSON.
const discharge = object({ schemaVersion: literal(2), chainDigest: digest, fenceDigest: digest,
  actors: list(object({ role: enumeration(ScopedEnqueueActorRole), pidBirth: birth, controlGroup: group,
    parentPidBirth: nullable(birth), method: enumeration(ScopedActorDischargeMethod) }), 64, 2),
});
const payloadGateClosure = object({ payloadGateDigest: digest, originalGateDigest: digest,
  payloadCustodyDigest: digest, closedAtEpochMs: integer(),
});
const disposition = object({ payloadGateClosure: nullable(payloadGateClosure), reservationDigest: digest, originalGateDigest: digest, closedAtEpochMs: integer(),
  discharge: nullable(discharge), dischargedAtEpochMs: nullable(integer()),
  serviceObservation: nullable(enumeration(RetainedServiceObservation)), serviceAdmissionDigest: nullable(digest),
});
const emptyProof = object({ attemptDigest: digest, closureDigest: digest, dispositions: list(disposition),
  resources: list(emptyResource, 256, 1), queueBefore: queue, queueAfter: queue,
});
const intentStep = object({ bindingDigest: digest, step: enumeration(RetainedRetirementStep), unit: text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:slice|target)$/) });
const retirementIntent = object({ attemptDigest: digest, emptyProofDigest: digest, closureDigest: digest, steps: list(intentStep, 512) });
const managerRetired = object({ unit: text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:slice|target)$/),
  originalInvocationId: invocation, load: enumeration(RetainedManagerLoad), active: literal(RetainedManagerActive.Inactive),
  substate: literal(RetainedManagerSubstate.Dead), currentInvocationId: literal(""), currentControlGroup: literal(""), observedAtEpochMs: integer(),
});
const retirementFacts = object({ attemptDigest: digest, emptyProofDigest: digest, intentDigest: digest,
  effects: list(object({ bindingDigest: digest, step: enumeration(RetainedRetirementStep), unit: text(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.(?:slice|target)$/),
    sliceIdentityBefore: nullable(resourceIdentity), directoryCustodyDigest: digest, targetInvocationIdBefore: nullable(invocation),
    targetDependencyDigestBefore: nullable(digest), observedBeforeAtEpochMs: integer(),
    acceptedJobId: nullable(integer()), submittedAtEpochMs: integer(), completedAtEpochMs: integer(), result: literal(RetainedJobResult.Done) }), 512),
  resources: list(object({ bindingDigest: digest, target: managerRetired, slice: managerRetired,
    kernel: object({ observation: literal(RetainedKernelRemoval.PinnedEventsENODEVAndPathAbsent), pinnedDirectory: kernelIdentity,
      pinnedDirectoryNlink: integer(0), directoryCustodyDigest: digest, eventsCustodyDigest: digest, exactAbsentPath: group,
      conflictingReplacement: literal(false), observedAtEpochMs: integer() }),
  })), queueAfter: queue,
});
const retirementPublication = object({ attemptDigest: digest, factsDigest: digest, intentDigest: digest, nativeProvenanceDigest: digest });
const finalReceipt = object({ attemptDigest: digest, closureDigest: digest, emptyProofDigest: digest, intentDigest: digest,
  factsDigest: digest, retirementPublicationDigest: digest,
});
const ordinaryTerminal = object({ attemptDigest: digest, reservationDigest: digest, finalReceiptDigest: digest });
const keyedTerminal = object({ attemptDigest: digest, finalReceiptDigest: digest, keyedBindingDigest: digest,
  dispatchIntentDigest: digest, ordinaryTerminalDigests: list(digest),
});
const schemas = {
  [RetainedRecordKind.Target]: target, [RetainedRecordKind.Reservation]: reservation,
  [RetainedRecordKind.ResourceObligation]: obligation, [RetainedRecordKind.ResourceBinding]: binding,
  [RetainedRecordKind.Correlation]: correlation, [RetainedRecordKind.ActorAdmission]: actorAdmission,
  [RetainedRecordKind.ServiceAdmission]: serviceAdmission, [RetainedRecordKind.PayloadGate]: payloadGate, [RetainedRecordKind.Closure]: closure,
  [RetainedRecordKind.ResourceUncreated]: uncreated, [RetainedRecordKind.EmptyProof]: emptyProof,
  [RetainedRecordKind.RetirementIntent]: retirementIntent, [RetainedRecordKind.RetirementFacts]: retirementFacts,
  [RetainedRecordKind.RetirementPublication]: retirementPublication, [RetainedRecordKind.FinalReceipt]: finalReceipt,
  [RetainedRecordKind.OrdinaryTerminal]: ordinaryTerminal, [RetainedRecordKind.KeyedTerminal]: keyedTerminal,
} as const;
export type RetainedRecordData = { readonly [K in RetainedRecordKind]: Parsed<typeof schemas[K]> };
export type ScopedRetainedRecord<K extends RetainedRecordKind = RetainedRecordKind> = {
  readonly [P in K]: { readonly schemaVersion: 2; readonly kind: P; readonly targetDigest: string;
    readonly publication: Parsed<typeof publication>; readonly data: RetainedRecordData[P] }
}[K];
export type ScopedRetainedTarget = RetainedRecordData[RetainedRecordKind.Target];
export type ScopedRetainedAllocation = ScopedRetainedTarget["allocations"][number];
export type ScopedRetainedOriginalCleanupAuthority = ScopedRetainedTarget["originalCleanupAuthority"];
export type ScopedRetainedCleanupAttempt = RetainedRecordData[RetainedRecordKind.Closure]["cleanupAttempt"];
export type ScopedRetainedPayloadGate = RetainedRecordData[RetainedRecordKind.PayloadGate];
export type ScopedRetainedPayloadGateClosure = NonNullable<RetainedRecordData[RetainedRecordKind.EmptyProof]["dispositions"][number]["payloadGateClosure"]>;

export function parseScopedRetainedRecord(value: unknown): ScopedRetainedRecord {
  // Clone via plain canonical JSON so the parser never retains caller-owned objects.
  const plain = JSON.parse(retainedResourceCanonicalJson(value)) as unknown;
  const v = object({ schemaVersion: literal(2), kind: enumeration(RetainedRecordKind), targetDigest: digest,
    publication, data: (d: unknown) => d,
  })(plain);
  const data = schemas[v.kind](v.data) as RetainedRecordData[RetainedRecordKind];
  const result = { ...v, data } as ScopedRetainedRecord;
  if (result.kind === RetainedRecordKind.Target && result.targetDigest !== retainedResourceDigest(result.data)) return retainedResourceInvalid("target_digest");
  return Object.freeze(result);
}
export function parseScopedRetainedRecordBytes(bytes: string): ScopedRetainedRecord {
  if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") > RETAINED_RESOURCE_LIMITS.bytes) return retainedResourceInvalid("bytes_bound");
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { return retainedResourceInvalid("json_syntax"); }
  const parsed = parseScopedRetainedRecord(value);
  if (retainedResourceBytes(parsed) !== bytes) return retainedResourceInvalid("noncanonical_bytes");
  return parsed;
}
/** Integrity locator only, never authority. Full systemd hyphen hierarchy is exact. */
export function retainedResourceLocator(target: ScopedRetainedTarget): string {
  return retainedResourceDigest({ installation: target.installation, targetDigest: retainedResourceDigest(target) });
}
export function retainedResourceNames(resourceDigest: string): { readonly sliceUnit: string; readonly targetUnit: string; readonly controlGroup: string } {
  digest(resourceDigest);
  const sliceUnit = `subscription-runtime-hosted-${resourceDigest}.slice`;
  return Object.freeze({ sliceUnit, targetUnit: `subscription-runtime-retain-${resourceDigest}.target`,
    controlGroup: `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${sliceUnit}` });
}
