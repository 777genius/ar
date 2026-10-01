import { describe, expect, it } from "vitest";
import {
  RetainedRecordKind as Kind, RetainedMemberRole as Role, RetainedPreparation as Preparation,
  RetainedTargetKind as TargetKind, RetainedTopology as Topology, RetainedResourceLifecycle as Lifecycle,
  RetainedResourceDisposition as Disposition, RetainedServiceObservation as ServiceObservation,
  RetainedManagerActive, RetainedManagerSubstate, RetainedManagerLoad, RetainedRetirementStep as Step,
  RetainedKernelRemoval, RetainedTaskHold, RetainedPidfdSemantics, RetainedJobResult,
  parseScopedRetainedRecord, parseScopedRetainedRecordBytes, retainedResourceBytes,
  retainedResourceDigest as digest, retainedResourceLocator, retainedResourceNames,
  type ScopedRetainedRecord, type ScopedRetainedTarget, type RetainedRecordData,
} from "../scoped-retained-resource-contract";
import { RetainedChainState, RetainedValidationMode as Mode, validateScopedRetainedChain, type RetainedChainExpectation } from "../scoped-retained-resource-validation";
import {
  ScopedEnqueueActorRole as ActorRole, ScopedActorDischargeMethod as DischargeMethod,
  parseScopedOperation, parseScopedReceipt, parseScopedStartCorrelation, validateScopedCollectedEvidence,
  scopedDigest, ScopedTerminationKind,
} from "../scoped-termination-contract";

type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Edit = (record: Mutable<ScopedRetainedRecord>) => void;
const H = (digit: string): string => digit.repeat(64);
const U = (digit: string): string => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
const I = (digit: string): string => digit.repeat(32);
interface FixtureOptions {
  role?: Role; keyed?: boolean; runtimeProviders?: boolean; twoProviders?: boolean; preparation?: Preparation; payloadGateCreated?: boolean;
  neverCreated?: boolean; noReservations?: boolean; edit?: Edit;
}

/** Explicit TEST-only normalized data. No files, actors, manager/kernel calls or
 * credentials. Changes are re-digested through successors, so negative tests
 * exercise semantic predicates rather than merely breaking a checksum. */
