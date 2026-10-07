// Report-only orchestration policy. The caller must authenticate runtime facts;
// neither a QualifiedIdle fact nor this report is an admission/eviction permit.
// Each actual effect still requires the runtime's fresh exclusion/provenance checks.
export enum DependencyRetentionFactState {
  QualifiedIdle = "qualified_idle", Active = "active", Unknown = "unknown",
  Unverified = "unverified", Mutated = "mutated", Held = "held",
}
export enum DependencyRetentionHold {
  Consumer = "consumer", Preservation = "preservation",
  UnresolvedOperation = "unresolved_operation",
}
export enum DependencyRetentionPressure { Idle = "idle", Reclaiming = "reclaiming" }
export enum DependencyRetentionReportStatus { Reported = "reported", Blocked = "blocked" }
export enum DependencyRetentionReportReason {
  MissingConfiguration = "missing_configuration", InvalidConfiguration = "invalid_configuration",
  MissingMeasurements = "missing_measurements", InvalidMeasurements = "invalid_measurements",
  InvalidState = "invalid_state", InvalidFacts = "invalid_facts", CandidateFactBound = "candidate_fact_bound",
  Disabled = "disabled", NoPressure = "no_pressure", NoQualifiedCandidates = "no_qualified_candidates",
  UnknownObservationCost = "unknown_observation_cost", ObservationTimeBound = "observation_time_bound",
  EstimatedByteBound = "estimated_byte_bound", CandidateCountBound = "candidate_count_bound",
  TargetEstimated = "target_estimated", Exhausted = "exhausted",
}

export type DependencyRetentionPolicyConfiguration = {
  readonly version: 1;
  readonly managedReadyEnabled: boolean;
  readonly evictionEnabled?: boolean; // Omission remains off, even for report recommendations.
  readonly warmIdleBudgetStartBytes: string;
  readonly warmIdleBudgetStopBytes: string;
  readonly pressureLowAvailableBytes: string;
  readonly pressureStopAvailableBytes: string;
  readonly maxCandidateFacts: number;
  readonly maxCandidates: number;
  readonly maxEstimatedBatchBytes: string;
  // Bounds accrued adapter-observed report scan cost, not a future unlink deadline.
  readonly maxBatchDurationMs: string;
};
export type DependencyRetentionHeadroomMeasurements = {
  readonly measurementId: string;
  readonly restorePeakBytes: string;
  readonly requestedJobHeadroomBytes: string;
};
export type DependencyRetentionPressureState = {
  readonly pressure: DependencyRetentionPressure;
  readonly warmBudget: DependencyRetentionPressure;
};
export type DependencyRetentionCandidateFact = {
  readonly candidateId: string;
  readonly factRevision: string;
  readonly state: DependencyRetentionFactState;
  // After complete dependency proof, source/output/job custody alone cannot create
  // a hard hold. Preservation means actual dependency-byte/mutation preservation;
  // unqualified readers remain Active/Unknown facts rather than custody-derived holds.
  readonly holds: readonly DependencyRetentionHold[];
  // Verified allocated estimate, not logical file size or guaranteed freed bytes.
  readonly estimatedAllocatedBytes: string;
  // Actual observed scan cost supplied by an adapter. Null means unmeasured.
  readonly observedScanCostMs: string | null;
  // Actual consumer entry/release only. Missing activity ranks last, never qualifies a tree.
  readonly lastConsumerEntryAtMs: string | null;
  readonly lastConsumerReleaseAtMs: string | null;
};
export type DependencyRetentionRuntimeFacts = {
  readonly observedAtMs: string;
  readonly availableBytes: string;
  readonly warmIdleAllocatedBytes: string;
  readonly candidates: readonly DependencyRetentionCandidateFact[];
};
export type DependencyRetentionRecommendation = {
  readonly candidateId: string;
  readonly factRevision: string;
  readonly estimatedAllocatedBytes: string;
};
export type DependencyRetentionReport = {
  readonly status: DependencyRetentionReportStatus;
  readonly reason: DependencyRetentionReportReason;
  readonly evictionEnabled: boolean;
  readonly recommendations: readonly DependencyRetentionRecommendation[];
} & (
  | { readonly status: DependencyRetentionReportStatus.Blocked }
  | { readonly status: DependencyRetentionReportStatus.Reported;
      readonly nextState: DependencyRetentionPressureState;
      readonly admissionFloorBytes: string;
      readonly recoveryTargetAvailableBytes: string;
      readonly targetEstimatedBytes: string;
      readonly selectedEstimatedBytes: string;
      readonly accruedObservedScanCostMs: string | null;
      readonly qualifiedCandidateCount: number;
      readonly excludedCounts: Readonly<Record<DependencyRetentionFactState, number>> }
);

