import { describe, expect, it } from "vitest";
import {
  DependencyRetentionFactState as FactState, DependencyRetentionHold as Hold,
  DependencyRetentionPressure as Pressure, DependencyRetentionReportReason as Reason,
  DependencyRetentionReportStatus as Status, selectDependencyRetentionReport,
  type DependencyRetentionCandidateFact, type DependencyRetentionPolicyConfiguration,
  type DependencyRetentionPressureState, type DependencyRetentionReport,
} from "../../../worker-core/dependency-environment/domain/dependency-retention-policy";

const configuration: DependencyRetentionPolicyConfiguration = {
  version: 1, managedReadyEnabled: true, evictionEnabled: true,
  warmIdleBudgetStartBytes: "1000", warmIdleBudgetStopBytes: "400",
  pressureLowAvailableBytes: "5368709120", pressureStopAvailableBytes: "6000000000",
  maxCandidateFacts: 16, maxCandidates: 3, maxEstimatedBatchBytes: "1000", maxBatchDurationMs: "100",
};
const measurements = { measurementId: "TEST-measured-headroom", restorePeakBytes: "100000000",
  requestedJobHeadroomBytes: "200000000" };
const idle: DependencyRetentionPressureState = { pressure: Pressure.Idle, warmBudget: Pressure.Idle };
const reclaiming: DependencyRetentionPressureState = { pressure: Pressure.Reclaiming, warmBudget: Pressure.Reclaiming };
function candidate(candidateId: string, changes: Partial<DependencyRetentionCandidateFact> = {}): DependencyRetentionCandidateFact {
  return { candidateId, factRevision: "TEST-runtime-revision-7", state: FactState.QualifiedIdle, holds: [],
    estimatedAllocatedBytes: "300", observedScanCostMs: "10", lastConsumerEntryAtMs: "100",
    lastConsumerReleaseAtMs: "200", ...changes };
}
function report(input: {
  configuration?: unknown; measurements?: unknown; previousState?: DependencyRetentionPressureState;
  candidates?: readonly DependencyRetentionCandidateFact[]; availableBytes?: string; warmIdleAllocatedBytes?: string;
} = {}): DependencyRetentionReport {
  return selectDependencyRetentionReport({
    configuration: "configuration" in input ? input.configuration : configuration,
    measurements: "measurements" in input ? input.measurements : measurements,
    previousState: input.previousState ?? idle,
    facts: { observedAtMs: "10000", availableBytes: input.availableBytes ?? "7000000000",
      warmIdleAllocatedBytes: input.warmIdleAllocatedBytes ?? "1100", candidates: input.candidates ?? [candidate("TEST-a")] },
  });
}
function reported(value: DependencyRetentionReport) {
  expect(value.status).toBe(Status.Reported);
  if (value.status !== Status.Reported) throw new Error("TEST expected a factual report");
  return value;
}

