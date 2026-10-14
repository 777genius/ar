import { ScopedActorDischargeMethod } from "./scoped-termination-contract";
import {
  RETAINED_RESOURCE_LIMITS, RetainedMemberRole as Role, RetainedPreparation as Preparation,
  RetainedRecordKind as Kind, RetainedResourceDisposition as Disposition, RetainedResourceLifecycle as Lifecycle,
  RetainedServiceObservation as ServiceObservation,
  RetainedRetirementStep as Step, RetainedTargetKind as TargetKind, RetainedTopology as Topology,
  parseScopedRetainedRecord, parseScopedRetainedPublicationEvents, retainedResourceCanonicalJson, retainedResourceDigest as digest,
  retainedResourceInvalid as invalid, retainedResourceLocator, retainedResourceNames,
  type ScopedRetainedRecord, type ScopedRetainedTarget, type RetainedRecordData,
  type ScopedRetainedPublicationEvents, type ScopedRetainedEventStamp,
} from "./scoped-retained-resource-contract";

export enum RetainedValidationMode { LiveData = "live_data", ReadOnlyHistoricalData = "read_only_historical_data" }
export enum RetainedChainState { Incomplete = "incomplete", CompleteData = "complete_data" }
/** Must come from the target-owning authenticated reader's authoritative inventory,
 * including reservations/resources and every created payload gate, even before
 * completed admission/publication during partial or zero preparation.
 * Supplying this DTO does not authenticate that inventory or its producer. */
export interface RetainedChainExpectation {
  readonly targetDigest: string; readonly originalAuthorityDigest: string;
  /** Null before the authoritative first Closure exists. Its absence can only
   * yield Incomplete; after consumption, readers must pin the exact digest. */
  readonly attemptDigest: string | null;
  readonly reservationDigests: readonly string[]; readonly obligationDigests: readonly string[];
  readonly payloadGateDigests: readonly string[];
}
export type RetainedChainValidation =
  | { readonly state: RetainedChainState.Incomplete; readonly missing: readonly string[] }
  | { readonly state: RetainedChainState.CompleteData; readonly targetDigest: string; readonly finalReceiptDigest: string };

const same = (a: unknown, b: unknown): boolean => digest(a) === digest(b);
const requireData = (predicate: unknown, name: string): void => { if (!predicate) invalid(name); };
function unique(values: readonly unknown[], predicate: string): void { requireData(new Set(values).size === values.length, predicate); }
function exactSet(actual: readonly string[], expected: readonly string[], predicate: string): void {
  unique(actual, predicate); unique(expected, predicate);
  requireData(same([...actual].sort(), [...expected].sort()), predicate);
}
class Missing extends Error { constructor(readonly reference: string) { super(reference); } }
type RecordOf<K extends Kind> = ScopedRetainedRecord<K>;

function validateTarget(t: ScopedRetainedTarget): void {
  requireData(t.workEndEpochMs <= t.originalCleanupAuthority.deadlineEpochMs, "original_bounds");
  unique(t.allocations.map(a => a.allocationId), "allocation_identity");
  unique(t.allocations.map(a => a.allocationDigest), "allocation_identity");
  unique(t.allocations.map(a => a.startId), "allocation_identity");
  unique(t.allocations.map(a => a.unit), "allocation_identity");
  const runtimes = t.allocations.filter(a => a.role === Role.Runtime);
  if (t.topology === Topology.SingleOwnedService) {
    requireData(t.allocations.length === 1 && ![Role.Runtime, Role.Provider].includes(t.allocations[0]!.role), "single_owned_service");
  } else {
    requireData(runtimes.length === 1 && t.allocations.every(a => [Role.Runtime, Role.Provider].includes(a.role)), "runtime_composition");
  }
  if (t.kind === TargetKind.KeyedChild) {
    requireData(t.keyed !== null && t.ordinaryAllocationId === null && t.topology === Topology.RuntimeWithProviders &&
      t.keyed.childAllocationId === runtimes[0]!.allocationId && t.keyed.parentRuntimeAllocationId !== t.keyed.childAllocationId &&
      t.allocations.every(a => a.allocationId !== t.keyed!.parentRuntimeAllocationId && a.grantDigest !== null), "keyed_target");
  } else {
    requireData(t.keyed === null && t.ordinaryAllocationId === (runtimes[0] ?? t.allocations[0])!.allocationId, "ordinary_target");
  }
  for (const a of t.allocations) {
    requireData(a.installationAssociationDigest === digest(t.installation), "allocation_installation");
    requireData(a.qualificationLocator === t.qualificationLocator, "allocation_qualification");
    unique(a.requiredFilterDigests, "required_leaf_filters");
    requireData(a.grantDigest === a.installedGrantDigest &&
      (a.grantDigest !== null || ![Role.Runtime, Role.Provider].includes(a.role)), "installed_grant");
    switch (a.role) {
      case Role.Runtime: requireData(a.unit === `subscription-runtime-ordinary-${a.startId}.service` && a.qualificationId === null, "runtime_unit"); break;
      case Role.Provider: requireData(a.unit === `subscription-runtime-hosted-${a.startId}.service` && a.qualificationId === null, "provider_unit"); break;
      // Controller is a genuine ordinary allocation in the ordinary-start unit
      // namespace. Sharing that grammar does not make it a Runtime or parent.
      case Role.Controller: requireData(a.unit === `subscription-runtime-ordinary-${a.startId}.service` && a.qualificationId === null, "controller_unit"); break;
      case Role.Qualification: requireData(a.qualificationId !== null && a.unit === `subscription-runtime-qualification-${a.qualificationId}.service`, "qualification_unit"); break;
      case Role.QRoot: requireData(a.qualificationId !== null && a.unit === `subscription-runtime-qroot-${a.qualificationId}.service`, "qroot_unit"); break;
      case Role.FixtureHelper: case Role.FaultHelper: requireData(a.qualificationId === null, "helper_unit"); break;
    }
  }
}