const ADMISSION_FLOOR_BYTES = 5n * 1024n ** 3n;
// A bounded decimal representation, not a storage/time policy default.
const DECIMAL = /^(?:0|[1-9][0-9]{0,127})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONFIG_KEYS = ["version", "managedReadyEnabled", "evictionEnabled", "warmIdleBudgetStartBytes",
  "warmIdleBudgetStopBytes", "pressureLowAvailableBytes", "pressureStopAvailableBytes", "maxCandidateFacts",
  "maxCandidates", "maxEstimatedBatchBytes", "maxBatchDurationMs"];
type ParsedConfiguration = {
  readonly enabled: boolean; readonly warmStart: bigint; readonly warmStop: bigint;
  readonly pressureLow: bigint; readonly pressureStop: bigint; readonly maxFacts: number;
  readonly maxCandidates: number; readonly maxBytes: bigint; readonly maxDurationMs: bigint;
};
type ParsedCandidate = { readonly fact: DependencyRetentionCandidateFact;
  readonly bytes: bigint; readonly cost: bigint | null; readonly activity: bigint | null };
type ParsedFacts = { readonly available: bigint; readonly warmBytes: bigint;
  readonly candidates: readonly ParsedCandidate[] };

export function selectDependencyRetentionReport(input: {
  readonly configuration?: unknown;
  readonly measurements?: unknown;
  readonly previousState: DependencyRetentionPressureState;
  readonly facts: DependencyRetentionRuntimeFacts;
}): DependencyRetentionReport {
  const configuration = parseConfiguration(input.configuration);
  if (!configuration) return blocked(input.configuration == null
    ? DependencyRetentionReportReason.MissingConfiguration : DependencyRetentionReportReason.InvalidConfiguration);
  const recoveryTarget = parseHeadroom(input.measurements);
  if (recoveryTarget === null) return blocked(input.measurements == null
    ? DependencyRetentionReportReason.MissingMeasurements : DependencyRetentionReportReason.InvalidMeasurements);
  if (configuration.pressureStop < recoveryTarget) return blocked(DependencyRetentionReportReason.InvalidConfiguration);
  if (!validPressureState(input.previousState)) return blocked(DependencyRetentionReportReason.InvalidState);
  if (Array.isArray(input.facts?.candidates) && input.facts.candidates.length > configuration.maxFacts) {
    return blocked(DependencyRetentionReportReason.CandidateFactBound);
  }
  const facts = parseFacts(input.facts);
  if (!facts) return blocked(DependencyRetentionReportReason.InvalidFacts);
  const nextState = {
    pressure: nextPressure(input.previousState.pressure, facts.available < configuration.pressureLow,
      facts.available >= configuration.pressureStop),
    warmBudget: nextPressure(input.previousState.warmBudget, facts.warmBytes > configuration.warmStart,
      facts.warmBytes <= configuration.warmStop),
  };
  const pressureTarget = nextState.pressure === DependencyRetentionPressure.Reclaiming
    ? nonnegative(configuration.pressureStop - facts.available) : 0n;
  const warmTarget = nextState.warmBudget === DependencyRetentionPressure.Reclaiming
    ? nonnegative(facts.warmBytes - configuration.warmStop) : 0n;
  const target = pressureTarget > warmTarget ? pressureTarget : warmTarget;
  const excludedCounts: Record<DependencyRetentionFactState, number> = {
    qualified_idle: 0, active: 0, unknown: 0, unverified: 0, mutated: 0, held: 0,
  };
  const qualified: ParsedCandidate[] = [];
  let cost: bigint | null = 0n;
  for (const candidate of facts.candidates) {
    cost = cost === null || candidate.cost === null ? null : cost + candidate.cost;
    if (candidate.fact.state === DependencyRetentionFactState.QualifiedIdle && candidate.fact.holds.length === 0) {
      qualified.push(candidate);
    } else {
      const state = candidate.fact.holds.length > 0 ? DependencyRetentionFactState.Held : candidate.fact.state;
      excludedCounts[state] += 1;
    }
  }
  const recommendations: DependencyRetentionRecommendation[] = [];
  let selected = 0n;
  const finish = (reason: DependencyRetentionReportReason): DependencyRetentionReport => ({
    status: DependencyRetentionReportStatus.Reported, reason, evictionEnabled: configuration.enabled,
    recommendations, nextState, admissionFloorBytes: ADMISSION_FLOOR_BYTES.toString(),
    recoveryTargetAvailableBytes: recoveryTarget.toString(), targetEstimatedBytes: target.toString(),
    selectedEstimatedBytes: selected.toString(), accruedObservedScanCostMs: cost?.toString() ?? null,
    qualifiedCandidateCount: qualified.length, excludedCounts,
  });
  if (!configuration.enabled) return finish(DependencyRetentionReportReason.Disabled);
  if (target === 0n) return finish(DependencyRetentionReportReason.NoPressure);
  if (qualified.length === 0) return finish(DependencyRetentionReportReason.NoQualifiedCandidates);
  if (cost === null) return finish(DependencyRetentionReportReason.UnknownObservationCost);
  if (cost > configuration.maxDurationMs) return finish(DependencyRetentionReportReason.ObservationTimeBound);
  // An actual last consumer event ranks older trees first; ID breaks ties only.
  qualified.sort(compareActivity);
  let byteBound = false;
  for (const candidate of qualified) {
    if (selected >= target) return finish(DependencyRetentionReportReason.TargetEstimated);
    if (recommendations.length === configuration.maxCandidates) return finish(DependencyRetentionReportReason.CandidateCountBound);
    if (candidate.bytes === 0n) continue;
    if (selected + candidate.bytes > configuration.maxBytes) { byteBound = true; continue; }
    recommendations.push({ candidateId: candidate.fact.candidateId, factRevision: candidate.fact.factRevision,
      estimatedAllocatedBytes: candidate.bytes.toString() });
    selected += candidate.bytes;
  }
  return finish(selected >= target ? DependencyRetentionReportReason.TargetEstimated
    : byteBound ? DependencyRetentionReportReason.EstimatedByteBound : DependencyRetentionReportReason.Exhausted);
}