function fixture(options: FixtureOptions = {}) {
  const records: ScopedRetainedRecord[] = [];
  let targetDigest = "", generation = 0;
  const add = <K extends Kind>(kind: K, data: RetainedRecordData[K], at: number): ScopedRetainedRecord<K> => {
    const record = { schemaVersion: 2, kind, targetDigest, data: JSON.parse(JSON.stringify(data)), publication: {
      producerId: "TEST-producer", generation: ++generation, admittedAtEpochMs: at, durableAtEpochMs: at + 1, finalValidatedAtEpochMs: at + 2,
    } } as Mutable<ScopedRetainedRecord>;
    options.edit?.(record);
    if (record.kind === Kind.Target) targetDigest = digest(record.data);
    record.targetDigest = targetDigest;
    records.push(record as ScopedRetainedRecord);
    return record as ScopedRetainedRecord<K>;
  };
  const role = options.runtimeProviders || options.keyed ? Role.Runtime : options.role ?? Role.FixtureHelper;
  const row = (role: Role, digit: string): ScopedRetainedTarget["allocations"][number] => ({
    allocationId: `TEST-P-${digit}`, startId: U(digit), allocationDigest: H(digit), permissionDigest: H("d"),
    installationAssociationDigest: H("e"), role, purpose: "TEST-qualification", grantDigest: [Role.Runtime, Role.Provider].includes(role) ? H("f") : null,
    installedGrantDigest: [Role.Runtime, Role.Provider].includes(role) ? H("f") : null,
    unit: role === Role.Runtime ? `subscription-runtime-ordinary-${U(digit)}.service` : role === Role.Provider ? `subscription-runtime-hosted-${U(digit)}.service` :
      role === Role.Qualification ? `subscription-runtime-qualification-${H("a")}.service` : role === Role.QRoot ? `subscription-runtime-qroot-${H("a")}.service` : "TEST-finite-helper.service",
    qualificationId: [Role.Qualification, Role.QRoot].includes(role) ? H("a") : null,
    leafProfileDigest: H("a"), effectiveFilterPolicyDigest: H("b"), requiredFilterDigests: [H("f")],
  });
  const allocationRows = [row(role, "1"), ...(options.runtimeProviders ? [row(Role.Provider, "2"), ...(options.twoProviders ? [row(Role.Provider, "3")] : [])] : [])];
  const installation = { installationId: "TEST-installation", bootId: "TEST-boot", hostId: "TEST-host", namespaceDigest: H("a"), managerDigest: H("b"), producerId: "TEST-producer" };
  allocationRows.forEach(a => { (a as Mutable<typeof a>).installationAssociationDigest = digest(installation); });
  const targetRecord = add(Kind.Target, {
    scopeDigest: H("c"), kind: options.keyed ? TargetKind.KeyedChild : TargetKind.OrdinaryAllocation,
    topology: [Role.Runtime, Role.Provider].includes(role) ? Topology.RuntimeWithProviders : Topology.SingleOwnedService,
    installation,
    workEndEpochMs: 10000, cleanupAttempt: { attemptId: U("f"), startedAtEpochMs: 5000, endEpochMs: 20000, totalAllowanceMs: 15000, N: 7, joinDigest: H("e") },
    keyed: options.keyed ? { authorityDigest: H("f"), slotId: "TEST-slot", childAllocationId: allocationRows[0]!.allocationId,
      parentRuntimeAllocationId: "TEST-parent-P", parentRuntimeStartDigest: H("d"), dispatchIntentDigest: H("c"), dispatchIntentGeneration: 1 } : null,
    ordinaryAllocationId: options.keyed ? null : allocationRows[0]!.allocationId, allocations: allocationRows,
  }, 100);
  const t = targetRecord.data, attemptDigest = digest(t.cleanupAttempt), locator = retainedResourceLocator(t), names = retainedResourceNames(locator);
  const obligation = add(Kind.ResourceObligation, { resourceDigest: locator, sliceUnit: names.sliceUnit, targetUnit: names.targetUnit,
    creationGateDigest: H("a"), lifecycle: Lifecycle.Declared, attemptDigest, installationAssociationDigest: digest(t.installation),
    manifest: { nonExecuting: true, requiresSlice: true, afterSlice: true, cpuWeight: 100, denyReuseRestartRecreation: true },
  }, 200);
  const reservations = options.noReservations ? [] : t.allocations.map((a, index) => add(Kind.Reservation, {
    reservationId: U(String(index + 3)), reservationGeneration: index + 1, startId: a.startId, startDigest: H(String(index + 3)),
    allocationDigest: a.allocationDigest, obligationDigest: digest(obligation), originalGateDigest: H(String(index + 5)),
    parentRuntime: a.role === Role.Provider ? { allocationId: t.allocations[0]!.allocationId, startDigest: H("3") } :
      a.role === Role.Runtime && t.keyed ? { allocationId: t.keyed.parentRuntimeAllocationId, startDigest: t.keyed.parentRuntimeStartDigest } : null,
  }, 300 + index * 3));
  const binding = options.neverCreated ? null : add(Kind.ResourceBinding, {
    obligationDigest: digest(obligation), installationAssociationDigest: digest(t.installation),
    identity: { sliceUnit: names.sliceUnit, invocationId: I("a"), controlGroup: names.controlGroup, kernel: { device: 29, inode: 3509189 } },
    retentionTarget: { unit: names.targetUnit, invocationId: I("b"), requires: [names.sliceUnit], after: [names.sliceUnit], nonExecuting: true, active: RetainedManagerActive.Active },
    cpuWeight: 100, creationStartedAtEpochMs: 320, pinnedBeforeAdmissionAtEpochMs: 350, directoryCustodyDigest: H("c"), eventsCustodyDigest: H("d"),
  }, 400);
  const state = options.preparation ?? (options.neverCreated ? Preparation.Reserved : Preparation.PayloadReleased);
  const rank = Object.values(Preparation).indexOf(state);
  const admissions = reservations.map((r, index) => {
    const a = t.allocations[index]!, base = 500 + index * 1000, creator = a.role === Role.Provider ? "200:20" : `${100 + index * 10}:10`, submitter = `${101 + index * 10}:11`;
    // Actual creator group is independent of the retained parent resource.
    const creatorGroup = a.role === Role.Provider ? `${names.controlGroup}/${t.allocations[0]!.unit}` : "/TEST-root-owner.service";
    const correlation = rank < 2 ? null : add(Kind.Correlation, { reservationDigest: digest(r), bindingDigest: digest(binding), startDigest: r.data.startDigest,
      reservationGeneration: r.data.reservationGeneration, intendedUnit: a.unit, intendedControlGroup: `${names.controlGroup}/${a.unit}`,
      creatorPidBirth: creator, creatorControlGroup: creatorGroup,
    }, base);
    const gate = (options.payloadGateCreated ?? (rank >= 3)) ? add(Kind.PayloadGate, {
      reservationDigest: digest(r), bindingDigest: digest(binding), originalEnqueueGateDigest: r.data.originalGateDigest,
      custodyProducerId: "TEST-producer", originalGateDigest: H("89a"[index]!), payloadCustodyDigest: H("def"[index]!), createdAtEpochMs: base + 40,
    }, base + 50) : null;
    const retainedSubmitter = { pidBirth: submitter, controlGroup: creatorGroup };
    const actor = correlation ? add(Kind.ActorAdmission, { correlationDigest: digest(correlation), originalGateDigest: r.data.originalGateDigest, submitter: retainedSubmitter,
      chain: { schemaVersion: 1, correlationDigest: digest(correlation), submitterDigest: digest(retainedSubmitter), actors: [
        { role: ActorRole.Creator, pidBirth: creator, controlGroup: creatorGroup, parentPidBirth: null },
        { role: ActorRole.ManagerSubmitter, pidBirth: submitter, controlGroup: creatorGroup, parentPidBirth: creator },
      ] }, custodyProducerId: "TEST-producer", hold: RetainedTaskHold.AllTasks, pidfdSemantics: RetainedPidfdSemantics.WholeThreadGroupExit,
      holdDigest: H("a"), pidfdCustodyDigest: H("b"), tasks: [{ actorPidBirth: creator, taskBirths: [creator] }, { actorPidBirth: submitter, taskBirths: [submitter] }],
      finalHeldRereadAtEpochMs: base + 101,
    }, base + 100) : null;
    const service = rank < 4 ? null : add(Kind.ServiceAdmission, { correlationDigest: digest(correlation), actorAdmissionDigest: digest(actor), acceptedAtEpochMs: base + 200,
      unit: a.unit, invocationId: I(String(index + 1)), invocationAnchor: { invocationId: I(String(index + 1)), kernel: { device: 29, inode: 8000 + index } },
      mainPidBirth: `${200 + index}:20`, controlGroup: `${names.controlGroup}/${a.unit}`, kernel: { device: 29, inode: 9000 + index },
      payloadAncestry: [{ pidBirth: `${200 + index}:20`, parentPidBirth: null, controlGroup: `${names.controlGroup}/${a.unit}` }],
      payloadCustodyDigest: gate?.data.payloadCustodyDigest ?? H("d"), closedPayloadGateDigest: gate?.data.originalGateDigest ?? H("e"), leafProfileDigest: a.leafProfileDigest,
      effectiveFilterPolicyDigest: a.effectiveFilterPolicyDigest, effectiveFilterAttachments: [H("f")],
    }, base + 300);
    return { r, actor, service, gate, preparation: { reservationDigest: digest(r), state,
      correlationDigest: correlation ? digest(correlation) : null, actorAdmissionDigest: actor ? digest(actor) : null,
      serviceAdmissionDigest: service ? digest(service) : null, payloadGateDigest: gate ? digest(gate) : null, enqueueReleasedAtEpochMs: rank >= 3 ? base + 150 : null,
      payloadReleasedAtEpochMs: rank >= 5 ? base + 350 : null } };
  });
  const closure = add(Kind.Closure, { attemptDigest, closureGeneration: 1, admissionClosedAtEpochMs: 5500, admissionDenialDigest: H("a"),
    reservationDigests: reservations.map(digest), obligationDigests: [digest(obligation)], preparations: admissions.map(a => a.preparation),
  }, 6000);
  const uncreated = binding ? null : add(Kind.ResourceUncreated, { obligationDigest: digest(obligation), closureDigest: digest(closure), creationGateDigest: obligation.data.creationGateDigest,
    closedAtEpochMs: 6200, noCreationAccepted: true,
  }, 6250);
  const queue = (observedAtEpochMs: number) => ({ managerDigest: t.installation.managerDigest,
    relevantUnits: [...t.allocations.map(a => a.unit), names.sliceUnit, names.targetUnit], jobs: [], observedAtEpochMs });
  const empty = add(Kind.EmptyProof, { attemptDigest, closureDigest: digest(closure), dispositions: admissions.map(({ r, actor, service, gate, preparation }) => ({
    payloadGateClosure: gate ? { payloadGateDigest: digest(gate), originalGateDigest: gate.data.originalGateDigest, payloadCustodyDigest: gate.data.payloadCustodyDigest, closedAtEpochMs: 6200 } : null,
    reservationDigest: digest(r), originalGateDigest: r.data.originalGateDigest, closedAtEpochMs: 6200, dischargedAtEpochMs: actor ? 6250 : null,
    discharge: actor ? { schemaVersion: 2, chainDigest: digest(actor.data.chain), fenceDigest: digest(closure), actors: actor.data.chain.actors.map((a, i) => ({ ...a,
      method: i === 0 ? DischargeMethod.ScopedAdmissionFence : DischargeMethod.PidfdExit,
    })) } : null,
    serviceObservation: service || preparation.enqueueReleasedAtEpochMs !== null ? ServiceObservation.NotFound : null, serviceAdmissionDigest: service ? digest(service) : null,
  })), resources: binding ? [{ disposition: Disposition.PositiveEmpty, obligationDigest: digest(obligation), bindingDigest: digest(binding),
    identityBefore: binding.data.identity, identityAfter: binding.data.identity, observedBeforeAtEpochMs: 6400, observedAfterAtEpochMs: 6500,
    nodes: [{ path: names.controlGroup, kernel: binding.data.identity.kernel, events: "populated 0\nfrozen 0\n", processes: "", children: [] }],
  }] : [{ disposition: Disposition.NeverCreated, obligationDigest: digest(obligation), uncreatedDigest: digest(uncreated) }], queueBefore: queue(6300), queueAfter: queue(6600),
  }, 7000);
  const steps = binding ? [{ bindingDigest: digest(binding), step: Step.StopTarget, unit: names.targetUnit }, { bindingDigest: digest(binding), step: Step.StopSlice, unit: names.sliceUnit }] : [];
  const intent = add(Kind.RetirementIntent, { attemptDigest, emptyProofDigest: digest(empty), closureDigest: digest(closure), steps }, 8000);
  const retiredManager = (unit: string, originalInvocationId: string, observedAtEpochMs: number): RetainedRecordData[Kind.RetirementFacts]["resources"][number]["target"] => ({ unit, originalInvocationId,
    load: RetainedManagerLoad.Loaded, active: RetainedManagerActive.Inactive, substate: RetainedManagerSubstate.Dead,
    currentInvocationId: "" as const, currentControlGroup: "" as const, observedAtEpochMs });
  const facts = add(Kind.RetirementFacts, { attemptDigest, emptyProofDigest: digest(empty), intentDigest: digest(intent),
    effects: steps.map((s, i) => ({ ...s, sliceIdentityBefore: s.step === Step.SliceAlreadyRetired ? null : binding!.data.identity,
      directoryCustodyDigest: binding!.data.directoryCustodyDigest, targetInvocationIdBefore: s.step === Step.StopTarget ? binding!.data.retentionTarget.invocationId : null,
      targetDependencyDigestBefore: s.step === Step.StopTarget ? digest(binding!.data.retentionTarget) : null,
      observedBeforeAtEpochMs: i === 0 ? 8050 : 8260, acceptedJobId: s.step === Step.SliceAlreadyRetired ? null : 40 + i, submittedAtEpochMs: 8100 + i * 200,
      completedAtEpochMs: 8200 + i * 200, result: RetainedJobResult.Done })),
    resources: binding ? [{ bindingDigest: digest(binding), target: retiredManager(names.targetUnit, binding.data.retentionTarget.invocationId, 8250),
      slice: retiredManager(names.sliceUnit, binding.data.identity.invocationId, 8600), kernel: {
        observation: RetainedKernelRemoval.PinnedEventsENODEVAndPathAbsent, pinnedDirectory: binding.data.identity.kernel,
        pinnedDirectoryNlink: 2, directoryCustodyDigest: binding.data.directoryCustodyDigest, eventsCustodyDigest: binding.data.eventsCustodyDigest,
        exactAbsentPath: names.controlGroup, conflictingReplacement: false, observedAtEpochMs: 8700,
      } }] : [], queueAfter: queue(8800),
  }, 9000);
  const publication = add(Kind.RetirementPublication, { attemptDigest, factsDigest: digest(facts), intentDigest: digest(intent), nativeProvenanceDigest: H("e") }, 10000);
  const final = add(Kind.FinalReceipt, { attemptDigest, closureDigest: digest(closure), emptyProofDigest: digest(empty), intentDigest: digest(intent), factsDigest: digest(facts), retirementPublicationDigest: digest(publication) }, 11000);
  const terminals = reservations.map((r, i) => add(Kind.OrdinaryTerminal, { attemptDigest, reservationDigest: digest(r), finalReceiptDigest: digest(final) }, 12000 + i * 10));
  if (options.keyed) add(Kind.KeyedTerminal, { attemptDigest, finalReceiptDigest: digest(final), keyedBindingDigest: digest(t.keyed), dispatchIntentDigest: t.keyed!.dispatchIntentDigest,
    ordinaryTerminalDigests: terminals.map(digest),
  }, 13000);
  const expected: RetainedChainExpectation = { targetDigest, attemptDigest, reservationDigests: reservations.map(digest), obligationDigests: [digest(obligation)], payloadGateDigests: admissions.flatMap(a => a.gate ? [digest(a.gate)] : []) };
  return { records, expected };
}
const read = (f: ReturnType<typeof fixture>, mode = Mode.ReadOnlyHistoricalData, now = 99000) => validateScopedRetainedChain(f.records, f.expected, mode, now);
const fails = (edit: Edit, predicate: string, options: FixtureOptions = {}) => expect(() => read(fixture({ ...options, edit }))).toThrow(predicate);