// Regression boundaries: factual exclusion, thresholds, ranking and integer
// accounting. These pure TEST fixtures do not open or launch any workspace.
describe("report-only dependency retention policy", () => {
  it("never turns old active, unknown, unverified, mutated or held facts into recommendations", () => {
    const excluded = [FactState.Active, FactState.Unknown, FactState.Unverified, FactState.Mutated, FactState.Held]
      .map((state) => candidate(`TEST-${state}`, { state, lastConsumerEntryAtMs: "0", lastConsumerReleaseAtMs: "1" }));
    const withHold = candidate("TEST-protected", { holds: [Hold.Preservation], lastConsumerReleaseAtMs: "1" });
    const result = reported(report({ candidates: [...excluded, withHold, candidate("TEST-qualified")] }));
    expect(result.recommendations.map((item) => item.candidateId)).toEqual(["TEST-qualified"]);
    expect(result.qualifiedCandidateCount).toBe(1);
    expect(result.excludedCounts).toEqual({ qualified_idle: 0, active: 1, unknown: 1, unverified: 1, mutated: 1, held: 2 });
    expect(result.selectedEstimatedBytes).toBe("300");
  });

  it("age is only ranking: recent qualification is reportable and missing history supplies no qualification", () => {
    const result = reported(report({ candidates: [
      candidate("TEST-old-unknown", { state: FactState.Unknown, lastConsumerReleaseAtMs: "1" }),
      candidate("TEST-recent-qualified", { lastConsumerEntryAtMs: "9998", lastConsumerReleaseAtMs: "9999" }),
      candidate("TEST-no-history", { state: FactState.Unverified, lastConsumerEntryAtMs: null, lastConsumerReleaseAtMs: null }),
    ] }));
    expect(result.recommendations.map((item) => item.candidateId)).toEqual(["TEST-recent-qualified"]);
    expect(result.excludedCounts.unknown).toBe(1);
    expect(result.excludedCounts.unverified).toBe(1);
  });

  it("default-off and managed-ready-off keep factual counts without recommending an effect", () => {
    const { evictionEnabled: _unused, ...defaultOff } = configuration;
    for (const disabled of [defaultOff, { ...configuration, evictionEnabled: false },
      { ...configuration, managedReadyEnabled: false }]) {
      const result = reported(report({ configuration: disabled, candidates: [candidate("TEST-a"), candidate("TEST-b")] }));
      expect(result.evictionEnabled).toBe(false);
      expect(result.reason).toBe(Reason.Disabled);
      expect(result.qualifiedCandidateCount).toBe(2);
      expect(result.recommendations).toEqual([]);
      expect(result.nextState.warmBudget).toBe(Pressure.Reclaiming);
    }
  });

  it("missing configuration or measurements cannot inherit a destructive default", () => {
    expect(report({ configuration: undefined })).toEqual({ status: Status.Blocked,
      reason: Reason.MissingConfiguration, evictionEnabled: false, recommendations: [] });
    expect(report({ measurements: undefined }).reason).toBe(Reason.MissingMeasurements);
    expect(report({ measurements: { ...measurements, measurementId: "" } }).reason).toBe(Reason.InvalidMeasurements);
  });

  it("pressure and warm-budget hysteresis remain active between watermarks and stop at the stop boundary", () => {
    const start = reported(report({ availableBytes: "5368709119", warmIdleAllocatedBytes: "1001" }));
    expect(start.nextState).toEqual(reclaiming);
    const between = reported(report({ previousState: start.nextState, availableBytes: "5800000000", warmIdleAllocatedBytes: "800" }));
    expect(between.nextState).toEqual(reclaiming);
    const sameMeasurementsWithoutPriorPressure = reported(report({ availableBytes: "5800000000", warmIdleAllocatedBytes: "800" }));
    expect(sameMeasurementsWithoutPriorPressure.nextState).toEqual(idle);
    expect(sameMeasurementsWithoutPriorPressure.reason).toBe(Reason.NoPressure);
    const stop = reported(report({ previousState: between.nextState, availableBytes: "6000000000", warmIdleAllocatedBytes: "400" }));
    expect(stop.nextState).toEqual(idle);
    expect(stop.recommendations).toEqual([]);
    const restartBoundary = reported(report({ previousState: stop.nextState, availableBytes: "5368709120", warmIdleAllocatedBytes: "1000" }));
    expect(restartBoundary.nextState).toEqual(idle);
  });

  it("measured headroom raises only the recovery target while the owner admission floor remains 5 GiB", () => {
    const result = reported(report());
    expect(result.admissionFloorBytes).toBe("5368709120");
    expect(result.recoveryTargetAvailableBytes).toBe("5668709120");
    expect(report({ configuration: { ...configuration, pressureStopAvailableBytes: "5500000000" } }).reason)
      .toBe(Reason.InvalidConfiguration);
    // No artificial 30 GiB minimum: the explicit measured 6 GB stop is valid.
    expect(result.status).toBe(Status.Reported);
  });

  it("uses actual last entry/release, then stable IDs, independent of inventory order", () => {
    const facts = [candidate("TEST-z", { lastConsumerReleaseAtMs: "500" }),
      candidate("TEST-new-entry", { lastConsumerEntryAtMs: "900", lastConsumerReleaseAtMs: "200" }),
      candidate("TEST-a", { lastConsumerReleaseAtMs: "500" }),
      candidate("TEST-missing", { lastConsumerEntryAtMs: null, lastConsumerReleaseAtMs: null })];
    const config = { ...configuration, maxCandidates: 4, maxEstimatedBatchBytes: "2000" };
    const left = report({ configuration: config, warmIdleAllocatedBytes: "2400", candidates: facts });
    const right = report({ configuration: config, warmIdleAllocatedBytes: "2400", candidates: [...facts].reverse() });
    expect(left).toEqual(right);
    expect(left.recommendations.map((item) => item.candidateId)).toEqual(["TEST-a", "TEST-z", "TEST-new-entry", "TEST-missing"]);
    expect(facts.map((item) => item.candidateId)).toEqual(["TEST-z", "TEST-new-entry", "TEST-a", "TEST-missing"]);
  });

  it("bounds candidate count and whole-tree allocated estimates without overflowing or partially recommending a tree", () => {
    const facts = [candidate("TEST-too-large", { estimatedAllocatedBytes: "900", lastConsumerReleaseAtMs: "1" }),
      candidate("TEST-a", { estimatedAllocatedBytes: "400" }), candidate("TEST-b", { estimatedAllocatedBytes: "400" }),
      candidate("TEST-c", { estimatedAllocatedBytes: "400" })];
    const count = reported(report({ configuration: { ...configuration, maxCandidates: 1, maxEstimatedBatchBytes: "800" },
      candidates: facts, warmIdleAllocatedBytes: "3000" }));
    expect(count.reason).toBe(Reason.CandidateCountBound);
    expect(count.recommendations.map((item) => item.candidateId)).toEqual(["TEST-a"]);
    const bytes = reported(report({ configuration: { ...configuration, maxEstimatedBatchBytes: "800" },
      candidates: facts, warmIdleAllocatedBytes: "3000" }));
    expect(bytes.reason).toBe(Reason.EstimatedByteBound);
    expect(bytes.recommendations.map((item) => item.candidateId)).toEqual(["TEST-a", "TEST-b"]);
    expect(bytes.selectedEstimatedBytes).toBe("800");
    const target = reported(report({ candidates: facts, warmIdleAllocatedBytes: "1100" }));
    expect(target.reason).toBe(Reason.TargetEstimated);
    expect(target.recommendations.map((item) => item.candidateId)).toEqual(["TEST-too-large"]);
  });

  it("accounts exact decimal values beyond Number.MAX_SAFE_INTEGER, including observed costs", () => {
    const result = reported(report({ configuration: { ...configuration,
      warmIdleBudgetStartBytes: "9007199254740993", warmIdleBudgetStopBytes: "1",
      maxEstimatedBatchBytes: "18014398509481987", maxBatchDurationMs: "9007199254740995" },
      warmIdleAllocatedBytes: "18014398509481988", candidates: [
        candidate("TEST-a", { estimatedAllocatedBytes: "9007199254740993", observedScanCostMs: "9007199254740993" }),
        candidate("TEST-b", { estimatedAllocatedBytes: "9007199254740994", observedScanCostMs: "2" }),
      ] }));
    expect(result.selectedEstimatedBytes).toBe("18014398509481987");
    expect(result.targetEstimatedBytes).toBe("18014398509481987");
    expect(result.accruedObservedScanCostMs).toBe("9007199254740995");
    expect(JSON.parse(JSON.stringify(result)).selectedEstimatedBytes).toBe("18014398509481987");
  });

  it("uses supplied observed costs, and stops recommendations on an unknown or exceeded time bound", () => {
    const exact = reported(report({ candidates: [candidate("TEST-a", { observedScanCostMs: "100" })] }));
    expect(exact.recommendations).toHaveLength(1);
    const exceeded = reported(report({ candidates: [candidate("TEST-a", { observedScanCostMs: "101" })] }));
    expect(exceeded.reason).toBe(Reason.ObservationTimeBound);
    expect(exceeded.recommendations).toEqual([]);
    const unknown = reported(report({ candidates: [candidate("TEST-a"),
      candidate("TEST-active", { state: FactState.Active, observedScanCostMs: null })] }));
    expect(unknown.reason).toBe(Reason.UnknownObservationCost);
    expect(unknown.qualifiedCandidateCount).toBe(1);
    expect(unknown.accruedObservedScanCostMs).toBeNull();
    expect(unknown.recommendations).toEqual([]);
  });

  it.each(["01", "-1", "1.5", "1e9", " 10", 10, "9".repeat(129)])(
    "rejects noncanonical or unbounded byte configuration instead of coercing %s", (invalid) => {
      expect(report({ configuration: { ...configuration, maxEstimatedBatchBytes: invalid } }).reason).toBe(Reason.InvalidConfiguration);
    },
  );

  it("rejects contradictory thresholds, unsupported versions, unsafe counts and configuration typos", () => {
    for (const invalid of [{ version: 2 }, { warmIdleBudgetStopBytes: "1000" },
      { pressureLowAvailableBytes: "5368709119" }, { pressureStopAvailableBytes: "5368709120" },
      { maxCandidates: 0 }, { maxCandidateFacts: 1, maxCandidates: 2 }, { maxCandidates: 1.5 },
      { maxCandidates: Number.MAX_SAFE_INTEGER + 1 }, { maxBatchDurationMs: "0" }, { evictionEnable: true }]) {
      expect(report({ configuration: { ...configuration, ...invalid } }).reason).toBe(Reason.InvalidConfiguration);
    }
  });

  it("rejects ambiguous runtime records and exceeded inventories rather than selecting a truncated pool", () => {
    expect(report({ candidates: [candidate("TEST-a"), candidate("TEST-a")] }).reason).toBe(Reason.InvalidFacts);
    expect(report({ candidates: [candidate("TEST-a", { lastConsumerReleaseAtMs: "10001" })] }).reason).toBe(Reason.InvalidFacts);
    expect(report({ candidates: [candidate("TEST-a", { observedScanCostMs: "-1" })] }).reason).toBe(Reason.InvalidFacts);
    expect(report({ candidates: [candidate("TEST-a", { state: "future_state" as FactState })] }).reason).toBe(Reason.InvalidFacts);
    expect(report({ configuration: { ...configuration, maxCandidateFacts: 1, maxCandidates: 1 },
      candidates: [candidate("TEST-a"), candidate("TEST-b")] }).reason).toBe(Reason.CandidateFactBound);
  });
});