/** Pure source/data check. No manager, kernel, private-record access, publication,
 * fsync, cleanup, handle reconstruction or CAS is performed. Historical validation
 * ignores present time/resources but checks every original admitted/publication time.
 * CompleteData is a structural relationship result, never an accepted runtime proof. */
export function validateScopedRetainedChain(
  values: readonly unknown[], publicationEventValues: readonly unknown[], expected: RetainedChainExpectation,
  mode: RetainedValidationMode, nowEpochMs: number,
): RetainedChainValidation {
  requireData(Object.values(RetainedValidationMode).includes(mode) && Number.isSafeInteger(nowEpochMs) && nowEpochMs >= 1, "validation_mode");
  requireData(Array.isArray(values) && values.length <= RETAINED_RESOURCE_LIMITS.records, "record_bound");
  requireData(Array.isArray(publicationEventValues) && publicationEventValues.length <= RETAINED_RESOURCE_LIMITS.records, "publication_event_bound");
  // Both finite inventories share the existing byte budget: one sidecar per
  // completed BODY does not double record capacity or ignore sidecar bytes.
  retainedResourceCanonicalJson({ records: values, publicationEvents: publicationEventValues });
  retainedResourceCanonicalJson(expected);
  requireData(expected !== null && typeof expected === "object", "expectation");
  requireData(Object.keys(expected).sort().join(",") === "attemptDigest,obligationDigests,originalAuthorityDigest,payloadGateDigests,reservationDigests,targetDigest" &&
    typeof expected.targetDigest === "string" && /^[a-f0-9]{64}$/.test(expected.targetDigest) &&
    typeof expected.originalAuthorityDigest === "string" && /^[a-f0-9]{64}$/.test(expected.originalAuthorityDigest) &&
    (expected.attemptDigest === null || (typeof expected.attemptDigest === "string" && /^[a-f0-9]{64}$/.test(expected.attemptDigest))) &&
    Array.isArray(expected.reservationDigests) && expected.reservationDigests.length <= 256 &&
    Array.isArray(expected.obligationDigests) && expected.obligationDigests.length === 1 &&
    Array.isArray(expected.payloadGateDigests) && expected.payloadGateDigests.length <= 256 &&
    [...expected.reservationDigests, ...expected.obligationDigests, ...expected.payloadGateDigests].every(d => typeof d === "string" && /^[a-f0-9]{64}$/.test(d)), "expectation");
  unique(expected.reservationDigests, "inventory_duplicates");
  unique(expected.payloadGateDigests, "inventory_duplicates");
  const records = values.map(parseScopedRetainedRecord), byDigest = new Map(records.map(r => [digest(r), r]));
  requireData(byDigest.size === records.length, "duplicate_records");
  unique(records.map(r => r.publication.generation), "publication_generation");
  requireData(records.every(r => r.targetDigest === expected.targetDigest), "foreign_target");
  // Known present inventory membership is decidable without completion or
  // any required successor. Missing DATA must not mask an undeclared BODY.
  for (const kind of [Kind.Reservation, Kind.ResourceObligation, Kind.PayloadGate] as const) {
    const inventory = kind === Kind.Reservation ? expected.reservationDigests : kind === Kind.ResourceObligation ? expected.obligationDigests : expected.payloadGateDigests;
    requireData(records.filter(r => r.kind === kind).every(r => inventory.includes(digest(r))), "foreign_inventory");
  }
  // Parse and check the ENTIRE projection before a missing successor can yield
  // Incomplete. Every stamp belongs to one original producer lifetime; neither
  // counters nor epochs are reconstructed from BODY, now, or disk copies.
  const eventRows = publicationEventValues.map(parseScopedRetainedPublicationEvents);
  const eventsByDigest = new Map(eventRows.map(e => [e.recordDigest, e]));
  requireData(eventsByDigest.size === eventRows.length, "duplicate_publication_events");
  const observed: ScopedRetainedEventStamp[] = records.map(r => r.publication.admitted);
  for (const e of eventRows) {
    const r = byDigest.get(e.recordDigest);
    requireData(r !== undefined, "foreign_publication_events");
    requireData(e.producerId === r!.publication.producerId && e.generation === r!.publication.generation &&
      same(e.admitted, r!.publication.admitted), "publication_event_binding");
    requireData((e.heldReread !== null) === (r!.kind === Kind.ActorAdmission), "publication_event_hold");
    const stamps = [e.admitted, e.durable, e.readback, ...(e.heldReread ? [e.heldReread] : []), e.finalValidated];
    requireData(stamps.every((stamp, index) => index === 0 ||
      (stamp.sequence > stamps[index - 1]!.sequence && stamp.atEpochMs >= stamps[index - 1]!.atEpochMs)), "publication_event_order");
    observed.push(...stamps.slice(1));
  }
  unique(observed.map(stamp => stamp.sequence), "publication_event_sequence");
  observed.sort((a, b) => a.sequence - b.sequence);
  requireData(observed.every((stamp, index) => index === 0 || stamp.atEpochMs >= observed[index - 1]!.atEpochMs), "publication_event_clock");
  requireData(observed.every(stamp => stamp.atEpochMs <= nowEpochMs), "future_publication");
  const events = (record: ScopedRetainedRecord): ScopedRetainedPublicationEvents => {
    const e = eventsByDigest.get(digest(record));
    if (!e) throw new Missing(`publication_events:${digest(record)}`);
    return e;
  };
  const used = new Set<string>();
  const get = <K extends Kind>(reference: string, kind: K): RecordOf<K> => {
    const record = byDigest.get(reference);
    if (!record) throw new Missing(`${kind}:${reference}`);
    requireData(record.kind === kind, "reference_kind"); used.add(reference);
    return record as RecordOf<K>;
  };
  const one = <K extends Kind>(kind: K): RecordOf<K> => {
    const matches = records.filter(r => r.kind === kind);
    requireData(matches.length <= 1, "duplicate_stage");
    if (!matches.length) throw new Missing(kind);
    return get(digest(matches[0]), kind);
  };
  const after = (next: ScopedRetainedRecord, previous: ScopedRetainedRecord): void => {
    requireData(next.publication.generation > previous.publication.generation &&
      next.publication.admitted.sequence > events(previous).finalValidated.sequence &&
      next.publication.admitted.atEpochMs >= events(previous).finalValidated.atEpochMs, "publication_order");
  };
  try {
    const targetRecord = one(Kind.Target), t = targetRecord.data, authority = t.originalCleanupAuthority;
    const originalAuthorityDigest = digest(authority);
    requireData(digest(t) === expected.targetDigest && originalAuthorityDigest === expected.originalAuthorityDigest, "original_authority");
    validateTarget(t);
    const closures = records.filter((r): r is RecordOf<Kind.Closure> => r.kind === Kind.Closure);
    requireData(closures.length <= 1, "duplicate_stage");
    const attempt = closures[0]?.data.cleanupAttempt;
    const attemptDigest = attempt ? digest(attempt) : null;
    if (attempt) {
      requireData(attempt.originalAuthorityDigest === originalAuthorityDigest && attempt.attemptId === authority.attemptId &&
        attempt.joinDigest === authority.joinDigest && attempt.startedAtEpochMs < authority.deadlineEpochMs &&
        attempt.endEpochMs === attempt.startedAtEpochMs + Math.min(authority.totalAllowanceMs, authority.deadlineEpochMs - attempt.startedAtEpochMs), "attempt_bounds");
      requireData(attemptDigest === expected.attemptDigest, "original_attempt");
    }
    if (mode === RetainedValidationMode.LiveData) requireData(nowEpochMs < (attempt?.endEpochMs ?? authority.deadlineEpochMs) &&
      (!attempt || nowEpochMs >= attempt.startedAtEpochMs), "expired_live_data");
    for (const r of records) {
      const p = r.publication;
      const workRecord = [Kind.Target, Kind.Reservation, Kind.ResourceObligation, Kind.ResourceBinding, Kind.Correlation, Kind.ActorAdmission, Kind.ServiceAdmission, Kind.PayloadGate].includes(r.kind);
      const e = eventsByDigest.get(digest(r));
      // Check admission even if completion is missing; missing DATA never
      // turns an out-of-budget or foreign BODY into acceptable pending work.
      requireData(p.producerId === t.installation.producerId &&
        (workRecord ? p.admitted.atEpochMs < t.workEndEpochMs && (!attempt || p.admitted.atEpochMs <= attempt.startedAtEpochMs) :
          !attempt || (p.admitted.atEpochMs >= attempt.startedAtEpochMs && p.admitted.atEpochMs < attempt.endEpochMs)) &&
        (!e || (workRecord ? e.finalValidated.atEpochMs < t.workEndEpochMs && (!attempt || e.finalValidated.atEpochMs <= attempt.startedAtEpochMs) :
          !attempt || e.finalValidated.atEpochMs < attempt.endEpochMs)), "publication_authority_time");
      if ("originalAuthorityDigest" in r.data) requireData(r.data.originalAuthorityDigest === originalAuthorityDigest, "original_authority");
      if (attempt && "attemptDigest" in r.data) requireData(r.data.attemptDigest === attemptDigest, "renewed_attempt");
    }
    const missingEvents = records.filter(r => !eventsByDigest.has(digest(r))).map(r => `publication_events:${digest(r)}`);
    if (missingEvents.length) return Object.freeze({ state: RetainedChainState.Incomplete, missing: Object.freeze(missingEvents) });
    for (const r of records) {
      if (r !== targetRecord) after(r, targetRecord);
    }
    for (const kind of [Kind.Reservation, Kind.ResourceObligation, Kind.PayloadGate] as const) {
      const inventory = kind === Kind.Reservation ? expected.reservationDigests : kind === Kind.ResourceObligation ? expected.obligationDigests : expected.payloadGateDigests;
      for (const d of inventory) get(d, kind);
    }
    const obligations = expected.obligationDigests.map(d => get(d, Kind.ResourceObligation));
    const names = retainedResourceNames(retainedResourceLocator(t));
    for (const o of obligations) {
      requireData(o.data.resourceDigest === retainedResourceLocator(t) && o.data.sliceUnit === names.sliceUnit &&
        o.data.targetUnit === names.targetUnit && o.data.installationAssociationDigest === digest(t.installation), "resource_names_binding");
    }
    const reservations = expected.reservationDigests.map(d => get(d, Kind.Reservation));
    unique(reservations.map(r => r.data.reservationId), "reservation_identity");
    unique(reservations.map(r => r.data.startId), "reservation_identity");
    unique(reservations.map(r => r.data.allocationDigest), "reservation_identity");
    for (const r of reservations) {
      const a = t.allocations.find(a => a.allocationDigest === r.data.allocationDigest);
      requireData(a && r.data.startId === a.startId && expected.obligationDigests.includes(r.data.obligationDigest), "reservation_owner");
      const runtime = t.allocations.find(a => a.role === Role.Runtime);
      if (a!.role === Role.Provider) {
        const runtimeReservation = reservations.find(row => row.data.allocationDigest === runtime!.allocationDigest);
        requireData(runtimeReservation && same(r.data.parentRuntime, { allocationId: runtime!.allocationId, startDigest: runtimeReservation.data.startDigest }), "genuine_parent_runtime");
      } else if (a!.role === Role.Runtime && t.kind === TargetKind.KeyedChild) {
        requireData(same(r.data.parentRuntime, { allocationId: t.keyed!.parentRuntimeAllocationId, startDigest: t.keyed!.parentRuntimeStartDigest }), "genuine_parent_runtime");
      } else requireData(r.data.parentRuntime === null, "fabricated_parent_runtime");
    }
    const closure = one(Kind.Closure), c = closure.data;
    exactSet(c.reservationDigests, expected.reservationDigests, "closure_reservations");
    exactSet(c.obligationDigests, expected.obligationDigests, "closure_resources");
    exactSet(c.preparations.map(p => p.reservationDigest), expected.reservationDigests, "preparation_completeness");
    exactSet(c.preparations.flatMap(p => p.payloadGateDigest === null ? [] : [p.payloadGateDigest]), expected.payloadGateDigests, "closure_payload_gates");
    requireData(c.admissionClosedAtEpochMs === attempt!.startedAtEpochMs && c.admissionClosedAtEpochMs <= closure.publication.admitted.atEpochMs, "closure_time");
    [...reservations, ...obligations].forEach(r => after(closure, r));
    const bindings = new Map<string, RecordOf<Kind.ResourceBinding>>();
    const actors = new Map<string, RecordOf<Kind.ActorAdmission>>();
    const services = new Map<string, RecordOf<Kind.ServiceAdmission>>();
    const payloadGates = new Map<string, RecordOf<Kind.PayloadGate>>();
    for (const raw of records.filter(r => r.kind === Kind.ResourceBinding)) {
      const b = get(digest(raw), Kind.ResourceBinding), o = get(b.data.obligationDigest, Kind.ResourceObligation);
      requireData(!bindings.has(b.data.obligationDigest), "duplicate_binding");
      bindings.set(b.data.obligationDigest, b); after(b, o); after(closure, b);
      requireData(b.data.installationAssociationDigest === o.data.installationAssociationDigest && b.data.identity.sliceUnit === names.sliceUnit &&
        b.data.identity.controlGroup === names.controlGroup && b.data.retentionTarget.unit === names.targetUnit &&
        same(b.data.retentionTarget.requires, [names.sliceUnit]) && same(b.data.retentionTarget.after, [names.sliceUnit]) &&
        b.data.creationStartedAtEpochMs >= events(o).finalValidated.atEpochMs &&
        b.data.pinnedBeforeAdmissionAtEpochMs >= b.data.creationStartedAtEpochMs &&
        b.data.pinnedBeforeAdmissionAtEpochMs <= b.publication.admitted.atEpochMs, "retained_binding");
    }
    for (const p of c.preparations) {
      const r = get(p.reservationDigest, Kind.Reservation), a = t.allocations.find(a => a.allocationDigest === r.data.allocationDigest)!;
      const rank = Object.values(Preparation).indexOf(p.state);
      const b = bindings.get(r.data.obligationDigest);
      if (rank >= 1 && !b) throw new Missing(`${Kind.ResourceBinding}:${r.data.obligationDigest}`);
      requireData((rank >= 2) === (p.correlationDigest !== null && p.actorAdmissionDigest !== null) &&
        (rank >= 3) === (p.enqueueReleasedAtEpochMs !== null) && (rank >= 4) === (p.serviceAdmissionDigest !== null) &&
        (rank >= 5) === (p.payloadReleasedAtEpochMs !== null), "preparation_references");
      if (rank < 2) requireData(p.correlationDigest === null && p.actorAdmissionDigest === null, "unexpected_admission");
      if (p.payloadGateDigest !== null) {
        const gate = get(p.payloadGateDigest, Kind.PayloadGate), g = gate.data;
        if (!b) throw new Missing(`${Kind.ResourceBinding}:${r.data.obligationDigest}`);
        after(gate, r); after(gate, b); after(closure, gate);
        requireData(g.reservationDigest === p.reservationDigest && g.bindingDigest === digest(b) &&
          g.originalEnqueueGateDigest === r.data.originalGateDigest && g.originalGateDigest !== r.data.originalGateDigest && g.custodyProducerId === t.installation.producerId &&
          g.createdAtEpochMs >= Math.max(events(r).finalValidated.atEpochMs, events(b).finalValidated.atEpochMs) &&
          g.createdAtEpochMs <= gate.publication.admitted.atEpochMs, "payload_gate_binding");
        payloadGates.set(p.reservationDigest, gate);
      }
      if (rank < 2) continue;
      const corr = get(p.correlationDigest!, Kind.Correlation), actor = get(p.actorAdmissionDigest!, Kind.ActorAdmission);
      after(corr, r); after(corr, b!); after(actor, corr); after(closure, actor);
      requireData(corr.data.reservationDigest === p.reservationDigest && corr.data.bindingDigest === digest(b) &&
        corr.data.startDigest === r.data.startDigest && corr.data.reservationGeneration === r.data.reservationGeneration &&
        corr.data.intendedUnit === a.unit && corr.data.intendedControlGroup === `${names.controlGroup}/${a.unit}` &&
        corr.data.creatorControlGroup !== names.controlGroup, "correlation_binding");
      const chain = actor.data.chain;
      requireData(actor.data.correlationDigest === digest(corr) && actor.data.originalGateDigest === r.data.originalGateDigest && chain.correlationDigest === digest(corr) &&
        chain.submitterDigest === digest(actor.data.submitter) && chain.actors[0]!.pidBirth === corr.data.creatorPidBirth &&
        chain.actors[0]!.controlGroup === corr.data.creatorControlGroup && actor.data.submitter.pidBirth === chain.actors[1]!.pidBirth &&
        actor.data.submitter.controlGroup === chain.actors[1]!.controlGroup && actor.data.custodyProducerId === t.installation.producerId &&
        events(actor).heldReread !== null, "held_actor_binding");
      exactSet(actor.data.tasks.map(task => task.actorPidBirth), chain.actors.map(task => task.pidBirth), "task_graph");
      const taskBirths = actor.data.tasks.flatMap(task => [...task.taskBirths]); unique(taskBirths.map(b => b.split(":")[0]), "task_graph");
      requireData(taskBirths.length <= 64 && actor.data.tasks.every(task => task.taskBirths.includes(task.actorPidBirth)), "task_graph");
      actors.set(p.reservationDigest, actor);
      if (p.enqueueReleasedAtEpochMs !== null) requireData(p.enqueueReleasedAtEpochMs >= events(actor).finalValidated.atEpochMs &&
        p.enqueueReleasedAtEpochMs < c.admissionClosedAtEpochMs && p.enqueueReleasedAtEpochMs < t.workEndEpochMs, "enqueue_gate_time");
      if (p.serviceAdmissionDigest === null) continue;
      const service = get(p.serviceAdmissionDigest, Kind.ServiceAdmission), s = service.data;
      after(service, actor); after(closure, service);
      const gate = payloadGates.get(p.reservationDigest);
      requireData(gate !== undefined, "payload_gate_missing");
      after(service, gate!);
      requireData(s.closedPayloadGateDigest === gate!.data.originalGateDigest &&
        s.payloadCustodyDigest === gate!.data.payloadCustodyDigest &&
        events(gate!).finalValidated.atEpochMs <= s.acceptedAtEpochMs, "payload_gate_admission");
      requireData(s.kernel.device === b!.data.identity.kernel.device, "cgroup_filesystem");
      requireData(!same(s.kernel, b!.data.identity.kernel), "cgroup_identity");
      // Only overlapping observations establish simultaneous service objects.
      // Collected historical services may have legitimately reused an inode.
      for (const other of services.values()) if (service.publication.admitted.atEpochMs <= events(other).finalValidated.atEpochMs &&
          other.publication.admitted.atEpochMs <= events(service).finalValidated.atEpochMs) {
        requireData(s.controlGroup === other.data.controlGroup || !same(s.kernel, other.data.kernel), "cgroup_identity");
      }
      requireData(s.correlationDigest === digest(corr) && s.actorAdmissionDigest === digest(actor) && s.unit === a.unit &&
        s.controlGroup === corr.data.intendedControlGroup && s.invocationAnchor.invocationId === s.invocationId &&
        s.acceptedAtEpochMs >= p.enqueueReleasedAtEpochMs! && s.acceptedAtEpochMs <= service.publication.admitted.atEpochMs &&
        s.leafProfileDigest === a.leafProfileDigest && s.effectiveFilterPolicyDigest === a.effectiveFilterPolicyDigest, "service_leaf_binding");
      exactSet(s.effectiveFilterAttachments, a.requiredFilterDigests, "leaf_filters"); unique(s.payloadAncestry.map(v => v.pidBirth.split(":")[0]), "payload_ancestry");
      requireData(s.payloadAncestry[0]!.pidBirth === s.mainPidBirth && s.payloadAncestry[0]!.parentPidBirth === null &&
        s.payloadAncestry.every((v, i) => v.controlGroup === s.controlGroup && (i === 0 || s.payloadAncestry.slice(0, i).some(parent => parent.pidBirth === v.parentPidBirth))), "payload_ancestry");
      if (p.payloadReleasedAtEpochMs !== null) requireData(p.payloadReleasedAtEpochMs >= events(service).finalValidated.atEpochMs &&
        p.payloadReleasedAtEpochMs < c.admissionClosedAtEpochMs && p.payloadReleasedAtEpochMs < t.workEndEpochMs, "payload_gate_time");
      services.set(p.reservationDigest, service);
    }
    unique([...payloadGates.values()].map(g => g.data.originalGateDigest), "payload_gate_identity");
    for (const r of reservations) {
      const allocation = t.allocations.find(a => a.allocationDigest === r.data.allocationDigest)!;
      if (allocation.role !== Role.Provider || !actors.has(digest(r))) continue;
      const runtime = reservations.find(row => row.data.allocationDigest === t.allocations.find(a => a.role === Role.Runtime)!.allocationDigest)!;
      const service = services.get(digest(runtime));
      if (!service) throw new Missing(`${Kind.ServiceAdmission}:${digest(runtime)}`);
      const actor = actors.get(digest(r))!, corr = get(actor.data.correlationDigest, Kind.Correlation);
      after(actor, service);
      requireData(corr.data.creatorControlGroup === service.data.controlGroup &&
        service.data.payloadAncestry.some(a => a.pidBirth === corr.data.creatorPidBirth), "actual_provider_creator");
    }
    const empty = one(Kind.EmptyProof), e = empty.data; after(empty, closure);
    requireData(e.closureDigest === digest(closure), "empty_closure");
    exactSet(e.dispositions.map(d => d.reservationDigest), expected.reservationDigests, "discharge_completeness");
    for (const d of e.dispositions) {
      const r = get(d.reservationDigest, Kind.Reservation), actor = actors.get(d.reservationDigest), service = services.get(d.reservationDigest);
      requireData(d.originalGateDigest === r.data.originalGateDigest && d.closedAtEpochMs >= events(closure).finalValidated.atEpochMs &&
        d.closedAtEpochMs <= empty.publication.admitted.atEpochMs, "original_gate_closure");
      const gate = payloadGates.get(d.reservationDigest), gateClosure = d.payloadGateClosure;
      requireData((gate !== undefined) === (gateClosure !== null), "payload_gate_closure_missing");
      if (gate && gateClosure) requireData(gateClosure.payloadGateDigest === digest(gate) &&
        gateClosure.originalGateDigest === gate.data.originalGateDigest && gateClosure.payloadCustodyDigest === gate.data.payloadCustodyDigest &&
        gateClosure.closedAtEpochMs >= events(closure).finalValidated.atEpochMs &&
        gateClosure.closedAtEpochMs <= e.queueBefore.observedAtEpochMs &&
        gateClosure.closedAtEpochMs <= empty.publication.admitted.atEpochMs, "payload_gate_closure");
      if (actor) {
        requireData(d.discharge !== null && d.dischargedAtEpochMs !== null &&
          d.dischargedAtEpochMs >= Math.max(...e.dispositions.flatMap(d => [d.closedAtEpochMs, d.payloadGateClosure?.closedAtEpochMs ?? d.closedAtEpochMs])) &&
          d.dischargedAtEpochMs <= empty.publication.admitted.atEpochMs, "actor_discharge_missing");
        const discharge = d.discharge!;
        requireData(discharge.chainDigest === digest(actor.data.chain) && discharge.actors.length === actor.data.chain.actors.length, "actor_discharge_incomplete");
        discharge.actors.forEach((entry, index) => {
          const { method, ...identity } = entry;
          requireData(same(identity, actor.data.chain.actors[index]) && method === (index === 0 ? ScopedActorDischargeMethod.ScopedAdmissionFence : ScopedActorDischargeMethod.PidfdExit), "actor_discharge_invalid");
        });
        requireData(discharge.fenceDigest === digest(closure), "actor_fence");
      } else requireData(d.discharge === null && d.dischargedAtEpochMs === null, "invented_actor");
      const preparation = c.preparations.find(p => p.reservationDigest === d.reservationDigest)!;
      requireData(d.serviceAdmissionDigest === (service ? digest(service) : null) &&
        (service ? d.serviceObservation !== null : d.serviceObservation ===
          (preparation.enqueueReleasedAtEpochMs === null ? null : ServiceObservation.NotFound)), "historical_service");
    }
    const relevantUnits = [...t.allocations.map(a => a.unit), names.sliceUnit, names.targetUnit];
    const checkQueue = (q: RetainedRecordData[Kind.EmptyProof]["queueBefore"], min: number, max: number): void => {
      exactSet(q.relevantUnits, relevantUnits, "queue_units"); unique(q.jobs.map(j => j.jobId), "queue_jobs");
      requireData(q.managerDigest === t.installation.managerDigest && q.observedAtEpochMs >= min && q.observedAtEpochMs <= max &&
        q.jobs.every(j => !relevantUnits.includes(j.unit)), "queue_not_empty");
    };
    checkQueue(e.queueBefore, Math.max(events(closure).finalValidated.atEpochMs,
      ...e.dispositions.flatMap(d => [d.dischargedAtEpochMs ?? d.closedAtEpochMs, d.payloadGateClosure?.closedAtEpochMs ?? d.closedAtEpochMs])), empty.publication.admitted.atEpochMs);
    checkQueue(e.queueAfter, e.queueBefore.observedAtEpochMs, empty.publication.admitted.atEpochMs);
    exactSet(e.resources.map(r => r.obligationDigest), expected.obligationDigests, "empty_resource_completeness");
    const retained: RecordOf<Kind.ResourceBinding>[] = [];
    for (const r of e.resources) {
      const o = get(r.obligationDigest, Kind.ResourceObligation);
      if (r.disposition === Disposition.NeverCreated) {
        const u = get(r.uncreatedDigest, Kind.ResourceUncreated); after(u, closure); after(empty, u);
        requireData(o.data.lifecycle === Lifecycle.Declared && !bindings.has(r.obligationDigest) && u.data.obligationDigest === r.obligationDigest &&
          u.data.closureDigest === digest(closure) && u.data.creationGateDigest === o.data.creationGateDigest &&
          u.data.closedAtEpochMs >= events(closure).finalValidated.atEpochMs && u.data.closedAtEpochMs <= u.publication.admitted.atEpochMs &&
          u.data.closedAtEpochMs <= e.queueBefore.observedAtEpochMs, "uncreated_resource_debt");
        continue;
      }
      const b = get(r.bindingDigest, Kind.ResourceBinding); retained.push(b);
      requireData(b.data.obligationDigest === r.obligationDigest && same(r.identityBefore, b.data.identity) && same(r.identityAfter, b.data.identity) &&
        r.observedBeforeAtEpochMs >= e.queueBefore.observedAtEpochMs && r.observedAfterAtEpochMs >= r.observedBeforeAtEpochMs &&
        r.observedAfterAtEpochMs <= e.queueAfter.observedAtEpochMs, "parent_incarnation");
      const paths = r.nodes.map(n => n.path); unique(paths, "recursive_nodes");
      requireData(r.nodes[0]!.path === names.controlGroup && same(r.nodes[0]!.kernel, b.data.identity.kernel), "parent_present");
      // This traversal records simultaneously present directories, unlike
      // historical leaf admissions; one kernel object cannot occupy two paths.
      for (const n of r.nodes) {
        requireData(n.kernel.device === b.data.identity.kernel.device, "cgroup_filesystem");
        requireData(n.events.startsWith("populated 0\n"), "recursive_population"); unique(n.children, "recursive_children");
        const relative = n.path.slice(names.controlGroup.length + 1), leafUnit = relative.split("/")[0];
        requireData(n.path === names.controlGroup || (n.path.startsWith(names.controlGroup + "/") && [...services.values()].some(s => s.data.unit === leafUnit)), "foreign_cgroup");
        if (n.path !== names.controlGroup) requireData(paths.includes(n.path.slice(0, n.path.lastIndexOf("/"))), "recursive_parent_missing");
        const children = paths.filter(p => p.startsWith(n.path + "/") && !p.slice(n.path.length + 1).includes("/")).map(p => p.slice(n.path.length + 1));
        exactSet(n.children, children, "recursive_traversal_incomplete");
        const leaf = [...services.values()].find(s => s.data.controlGroup === n.path);
        if (leaf) requireData(same(n.kernel, leaf.data.kernel), "leaf_incarnation");
      }
      unique(r.nodes.map(n => `${n.kernel.device}:${n.kernel.inode}`), "cgroup_identity");
    }
    const intent = one(Kind.RetirementIntent), i = intent.data; after(intent, empty);
    requireData(i.emptyProofDigest === digest(empty) && i.closureDigest === digest(closure), "intent_chain");
    requireData(i.steps.length === retained.length * 2, "retirement_steps");
    retained.forEach((b, index) => {
      const first = i.steps[index * 2]!, second = i.steps[index * 2 + 1]!;
      requireData(first.bindingDigest === digest(b) && first.step === Step.StopTarget && first.unit === b.data.retentionTarget.unit &&
        second.bindingDigest === digest(b) && [Step.StopSlice, Step.SliceAlreadyRetired].includes(second.step) && second.unit === b.data.identity.sliceUnit, "retirement_steps");
    });
    const facts = one(Kind.RetirementFacts), f = facts.data; after(facts, intent);
    requireData(f.emptyProofDigest === digest(empty) && f.intentDigest === digest(intent) && f.effects.length === i.steps.length, "retirement_facts_chain");
    let completedAt = events(intent).finalValidated.atEpochMs;
    const jobs: number[] = [];
    f.effects.forEach((effect, index) => {
      const { acceptedJobId, submittedAtEpochMs, completedAtEpochMs, result: _result, sliceIdentityBefore,
        directoryCustodyDigest, targetInvocationIdBefore, targetDependencyDigestBefore, observedBeforeAtEpochMs, ...step } = effect;
      const b = get(effect.bindingDigest, Kind.ResourceBinding);
      requireData(directoryCustodyDigest === b.data.directoryCustodyDigest &&
        (effect.step === Step.SliceAlreadyRetired ? sliceIdentityBefore === null : same(sliceIdentityBefore, b.data.identity)) &&
        targetInvocationIdBefore === (effect.step === Step.StopTarget ? b.data.retentionTarget.invocationId : null) &&
        targetDependencyDigestBefore === (effect.step === Step.StopTarget ? digest(b.data.retentionTarget) : null), "retirement_pre_effect_identity");
      requireData(same(step, i.steps[index]) && observedBeforeAtEpochMs >= completedAt && submittedAtEpochMs >= observedBeforeAtEpochMs && completedAtEpochMs >= submittedAtEpochMs &&
        completedAtEpochMs <= facts.publication.admitted.atEpochMs && (acceptedJobId === null) === (effect.step === Step.SliceAlreadyRetired), "retirement_effect_order");
      if (acceptedJobId !== null) jobs.push(acceptedJobId); completedAt = completedAtEpochMs;
    });
    unique(jobs, "retirement_job_identity");
    exactSet(f.resources.map(r => r.bindingDigest), retained.map(digest), "retirement_resource_completeness");
    for (const r of f.resources) {
      const b = get(r.bindingDigest, Kind.ResourceBinding), k = r.kernel;
      const targetEffect = f.effects.find(effect => effect.bindingDigest === r.bindingDigest && effect.step === Step.StopTarget)!;
      const sliceEffect = f.effects.find(effect => effect.bindingDigest === r.bindingDigest && effect.step !== Step.StopTarget)!;
      for (const [observed, unit, invocationId] of [
        [r.target, b.data.retentionTarget.unit, b.data.retentionTarget.invocationId],
        [r.slice, b.data.identity.sliceUnit, b.data.identity.invocationId],
      ] as const) requireData(observed.unit === unit && observed.originalInvocationId === invocationId &&
        observed.observedAtEpochMs >= (observed === r.target ? targetEffect.completedAtEpochMs : sliceEffect.completedAtEpochMs) &&
        observed.observedAtEpochMs <= facts.publication.admitted.atEpochMs, "manager_retirement_identity");
      requireData(r.target.observedAtEpochMs <= sliceEffect.observedBeforeAtEpochMs, "target_retired_before_slice_effect");
      requireData(same(k.pinnedDirectory, b.data.identity.kernel) && k.directoryCustodyDigest === b.data.directoryCustodyDigest &&
        k.eventsCustodyDigest === b.data.eventsCustodyDigest && k.exactAbsentPath === b.data.identity.controlGroup &&
        k.observedAtEpochMs >= Math.max(r.target.observedAtEpochMs, r.slice.observedAtEpochMs) && k.observedAtEpochMs <= facts.publication.admitted.atEpochMs, "pinned_retirement_identity");
    }
    checkQueue(f.queueAfter, completedAt, facts.publication.admitted.atEpochMs);
    requireData(f.queueAfter.jobs.every(j => !jobs.includes(j.jobId)) && f.resources.every(r =>
      f.queueAfter.observedAtEpochMs >= Math.max(r.kernel.observedAtEpochMs, r.target.observedAtEpochMs, r.slice.observedAtEpochMs)), "retirement_queue_reobservation");
    const publication = one(Kind.RetirementPublication); after(publication, facts);
    requireData(publication.data.factsDigest === digest(facts) && publication.data.intentDigest === digest(intent), "producer_publication_reference");
    const final = one(Kind.FinalReceipt); after(final, publication);
    requireData(final.data.closureDigest === digest(closure) && final.data.emptyProofDigest === digest(empty) &&
      final.data.intentDigest === digest(intent) && final.data.factsDigest === digest(facts) &&
      final.data.retirementPublicationDigest === digest(publication), "final_chain");
    const terminals = records.filter(r => r.kind === Kind.OrdinaryTerminal).map(r => get(digest(r), Kind.OrdinaryTerminal));
    unique(terminals.map(r => r.data.reservationDigest), "duplicate_terminal");
    requireData(terminals.every(r => expected.reservationDigests.includes(r.data.reservationDigest)), "foreign_terminal");
    for (const r of reservations) if (!terminals.some(terminal => terminal.data.reservationDigest === digest(r))) throw new Missing(`ordinary_terminal:${digest(r)}`);
    for (const terminal of terminals) {
      after(terminal, final); requireData(terminal.data.finalReceiptDigest === digest(final), "terminal_receipt");
    }
    if (t.kind === TargetKind.KeyedChild) {
      const terminal = one(Kind.KeyedTerminal); after(terminal, final); terminals.forEach(r => after(terminal, r));
      requireData(terminal.data.finalReceiptDigest === digest(final) && terminal.data.keyedBindingDigest === digest(t.keyed) &&
        terminal.data.dispatchIntentDigest === t.keyed!.dispatchIntentDigest, "keyed_successor");
      exactSet(terminal.data.ordinaryTerminalDigests, terminals.map(digest), "keyed_ordinary_successors");
    }
    requireData(used.size === records.length, "unreferenced_record");
    return Object.freeze({ state: RetainedChainState.CompleteData, targetDigest: expected.targetDigest, finalReceiptDigest: digest(final) });
  } catch (error) {
    if (error instanceof Missing) return Object.freeze({ state: RetainedChainState.Incomplete, missing: Object.freeze([error.reference]) });
    throw error;
  }
}