describe("retained v2 bounded source/data contracts", () => {
  it("reads a complete durable chain after disposal and expiry, including SAME pinned inode with nlink 2", () => {
    const f = fixture();
    expect(read(f)).toMatchObject({ state: RetainedChainState.CompleteData, targetDigest: f.expected.targetDigest });
    expect(read(f, Mode.LiveData, 15000).state).toBe(RetainedChainState.CompleteData);
  });
  it.each([Role.Qualification, Role.QRoot, Role.FixtureHelper, Role.FaultHelper])("accepts genuine ordinary %s names and actual null installed grants", role => {
    expect(read(fixture({ role })).state).toBe(RetainedChainState.CompleteData);
  });
  it("accepts genuine keyed runtime/provider composition and genuine parent associations", () => {
    expect(read(fixture({ keyed: true, runtimeProviders: true })).state).toBe(RetainedChainState.CompleteData);
  });
  it.each(Object.values(Preparation))("keeps every reserved obligation at preparation %s without fabricated admitted services", preparation => {
    expect(read(fixture({ preparation })).state).toBe(RetainedChainState.CompleteData);
  });
  it.each([false, true])("supports zero reservations and no invented Runtime, resource neverCreated=%s", neverCreated => {
    expect(read(fixture({ noReservations: true, neverCreated })).state).toBe(RetainedChainState.CompleteData);
  });
  it("accepts a closed never-created obligation; partial creation remains resource debt", () => {
    expect(read(fixture({ neverCreated: true })).state).toBe(RetainedChainState.CompleteData);
    fails(r => { if (r.kind === Kind.ResourceObligation) r.data.lifecycle = Lifecycle.CreationStarted; }, "uncreated_resource_debt", { neverCreated: true });
    fails(r => { if (r.kind === Kind.ResourceUncreated) { r.data.closedAtEpochMs = 6400; r.publication.admittedAtEpochMs = 6450; r.publication.durableAtEpochMs = 6451; r.publication.finalValidatedAtEpochMs = 6452; } }, "uncreated_resource_debt", { neverCreated: true });
  });
  it("accepts optional slice already-retired observation only with no invented stop job", () => {
    const f = fixture({ edit: r => {
      if (r.kind === Kind.RetirementIntent) r.data.steps[1]!.step = Step.SliceAlreadyRetired;
      if (r.kind === Kind.RetirementFacts) { r.data.effects[1]!.step = Step.SliceAlreadyRetired; r.data.effects[1]!.acceptedJobId = null; r.data.effects[1]!.sliceIdentityBefore = null; }
    } });
    expect(read(f).state).toBe(RetainedChainState.CompleteData);
  });
  it("requires canonical bytes, stable keys and immutable detached parsed data", () => {
    const raw = fixture().records[0]!;
    const parsed = parseScopedRetainedRecordBytes(retainedResourceBytes(raw));
    expect(digest(parsed)).toBe(digest(raw));
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(Object.isFrozen(parsed.data)).toBe(true);
    expect(Object.isFrozen((parsed as ScopedRetainedRecord<Kind.Target>).data.allocations)).toBe(true);
    expect(() => parseScopedRetainedRecordBytes(JSON.stringify(raw))).toThrow("noncanonical_bytes");
    const bytes = retainedResourceBytes(raw);
    expect(() => parseScopedRetainedRecordBytes(bytes.replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2'))).toThrow("noncanonical_bytes");
    expect(() => parseScopedRetainedRecordBytes(bytes.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'))).toThrow("noncanonical_bytes");
  });
  it("rejects unknown/extra fields, invalid versions/enums, traversal, oversized and executable objects", () => {
    const r = fixture().records[0]!;
    expect(() => parseScopedRetainedRecord({ ...r, schemaVersion: 1 })).toThrow("literal");
    expect(() => parseScopedRetainedRecord({ ...r, kind: "future" })).toThrow("enum");
    expect(() => parseScopedRetainedRecord({ ...r, credentials: "TEST-invalid" })).toThrow("fields");
    expect(() => parseScopedRetainedRecord({ ...r, publication: { ...r.publication, generation: 0 } })).toThrow("integer");
    expect(() => parseScopedRetainedRecordBytes(" ".repeat(4 * 1024 * 1024 + 1))).toThrow("bytes_bound");
    expect(() => parseScopedRetainedRecord(new Date())).toThrow("json_object");
    expect(() => parseScopedRetainedRecord({ get schemaVersion() { throw new Error("must not execute"); } })).toThrow("json_object");
    const huge = structuredClone(r) as Mutable<ScopedRetainedRecord<Kind.Target>>;
    huge.data.allocations = Array.from({ length: 257 }, () => huge.data.allocations[0]!); huge.targetDigest = digest(huge.data);
    expect(() => parseScopedRetainedRecord(huge)).toThrow("array_bound");
    fails(r => { if (r.kind === Kind.Correlation) r.data.creatorControlGroup = "/x/../owner.service"; }, "group");
  });
  it("isolates scope/target/service/parent identities and exact full systemd hierarchy", () => {
    fails(r => { if (r.kind === Kind.ResourceObligation) r.data.sliceUnit = `subscription-runtime-hosted-${H("f")}.slice`; }, "resource_names_binding");
    fails(r => { if (r.kind === Kind.ResourceBinding) r.data.identity.controlGroup = "/subscription-runtime-hosted.slice/child.slice"; }, "retained_binding");
    fails(r => { if (r.kind === Kind.Correlation) r.data.creatorControlGroup = r.data.intendedControlGroup.slice(0, r.data.intendedControlGroup.lastIndexOf("/")); }, "correlation_binding");
    fails(r => { if (r.kind === Kind.Correlation) r.data.intendedControlGroup += "/nested"; }, "correlation_binding");
    fails(r => { if (r.kind === Kind.ResourceBinding) r.data.retentionTarget.after = []; }, "array_bound");
    fails(r => { if (r.kind === Kind.ResourceBinding) r.data.creationStartedAtEpochMs = 201; }, "retained_binding");
  });
  it("refuses fake ordinary keyed bindings, parent Runtime and grants, while keeping keyed policy strict", () => {
    fails(r => { if (r.kind === Kind.Reservation) r.data.parentRuntime = { allocationId: "TEST-fake", startDigest: H("a") }; }, "fabricated_parent_runtime");
    fails(r => { if (r.kind === Kind.Target) r.data.allocations[0]!.grantDigest = H("f"); }, "installed_grant");
    fails(r => { if (r.kind === Kind.Target) r.data.topology = Topology.RuntimeWithProviders; }, "runtime_composition");
    fails(r => { if (r.kind === Kind.Target) r.data.ordinaryAllocationId = "TEST-foreign"; }, "ordinary_target");
    fails(r => { if (r.kind === Kind.Target) { r.data.allocations[0]!.grantDigest = null; r.data.allocations[0]!.installedGrantDigest = null; } }, "keyed_target", { keyed: true });
    fails(r => { if (r.kind === Kind.Reservation) r.data.parentRuntime = null; }, "genuine_parent_runtime", { keyed: true });
    fails(r => { if (r.kind === Kind.Target) r.data.allocations[0]!.unit = "TEST-arbitrary.service"; }, "qualification_unit", { role: Role.Qualification });
  });
  it.each([Role.Qualification, Role.QRoot].flatMap(role => ["TEST-q", "a".repeat(63), "a".repeat(65), "g".repeat(64), "A".repeat(64)].map(id => [role, id] as const)))("rejects invalid %s id %s even with an exactly matching unit", (role, qualificationId) => {
      const f = fixture({ role, edit: r => {
        if (r.kind === Kind.Target) {
          const a = r.data.allocations[0]!;
          a.qualificationId = qualificationId;
          a.unit = `subscription-runtime-${role === Role.Qualification ? "qualification" : "qroot"}-${qualificationId}.service`;
        }
      } });
      expect(() => read(f)).toThrow();
  });
  it("rejects an admitted leaf that claims the retained parent kernel object even after leaf GC", () => {
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.kernel = { device: 29, inode: 3509189 }; }, "cgroup_identity");
  });
  it("rejects a service leaf from another cgroup filesystem", () => {
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.kernel.device = 999; }, "cgroup_filesystem");
  });
  it("rejects overlapping provider admissions claiming the same cgroup object", () => {
    fails(r => {
      if (r.kind === Kind.ServiceAdmission && r.data.unit.includes(U("2"))) {
        r.publication.admittedAtEpochMs = 2800; r.publication.durableAtEpochMs = 2801; r.publication.finalValidatedAtEpochMs = 2802;
      }
      if (r.kind === Kind.ServiceAdmission && r.data.unit.includes(U("3"))) r.data.kernel.inode = 9001;
    }, "cgroup_identity", { runtimeProviders: true, twoProviders: true, preparation: Preparation.ServiceAdmitted });
  });
  it("allows inode reuse in nonoverlapping historical admissions without claiming simultaneous existence", () => {
    expect(read(fixture({ runtimeProviders: true, twoProviders: true, edit: r => {
      if (r.kind === Kind.ServiceAdmission && r.data.unit.startsWith("subscription-runtime-hosted-")) r.data.kernel.inode = 9001;
    } })).state).toBe(RetainedChainState.CompleteData);
  });
  it("allows a descendant to reuse an absent historical leaf inode", () => {
    expect(read(fixture({ runtimeProviders: true, edit: r => {
      recursiveTree(r);
      if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[2]!.kernel.inode = 9001;
    } })).state).toBe(RetainedChainState.CompleteData);
  });
  const recursiveTree: Edit = r => {
    if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) {
      const resource = r.data.resources[0]!, root = resource.nodes[0]!, unit = r.data.queueBefore.relevantUnits[0]!;
      root.children = [unit];
      resource.nodes.push({ path: root.path + "/" + unit, kernel: { device: 29, inode: 9000 }, events: "populated 0\n", processes: "", children: ["nested"] });
      resource.nodes.push({ path: root.path + "/" + unit + "/nested", kernel: { device: 29, inode: 9001 }, events: "populated 0\n", processes: "", children: [] });
    }
  };
  it("rejects a complete empty recursive tree containing a foreign filesystem device", () => {
    fails(r => { recursiveTree(r); if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[2]!.kernel.device = 999; }, "cgroup_filesystem");
  });
  it.each([3509189, 9000])("rejects a recursive descendant alias of simultaneous object %s", inode => {
    fails(r => { recursiveTree(r); if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[2]!.kernel.inode = inode; }, "cgroup_identity");
  });
  it("does not complete an admitted held payload without its explicit final payload gate closure", () => {
    const f = fixture({ preparation: Preparation.ServiceAdmitted, edit: r => {
      if (r.kind === Kind.EmptyProof) Reflect.deleteProperty(r.data.dispositions[0]!, "payloadGateClosure");
    } });
    expect(() => read(f)).toThrow();
  });
  it.each([Preparation.Reserved, Preparation.ResourceBound, Preparation.ActorsHeld, Preparation.EnqueueReleased, Preparation.ServiceAdmitted, Preparation.PayloadReleased])(
    "retains a created payload gate at partial/final preparation %s and requires its own closure", preparation => {
      expect(read(fixture({ preparation, payloadGateCreated: true })).state).toBe(RetainedChainState.CompleteData);
      fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure = null; }, "payload_gate_closure_missing", { preparation, payloadGateCreated: true });
    });
  it.each([Preparation.Reserved, Preparation.ResourceBound, Preparation.ActorsHeld, Preparation.EnqueueReleased])(
    "explicitly permits a never-created payload gate at %s without fabricated custody", preparation => {
      expect(read(fixture({ preparation, payloadGateCreated: false })).state).toBe(RetainedChainState.CompleteData);
    });
  it("keeps a missing original created gate record incomplete even before service admission", () => {
    const f = fixture({ preparation: Preparation.ResourceBound, payloadGateCreated: true });
    f.records = f.records.filter(r => r.kind !== Kind.PayloadGate);
    expect(read(f).state).toBe(RetainedChainState.Incomplete);
  });
  it("rejects hidden partial payload debt and invented never-created gate closure", () => {
    fails(r => { if (r.kind === Kind.Closure) r.data.preparations[0]!.payloadGateDigest = null; }, "closure_payload_gates", { preparation: Preparation.ResourceBound, payloadGateCreated: true });
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure = { payloadGateDigest: H("f"), originalGateDigest: H("e"), payloadCustodyDigest: H("d"), closedAtEpochMs: 6200 }; }, "payload_gate_closure_missing", { preparation: Preparation.Reserved });
    fails(r => {
      if (r.kind === Kind.Closure) r.data.preparations[0]!.payloadGateDigest = null;
      if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure = null;
    }, "closure_payload_gates", { preparation: Preparation.ResourceBound, payloadGateCreated: true });
  });
  it("keeps unpublished created payload debt in the independent inventory when both closure references are hidden", () => {
    const f = fixture({ preparation: Preparation.ResourceBound, payloadGateCreated: true, edit: r => {
      if (r.kind === Kind.Closure) r.data.preparations[0]!.payloadGateDigest = null;
      if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure = null;
    } });
    f.records = f.records.filter(r => r.kind !== Kind.PayloadGate);
    expect(read(f).state).toBe(RetainedChainState.Incomplete);
  });
  it.each(["payloadGateDigest", "originalGateDigest", "payloadCustodyDigest"] as const)("rejects a foreign final payload closure %s", field => {
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure![field] = H("f"); }, "payload_gate_closure");
  });
  it.each([6001, 6301, 6500, 7001, 20000])("rejects original payload closure time %s outside closure/collection bounds", closedAtEpochMs => {
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure!.closedAtEpochMs = closedAtEpochMs; }, "payload_gate_closure");
  });
  it("requires both gates closed before actor discharge and the first queue/empty collection", () => {
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure!.closedAtEpochMs = 6260; }, "actor_discharge_missing");
    fails(r => { if (r.kind === Kind.EmptyProof) { r.data.dispositions[0]!.closedAtEpochMs = 6350; r.data.dispositions[0]!.dischargedAtEpochMs = 6360; } }, "queue_not_empty");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[1]!.payloadGateClosure!.closedAtEpochMs = 6260; }, "actor_discharge_missing", { runtimeProviders: true });
  });
  it("rejects closure of another actually created sibling payload gate", () => {
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.payloadGateClosure = structuredClone(r.data.dispositions[1]!.payloadGateClosure); }, "payload_gate_closure", { runtimeProviders: true });
  });
  it.each([Role.Qualification, Role.QRoot])("requires the exact %s prefix even for a valid 64hex id", role => {
    fails(r => { if (r.kind === Kind.Target) r.data.allocations[0]!.unit = `subscription-runtime-${role === Role.Qualification ? "qroot" : "qualification"}-${H("a")}.service`; }, role === Role.Qualification ? "qualification_unit" : "qroot_unit", { role });
  });
  it("binds original payload custody/gate to actual admission and original reservation/binding", () => {
    for (const field of ["reservationDigest", "bindingDigest", "originalEnqueueGateDigest"] as const) {
      fails(r => { if (r.kind === Kind.PayloadGate) r.data[field] = H("f"); }, "payload_gate_binding");
    }
    fails(r => { if (r.kind === Kind.PayloadGate) r.data.custodyProducerId = "TEST-other"; }, "payload_gate_binding");
    fails(r => { if (r.kind === Kind.PayloadGate) r.data.createdAtEpochMs = 401; }, "payload_gate_binding");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.closedPayloadGateDigest = H("f"); }, "payload_gate_admission");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.payloadCustodyDigest = H("f"); }, "payload_gate_admission");
    fails(r => { if (r.kind === Kind.PayloadGate) {
      r.publication.admittedAtEpochMs = 750; r.publication.durableAtEpochMs = 751; r.publication.finalValidatedAtEpochMs = 752;
    } }, "payload_gate_admission");
    fails(r => { if (r.kind === Kind.PayloadGate) r.publication.finalValidatedAtEpochMs = 10000; }, "publication_authority_time");
    fails(() => {}, "payload_gate_missing", { preparation: Preparation.ServiceAdmitted, payloadGateCreated: false });
  });
  it("never discovers a sibling/replacement through a shared creator or omits a companion/partial reservation", () => {
    const f = fixture({ runtimeProviders: true });
    const omitted = f.records.filter(r => r.kind !== Kind.Reservation || r.data.reservationId !== U("4"));
    expect(validateScopedRetainedChain(omitted, f.expected, Mode.ReadOnlyHistoricalData, 99000).state).toBe(RetainedChainState.Incomplete);
    fails(r => { if (r.kind === Kind.Closure) r.data.reservationDigests.pop(); }, "closure_reservations", { runtimeProviders: true });
    fails(r => { if (r.kind === Kind.Closure) r.data.preparations.pop(); }, "preparation_completeness", { runtimeProviders: true, preparation: Preparation.Reserved });
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions.pop(); }, "discharge_completeness", { preparation: Preparation.Reserved });
    const foreign = structuredClone(f.records[1]!) as Mutable<ScopedRetainedRecord>; foreign.targetDigest = H("f"); foreign.publication.generation = 201;
    expect(() => validateScopedRetainedChain([...f.records, foreign], f.expected, Mode.ReadOnlyHistoricalData, 99000)).toThrow("foreign_target");
    const relabeled = structuredClone(f.records.find(r => r.kind === Kind.Reservation)!) as Mutable<ScopedRetainedRecord>; relabeled.publication.generation = 200;
    expect(() => validateScopedRetainedChain([...f.records, relabeled], f.expected, Mode.ReadOnlyHistoricalData, 99000)).toThrow("foreign_inventory");
  });
  it("enforces both admission gates and the closed all-task graph", () => {
    fails(r => { if (r.kind === Kind.Closure) r.data.preparations[0]!.enqueueReleasedAtEpochMs = 601; }, "enqueue_gate_time");
    fails(r => { if (r.kind === Kind.Closure) r.data.preparations[0]!.payloadReleasedAtEpochMs = 801; }, "payload_gate_time");
    fails(r => { if (r.kind === Kind.Closure) r.data.preparations[0]!.enqueueReleasedAtEpochMs = 5600; }, "enqueue_gate_time");
    fails(r => { if (r.kind === Kind.ActorAdmission) r.data.tasks[1]!.actorPidBirth = "999:99"; }, "task_graph");
    fails(r => { if (r.kind === Kind.ActorAdmission) r.data.finalHeldRereadAtEpochMs = 599; }, "held_actor_binding");
    fails(r => { if (r.kind === Kind.ActorAdmission) r.data.originalGateDigest = H("f"); }, "held_actor_binding");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.serviceObservation = null; }, "historical_service", { preparation: Preparation.EnqueueReleased });
  });
  it("requires positive retained actor discharge: natural pidfd exit needs no present PID/procfs, surviving actors cannot disappear", () => {
    const f = fixture({ preparation: Preparation.ActorsHeld });
    expect(read(f).state).toBe(RetainedChainState.CompleteData);
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.discharge!.actors.pop(); }, "array_bound");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.discharge!.actors[1]!.method = DischargeMethod.ScopedAdmissionFence; }, "actor_discharge_invalid");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.discharge!.fenceDigest = H("f"); }, "actor_fence");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.discharge = null; }, "actor_discharge_missing");
  });
  it("does not let a discharged wrapper erase its still obligated enqueue descendant", () => {
    const graph: Edit = r => {
      if (r.kind === Kind.ActorAdmission) {
        r.data.chain.actors[1]!.role = ActorRole.Wrapper;
        r.data.chain.actors.push({ role: ActorRole.ManagerSubmitter, pidBirth: "102:12", controlGroup: "/TEST-root-owner.service", parentPidBirth: "101:11" });
        r.data.tasks.push({ actorPidBirth: "102:12", taskBirths: ["102:12"] });
      }
    };
    expect(read(fixture({ edit: graph })).state).toBe(RetainedChainState.CompleteData);
    fails(r => { graph(r); if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.discharge!.actors.pop(); }, "actor_discharge_incomplete");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.dischargedAtEpochMs = 6100; }, "actor_discharge_missing");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.dispositions[0]!.dischargedAtEpochMs = 6700; }, "queue_not_empty");
  });
  it("requires actual service anchor, leaf identity, payload ancestry and effective-filter admission even after service GC", () => {
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.invocationAnchor.invocationId = I("f"); }, "service_leaf_binding");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.controlGroup = r.data.controlGroup.slice(0, r.data.controlGroup.lastIndexOf("/")); }, "service_leaf_binding");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.effectiveFilterPolicyDigest = H("f"); }, "service_leaf_binding");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.effectiveFilterAttachments = []; }, "array_bound");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.effectiveFilterAttachments = [H("a")]; }, "leaf_filters");
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.data.payloadAncestry[0]!.controlGroup = "/TEST-foreign.service"; }, "payload_ancestry");
  });
  it("checks every recursively collected owned leaf and descendant without adopting a changed leaf", () => {
    const tree: Edit = r => {
      if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) {
        const resource = r.data.resources[0]!, root = resource.nodes[0]!, unit = r.data.queueBefore.relevantUnits[0]!;
        root.children = [unit];
        resource.nodes.push({ path: root.path + "/" + unit, kernel: { device: 29, inode: 9000 }, events: "populated 0\n", processes: "", children: ["nested"] });
        resource.nodes.push({ path: root.path + "/" + unit + "/nested", kernel: { device: 29, inode: 9001 }, events: "populated 0\n", processes: "", children: [] });
      }
    };
    expect(read(fixture({ edit: tree })).state).toBe(RetainedChainState.CompleteData);
    fails(r => { tree(r); if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[2]!.events = "populated 1\n"; }, "recursive_population");
    fails(r => { tree(r); if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[1]!.kernel.inode++; }, "leaf_incarnation");
    fails(r => { tree(r); if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes.shift(); }, "parent_present");
  });
  it("rejects populated parent despite empty root procs, missing/recreated parents and incomplete/foreign recursion", () => {
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[0]!.events = "populated 1\nfrozen 0\n"; }, "recursive_population");
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.identityAfter.kernel.inode++; }, "parent_incarnation");
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes = []; }, "array_bound");
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[0]!.children = ["missing.service"]; }, "recursive_traversal_incomplete");
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) {
      const resource = r.data.resources[0]!, root = resource.nodes[0]!;
      root.children = ["TEST-foreign.service"]; resource.nodes.push({ ...structuredClone(root), path: root.path + "/TEST-foreign.service", children: [] });
    } }, "foreign_cgroup");
    fails(r => { if (r.kind === Kind.EmptyProof && r.data.resources[0]!.disposition === Disposition.PositiveEmpty) r.data.resources[0]!.nodes[0]!.events = "ENODEV"; }, "text");
  });
  it("requires complete exact relevant queues before/after recursive collection and teardown", () => {
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.queueAfter.relevantUnits.pop(); }, "queue_units");
    fails(r => { if (r.kind === Kind.EmptyProof) r.data.queueAfter.jobs.push({ jobId: 77, unit: r.data.queueAfter.relevantUnits[0]! }); }, "queue_not_empty");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.queueAfter.jobs.push({ jobId: 40, unit: "TEST-foreign.service" }); }, "retirement_queue_reobservation");
  });
  it("allows ENODEV/path absence only AFTER durable empty proof and intent with matching original pins and independent manager facts", () => {
    fails(r => { if (r.kind === Kind.RetirementIntent) r.publication.admittedAtEpochMs = 7001; }, "publication_order");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects[0]!.submittedAtEpochMs = 8001; }, "retirement_effect_order");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects.reverse(); }, "retirement_effect_order");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.resources[0]!.slice.originalInvocationId = I("f"); }, "manager_retirement_identity");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.resources[0]!.kernel.pinnedDirectory.inode++; }, "pinned_retirement_identity");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.resources[0]!.kernel.eventsCustodyDigest = H("f"); }, "pinned_retirement_identity");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.resources = []; }, "retirement_resource_completeness");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects[0]!.acceptedJobId = null; }, "retirement_effect_order");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects[1]!.sliceIdentityBefore!.kernel.inode++; }, "retirement_pre_effect_identity");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects[0]!.targetDependencyDigestBefore = H("f"); }, "retirement_pre_effect_identity");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.resources[0]!.target.observedAtEpochMs = 8400; }, "target_retired_before_slice_effect");
  });
  it.each([Kind.Closure, Kind.ResourceBinding, Kind.ActorAdmission, Kind.ServiceAdmission, Kind.RetirementIntent, Kind.RetirementFacts,
    Kind.RetirementPublication, Kind.FinalReceipt, Kind.OrdinaryTerminal, Kind.KeyedTerminal])("missing %s remains incomplete at the owning historical reader", kind => {
    const f = fixture({ keyed: true });
    f.records = f.records.filter(r => r.kind !== kind);
    expect(read(f).state).toBe(RetainedChainState.Incomplete);
  });
  it("does not accept missing original obligations, final references or keyed CAS companions", () => {
    fails(r => { if (r.kind === Kind.FinalReceipt) r.data.retirementPublicationDigest = H("f"); }, "final_chain");
    fails(r => { if (r.kind === Kind.KeyedTerminal) r.data.ordinaryTerminalDigests = []; }, "keyed_ordinary_successors", { keyed: true });
    fails(r => { if (r.kind === Kind.KeyedTerminal) r.data.dispatchIntentDigest = H("f"); }, "keyed_successor", { keyed: true });
  });
  it("rejects live reads at/after original expiry and every late durability/finalization boundary even in historical mode", () => {
    const f = fixture();
    expect(() => read(f, Mode.LiveData, 20000)).toThrow("expired_live_data");
    expect(() => read(f, Mode.LiveData, 20001)).toThrow("expired_live_data");
    expect(() => read(f, Mode.LiveData, 11000)).toThrow("future_publication");
    for (const kind of [Kind.EmptyProof, Kind.RetirementIntent, Kind.RetirementFacts, Kind.RetirementPublication, Kind.FinalReceipt, Kind.OrdinaryTerminal, Kind.KeyedTerminal]) {
      fails(r => { if (r.kind === kind) { r.publication.durableAtEpochMs = 20000; r.publication.finalValidatedAtEpochMs = 20000; } }, "publication_authority_time", { keyed: true });
    }
    fails(r => { if (r.kind === Kind.ServiceAdmission) r.publication.finalValidatedAtEpochMs = 10000; }, "publication_authority_time");
    fails(r => { if (r.kind === Kind.RetirementFacts) r.data.effects[1]!.completedAtEpochMs = 20000; }, "retirement_effect_order");
  });
  it("does not renew original cleanup attempt, allowance, deadline, N or join binding", () => {
    const f = fixture();
    const original = f.expected.attemptDigest;
    for (const field of ["endEpochMs", "totalAllowanceMs", "N"] as const) {
      const changed = fixture({ edit: r => { if (r.kind === Kind.Target) r.data.cleanupAttempt[field]++; } });
      changed.expected = { ...changed.expected, attemptDigest: original };
      expect(() => read(changed)).toThrow("original_attempt");
    }
    fails(r => { if (r.kind === Kind.FinalReceipt) r.data.attemptDigest = H("f"); }, "renewed_attempt");
    const joined = read(f, Mode.LiveData, 16000);
    expect(joined).toEqual(read(f, Mode.LiveData, 16001));
    expect(f.records[0]!.data).toMatchObject({ cleanupAttempt: { N: 7, totalAllowanceMs: 15000, endEpochMs: 20000 } });
  });
  it("leaves v1 valid behavior unchanged and never promotes failed v1 evidence into v2", () => {
    const identity = { scopeDigest: H("a"), installationId: "TEST-i", hostId: "TEST-h", bootId: "TEST-b", supervisorId: "48:100", supervisorUnit: "TEST-root.service",
      supervisorControlGroup: "/TEST-root.service", accountId: "TEST-a", grantDigest: H("b"), inventoryDigest: H("c"), sourceSha: "a".repeat(40), artifactSha: H("d"), deadlineEpochMs: 9999,
      authorityDigest: H("e"), slotId: "TEST-slot", parentStartId: U("1"), dispatchIntentGeneration: 1 };
    const correlation = { schemaVersion: 1 as const, kind: ScopedTerminationKind.Runtime, identity, startId: U("1"), startDigest: H("f"), parentStartDigest: H("f"), reservationGeneration: 1,
      unit: `subscription-runtime-ordinary-${U("1")}.service`, controlGroup: `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-ordinary-${U("1")}.service`,
      creatorPidBirth: "48:100", creatorControlGroup: "/TEST-root.service" };
    expect(parseScopedStartCorrelation(correlation)).toEqual(correlation);
    const submitter = { pidBirth: "49:101", controlGroup: "/TEST-root.service" };
    const member = { ...correlation, invocationId: I("a"), submitterDigest: scopedDigest(submitter) };
    const chain = { schemaVersion: 1 as const, correlationDigest: scopedDigest(correlation), submitterDigest: member.submitterDigest, actors: [
      { role: ActorRole.Creator, pidBirth: "48:100", controlGroup: "/TEST-root.service", parentPidBirth: null },
      { role: ActorRole.ManagerSubmitter, ...submitter, parentPidBirth: "48:100" },
    ] };
    const observed = { hostId: identity.hostId, bootId: identity.bootId, supervisorBirth: identity.supervisorId, supervisorGroup: identity.supervisorControlGroup,
      invocationId: member.invocationId, invocationAnchor: { invocationId: member.invocationId, device: 29, inode: 99 }, unitGroup: member.controlGroup, creatorBirth: correlation.creatorPidBirth, creatorGroup: correlation.creatorControlGroup };
    const evidence = { schemaVersion: 1 as const, memberDigest: scopedDigest(member), chain,
      discharge: { schemaVersion: 2 as const, chainDigest: scopedDigest(chain), fenceDigest: H("a"), actors: chain.actors.map((a, i) => ({ ...a, method: i === 0 ? DischargeMethod.ScopedAdmissionFence : DischargeMethod.PidfdExit })) },
      identityBefore: observed, identityAfter: observed, queueBefore: "", queueAfter: "", cgroups: [{ path: member.controlGroup, device: 29, inode: 100, events: "populated 0\n", processes: "", children: [] }] };
    expect(() => validateScopedCollectedEvidence(evidence, member)).not.toThrow();
    const operation = { schemaVersion: 1, identity, operationGeneration: 1, members: [member] };
    expect(parseScopedOperation(operation).members).toHaveLength(1);
    const receipt = { schemaVersion: 1, outcome: "receipt_backed", operation, publicationGeneration: 2,
      observations: [{ startId: member.startId, identityUnchanged: true, creatorFenced: true, queueEmpty: true, recursiveEmpty: true, digest: scopedDigest(evidence), evidence }] };
    expect(parseScopedReceipt(receipt).schemaVersion).toBe(1);
    const missingAnchor = { ...evidence, identityAfter: { ...observed, invocationAnchor: null } };
    expect(() => validateScopedCollectedEvidence(missingAnchor as unknown as typeof evidence, member)).toThrow();
    expect(() => validateScopedCollectedEvidence({ ...evidence, cgroups: [] }, member)).toThrow();
    expect(() => parseScopedRetainedRecord(missingAnchor)).toThrow("fields");
    expect(() => parseScopedRetainedRecord(evidence)).toThrow("fields");
    expect(() => parseScopedRetainedRecord(receipt)).toThrow("fields");
    expect(() => parseScopedStartCorrelation(fixture().records[0])).toThrow();
  });
});