function parseConfiguration(value: unknown): ParsedConfiguration | null {
  if (!record(value) || !onlyKeys(value, CONFIG_KEYS, ["evictionEnabled"]) || value.version !== 1
    || typeof value.managedReadyEnabled !== "boolean"
    || (value.evictionEnabled !== undefined && typeof value.evictionEnabled !== "boolean")) return null;
  const warmStart = decimal(value.warmIdleBudgetStartBytes), warmStop = decimal(value.warmIdleBudgetStopBytes);
  const pressureLow = decimal(value.pressureLowAvailableBytes), pressureStop = decimal(value.pressureStopAvailableBytes);
  const maxBytes = decimal(value.maxEstimatedBatchBytes), maxDurationMs = decimal(value.maxBatchDurationMs);
  if (warmStart === null || warmStop === null || pressureLow === null || pressureStop === null
    || maxBytes === null || maxDurationMs === null || warmStart <= warmStop
    || pressureLow < ADMISSION_FLOOR_BYTES || pressureStop <= pressureLow || maxBytes === 0n || maxDurationMs === 0n
    || !positiveCount(value.maxCandidateFacts) || !positiveCount(value.maxCandidates)
    || value.maxCandidates > value.maxCandidateFacts) return null;
  return { enabled: value.managedReadyEnabled && value.evictionEnabled === true, warmStart, warmStop,
    pressureLow, pressureStop, maxFacts: value.maxCandidateFacts, maxCandidates: value.maxCandidates,
    maxBytes, maxDurationMs };
}
function parseHeadroom(value: unknown): bigint | null {
  if (!record(value) || !onlyKeys(value, ["measurementId", "restorePeakBytes", "requestedJobHeadroomBytes"])
    || !identifier(value.measurementId)) return null;
  const restore = decimal(value.restorePeakBytes), job = decimal(value.requestedJobHeadroomBytes);
  return restore === null || job === null ? null : ADMISSION_FLOOR_BYTES + restore + job;
}
function parseFacts(value: unknown): ParsedFacts | null {
  if (!record(value) || !onlyKeys(value, ["observedAtMs", "availableBytes", "warmIdleAllocatedBytes", "candidates"])
    || !Array.isArray(value.candidates)) return null;
  const now = decimal(value.observedAtMs), available = decimal(value.availableBytes), warmBytes = decimal(value.warmIdleAllocatedBytes);
  if (now === null || available === null || warmBytes === null) return null;
  const candidates: ParsedCandidate[] = [], ids = new Set<string>();
  for (const fact of value.candidates) {
    if (!record(fact) || !onlyKeys(fact, ["candidateId", "factRevision", "state", "holds", "estimatedAllocatedBytes",
      "observedScanCostMs", "lastConsumerEntryAtMs", "lastConsumerReleaseAtMs"])
      || !identifier(fact.candidateId) || !identifier(fact.factRevision) || ids.has(fact.candidateId)
      || !Object.values(DependencyRetentionFactState).includes(fact.state as DependencyRetentionFactState)
      || !Array.isArray(fact.holds) || fact.holds.length > Object.values(DependencyRetentionHold).length
      || new Set(fact.holds).size !== fact.holds.length
      || fact.holds.some((hold) => !Object.values(DependencyRetentionHold).includes(hold))) return null;
    const bytes = decimal(fact.estimatedAllocatedBytes), cost = decimal(fact.observedScanCostMs);
    const entry = decimal(fact.lastConsumerEntryAtMs), release = decimal(fact.lastConsumerReleaseAtMs);
    if (bytes === null || (fact.observedScanCostMs !== null && cost === null)
      || (fact.lastConsumerEntryAtMs !== null && entry === null) || (fact.lastConsumerReleaseAtMs !== null && release === null)
      || (entry !== null && entry > now) || (release !== null && release > now)) return null;
    ids.add(fact.candidateId);
    const validatedFact: DependencyRetentionCandidateFact = {
      candidateId: fact.candidateId, factRevision: fact.factRevision,
      state: fact.state as DependencyRetentionFactState, holds: [...fact.holds] as DependencyRetentionHold[],
      estimatedAllocatedBytes: bytes.toString(), observedScanCostMs: cost?.toString() ?? null,
      lastConsumerEntryAtMs: entry?.toString() ?? null, lastConsumerReleaseAtMs: release?.toString() ?? null,
    };
    candidates.push({ fact: validatedFact, bytes, cost,
      activity: entry === null ? release : release === null || entry > release ? entry : release });
  }
  return { available, warmBytes, candidates };
}
function compareActivity(left: ParsedCandidate, right: ParsedCandidate): number {
  if (left.activity !== right.activity) {
    if (left.activity === null) return 1;
    if (right.activity === null) return -1;
    return left.activity < right.activity ? -1 : 1;
  }
  return left.fact.candidateId < right.fact.candidateId ? -1 : left.fact.candidateId > right.fact.candidateId ? 1 : 0;
}
function nextPressure(prior: DependencyRetentionPressure, start: boolean, stop: boolean): DependencyRetentionPressure {
  return prior === DependencyRetentionPressure.Reclaiming ? (stop ? DependencyRetentionPressure.Idle : prior)
    : start ? DependencyRetentionPressure.Reclaiming : prior;
}
function validPressureState(value: unknown): value is DependencyRetentionPressureState {
  return record(value) && onlyKeys(value, ["pressure", "warmBudget"])
    && Object.values(DependencyRetentionPressure).includes(value.pressure as DependencyRetentionPressure)
    && Object.values(DependencyRetentionPressure).includes(value.warmBudget as DependencyRetentionPressure);
}
function blocked(reason: DependencyRetentionReportReason): DependencyRetentionReport {
  return { status: DependencyRetentionReportStatus.Blocked, reason, evictionEnabled: false, recommendations: [] };
}
function decimal(value: unknown): bigint | null { return typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : null; }
function nonnegative(value: bigint): bigint { return value > 0n ? value : 0n; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => optional.includes(key) || Object.prototype.hasOwnProperty.call(value, key));
}
function identifier(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function positiveCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
