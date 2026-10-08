import { createHash } from "node:crypto";
import { constants, fstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readHostedDependencyRetentionPolicy, type HostedRetentionPolicyObservation } from "./hosted-dependency-retention-policy";
import { readHostedDependencyKeyInputs, assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs,
  hostedDependencyObservationLimits, type HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyCommittedHistory, HostedDependencyHistoryStatus } from "./hosted-dependency-committed-history";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { isDependencyConsumerOwner, type DependencyOwnerRecord } from "../core/dependency-environment/dependency-owner";
import { DependencyInstallProofKind, DependencyReceiptState, sameDependencyTree, sameDependencyWorkspace, type DependencyReceipt } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyTreeObservationStatus, type DependencyCapturedTreeObservation } from "../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { DependencyRetentionFactState, DependencyRetentionHold, DependencyRetentionPressure, selectDependencyRetentionReport,
  type DependencyRetentionCandidateFact } from "../worker-core/dependency-environment/domain/dependency-retention-policy";
import { openHostedDependencyReadySourceLinks } from "./hosted-dependency-ready-source-links";
import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";
import { closeDependencySourceLinkSession, readDependencySourceLinkSession, dependencyComparedSourceLinkProof,
  capturedDependencyLegacyLocalSourceFields, type DependencySourceLinkSession } from "../worker-local/dependency-environment/dependency-source-binding";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { RetainedDependencyVolume, DependencyVolumeStatus, deduplicateDependencyPhysicalTrees,
  type DependencyPhysicalTreeObservation, type DependencyVolumeObservation } from "../worker-local/dependency-environment/retained-dependency-volume";

export enum HostedRetentionFactsStatus { Reported = "reported", Unknown = "unknown" }
export enum HostedRetentionNominationState { DiagnosticOnly = "diagnostic_only" }
export enum HostedRetentionDiagnosticReason {
  CoverageUnqualified = "coverage_unqualified", AuthorityUnresolved = "authority_unresolved", HistoryUnresolved = "history_unresolved",
  OwnerUnresolved = "owner_unresolved", ActiveConsumer = "active_consumer", UnresolvedOperation = "unresolved_operation",
  Unverified = "unverified", Unmeasured = "unmeasured", UnsupportedProfile = "unsupported_profile",
  Changed = "changed_during_observation", PreservationRequired = "preservation_required", AliasConflict = "alias_conflict",
  Bounds = "bounds", CloseUnresolved = "close_unresolved", UnknownSelector = "unknown_selector",
  ActivityClockUnresolved = "activity_clock_unresolved",
}
type Classification = Readonly<{ state: DependencyRetentionFactState; holds: readonly DependencyRetentionHold[]; reason: HostedRetentionDiagnosticReason }>;
type Diagnostic = Classification & Readonly<{ jobId: string; estimatedAllocatedBytes: string | null;
  policy: HostedRetentionPolicyObservation; activityReason?: HostedRetentionDiagnosticReason.ActivityClockUnresolved }>;
type Authority = ReturnType<HostedInstallationActivationStore["dependencyMaintenanceAuthority"]>;
type Catalog = ReturnType<HostedInstallationActivationStore["dependencyReportOrigins"]>;
type Ready = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready }>;
type Frame = { readonly authority: Authority; readonly owner: DependencyOwnerRecord; readonly receipt: DependencyReceipt;
  readonly policy: HostedRetentionPolicyObservation; readonly revision: string; readonly costMs: number };
type Captured = { readonly frame: Frame; readonly observer: RetainedDependencyVolume; readonly tree: DependencyPhysicalTreeObservation;
  inputs?: HostedDependencyKeyInputs; scan?: Extract<DependencyCapturedTreeObservation, { status: DependencyTreeObservationStatus.Complete }>;
  sourceSession?: DependencySourceLinkSession; mutated?: boolean; costMs: number; closed?: boolean };
type VolumeReport = Readonly<{ volume: DependencyVolumeObservation["volume"]; diagnosticAllocatedBytes: string;
  candidates: readonly DependencyRetentionCandidateFact[]; policy: ReturnType<typeof selectDependencyRetentionReport> }>;
export type HostedDependencyRetentionFacts =
  | Readonly<{ status: HostedRetentionFactsStatus.Unknown; reason: HostedRetentionDiagnosticReason }>
  | Readonly<{ status: HostedRetentionFactsStatus.Reported; nomination: HostedRetentionNominationState.DiagnosticOnly;
      namespaceRevision: string; observedAtMs: string; catalogComplete: true;
      observedReportCostMs: string; sharedObservedCostMs: string;
      diagnostics: readonly Diagnostic[]; volumes: readonly VolumeReport[] }>;
class ReportError extends Error { constructor(readonly reason: HostedRetentionDiagnosticReason) { super(reason); } }
function fail(reason: HostedRetentionDiagnosticReason): never { throw new ReportError(reason); }
function digest(value: unknown): string {
  const bytes = JSON.stringify(value); if (bytes === undefined) fail(HostedRetentionDiagnosticReason.AuthorityUnresolved);
  return createHash("sha256").update(bytes).digest("hex");
}
const equal = (a: unknown, b: unknown): boolean => digest(a) === digest(b);

/** Classification only: caller records never become host qualification. There
 * is intentionally no QualifiedIdle outcome before the genuine native producer. */
export function classifyHostedRetentionDependency(owner: DependencyOwnerRecord | null, receipt: DependencyReceipt | null): Classification {
  const result = (state: DependencyRetentionFactState, reason: HostedRetentionDiagnosticReason,
    ...holds: DependencyRetentionHold[]): Classification => Object.freeze({ state, reason, holds: Object.freeze(holds) });
  if (!owner) return result(DependencyRetentionFactState.Unknown, HostedRetentionDiagnosticReason.OwnerUnresolved);
  if (owner.owner) return isDependencyConsumerOwner(owner.owner)
    ? result(DependencyRetentionFactState.Active, HostedRetentionDiagnosticReason.ActiveConsumer, DependencyRetentionHold.Consumer)
    : result(DependencyRetentionFactState.Held, HostedRetentionDiagnosticReason.UnresolvedOperation, DependencyRetentionHold.UnresolvedOperation);
  if (!receipt) return result(DependencyRetentionFactState.Unknown, HostedRetentionDiagnosticReason.HistoryUnresolved);
  if (receipt.state === DependencyReceiptState.Installing || receipt.state === DependencyReceiptState.Evicting)
    return result(DependencyRetentionFactState.Held, HostedRetentionDiagnosticReason.UnresolvedOperation, DependencyRetentionHold.UnresolvedOperation);
  if (receipt.state !== DependencyReceiptState.Ready) return result(DependencyRetentionFactState.Unverified, HostedRetentionDiagnosticReason.Unverified);
  return result(DependencyRetentionFactState.Unknown, receipt.treeMeasurement === undefined
    ? HostedRetentionDiagnosticReason.Unmeasured : HostedRetentionDiagnosticReason.CoverageUnqualified);
}
/** Protected wall-clock ranking fact only; unknown/future/rollback stays null. */
export function hostedRetentionActivity(owner: DependencyOwnerRecord, observedAtMs: string) {
  const entry = owner.activity?.lastEntry?.atMs ?? null, release = owner.activity?.lastRelease?.atMs ?? null;
  const valid = (value: string | null) => value !== null && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= BigInt(observedAtMs);
  const rollback = entry !== null && release !== null && owner.activity?.lastEntry?.epoch === owner.activity?.lastRelease?.epoch &&
    BigInt(release) < BigInt(entry);
  return { lastConsumerEntryAtMs: !rollback && valid(entry) ? entry : null,
    lastConsumerReleaseAtMs: !rollback && valid(release) ? release : null };
}
function frame(store: HostedInstallationActivationStore, fence: HostedActivationFence, catalog: Catalog, jobId: string): Frame {
  const started = performance.now();
  const authority = store.dependencyMaintenanceAuthority(fence, jobId), history = readHostedDependencyCommittedHistory(jobId);
  if (history.status !== HostedDependencyHistoryStatus.Known || !equal(history.binding, authority.binding)) fail(HostedRetentionDiagnosticReason.HistoryUnresolved);
  const owners = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  let owner: DependencyOwnerRecord | null;
  try { owner = owners.read(authority.binding.workspace); } finally { owners.close(); }
  if (!owner || !sameDependencyWorkspace(owner.workspace, authority.binding.workspace)) fail(HostedRetentionDiagnosticReason.OwnerUnresolved);
  const policy = readHostedDependencyRetentionPolicy(fence, jobId);
  const revision = digest([catalog, authority.installation, authority.activation, authority.originSha256, authority.binding,
    authority.session.bootId, authority.session.supervisorId, history.receipt, owner, policy]);
  return { authority, owner, receipt: history.receipt, policy, revision, costMs: performance.now() - started };
}
function current(store: HostedInstallationActivationStore, fence: HostedActivationFence, catalog: Catalog, before: Frame): number {
  const after = frame(store, fence, catalog, before.authority.birth.jobId);
  if (after.revision !== before.revision) fail(HostedRetentionDiagnosticReason.Changed);
  return after.costMs;
}
function measured(observer: RetainedDependencyVolume): DependencyVolumeObservation {
  const result = observer.observe(); if (result.status !== DependencyVolumeStatus.Measured) fail(HostedRetentionDiagnosticReason.Unmeasured); return result;
}
function physical(observer: RetainedDependencyVolume): DependencyPhysicalTreeObservation {
  const result = observer.observePhysicalTree(); if (result.status !== DependencyVolumeStatus.Measured) fail(HostedRetentionDiagnosticReason.Changed); return result;
}

/** Actual fixed resolver -> nonmutating history -> retained observations.
 * No effects/migration/maintenance claim and no caller binding/path/permit.
 * Selector configuration/headroom and native producer are not yet installed;
 * returned recommendations therefore remain closed rather than fabricated. */
export async function collectHostedDependencyRetentionFacts(jobId?: string): Promise<HostedDependencyRetentionFacts> {
  const store = new HostedInstallationActivationStore(), retained: Captured[] = [], diagnostics: Diagnostic[] = [];
  const started = performance.now(); let placement: Awaited<ReturnType<typeof openHostedDependencyManifestPlacement>> | undefined, closeUnresolved = false;
  const bounded = () => { if (performance.now() - started > hostedDependencyObservationLimits.maxDurationMs) fail(HostedRetentionDiagnosticReason.Bounds); };
  const closeAll = () => {
    let failed = false; for (const item of retained) {
      if (item.closed) continue;
      const closing = performance.now();
      try { if (item.sourceSession) closeDependencySourceLinkSession(item.sourceSession); } catch { failed = true; }
      try { item.observer.close(); } catch { failed = true; }
      finally { item.closed = true; item.costMs += performance.now() - closing; }
    }
    closeUnresolved ||= failed; if (closeUnresolved) fail(HostedRetentionDiagnosticReason.CloseUnresolved);
  };
  try {
    const initial = withHostedActivationFence(fence => {
      const catalog = store.dependencyReportOrigins(fence);
      if (jobId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId) || !catalog.jobIds.includes(jobId))) fail(HostedRetentionDiagnosticReason.UnknownSelector);
      const frames = catalog.jobIds.map(id => { bounded(); return frame(store, fence, catalog, id); });
      if (!equal(store.dependencyReportOrigins(fence), catalog)) fail(HostedRetentionDiagnosticReason.Changed);
      return { catalog, frames };
    });
    for (const f of initial.frames) {
      bounded(); const captureStarted = performance.now(), classification = classifyHostedRetentionDependency(f.owner, f.receipt), id = f.authority.birth.jobId;
      if (classification.reason !== HostedRetentionDiagnosticReason.CoverageUnqualified) {
        diagnostics.push(Object.freeze({ jobId: id, ...classification, estimatedAllocatedBytes: null, policy: f.policy })); continue;
      }
      if (f.receipt.state !== DependencyReceiptState.Ready) fail(HostedRetentionDiagnosticReason.HistoryUnresolved);
      const ready = f.receipt, parent = await open(f.authority.binding.workspace.canonicalPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        withHostedActivationFence(fence => {
          current(store, fence, initial.catalog, f);
          const s = fstatSync(parent.fd, { bigint: true });
          if (!s.isDirectory() || String(s.dev) !== f.authority.binding.workspace.dev || String(s.ino) !== f.authority.binding.workspace.ino) fail(HostedRetentionDiagnosticReason.Changed);
          const result = RetainedDependencyVolume.retain(parent);
          if (result.status !== DependencyVolumeStatus.Measured) fail(HostedRetentionDiagnosticReason.Unmeasured);
          let tree: DependencyPhysicalTreeObservation;
          try { tree = physical(result.observer); }
          catch (error) { try { result.observer.close(); } catch { closeUnresolved = true; } throw error; }
          const item: Captured = { frame: f, observer: result.observer, tree, costMs: f.costMs };
          retained.push(item);
          if (!sameDependencyTree(item.tree.identity, ready.tree) || item.tree.volume.bootId !== f.authority.session.bootId ||
              !equal(item.tree.volume, measured(item.observer).volume)) fail(HostedRetentionDiagnosticReason.Changed);
        });
      } finally {
        try { await parent.close(); } catch { closeUnresolved = true; fail(HostedRetentionDiagnosticReason.CloseUnresolved); }
        const item = retained.find(value => value.frame === f); if (item) item.costMs += performance.now() - captureStarted;
      }
    }
    if (retained.length) placement = await openHostedDependencyManifestPlacement();
    for (const item of retained) {
      bounded(); const scanStarted = performance.now(), ready = item.frame.receipt as Ready, binding = item.frame.authority.binding;
      const inputs = await readHostedDependencyKeyInputs(binding);
      const compared = ready.provenance.kind === DependencyInstallProofKind.LegacyCompared
        ? assertHostedDependencyLegacyComparedReady({ ...ready, provenance: ready.provenance }) : undefined;
      if (compared?.version === 2) {
        if (inputs.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1) fail(HostedRetentionDiagnosticReason.UnsupportedProfile);
        const session = openHostedDependencyReadySourceLinks(ready);
        if (!session) fail(HostedRetentionDiagnosticReason.HistoryUnresolved);
        item.sourceSession = session;
        const mapping = dependencyComparedSourceLinkProof(session).record, fields = capturedDependencyLegacyLocalSourceFields(inputs.capture);
        if (mapping.closureDigest !== fields.closureDigest || !equal(mapping.sourceLinks, fields.sourceLinks) ||
            !equal(mapping.directories, fields.directories) || !equal(mapping.ancestors, fields.ancestors)) fail(HostedRetentionDiagnosticReason.Changed);
      } else if (inputs.recipe !== HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1) fail(HostedRetentionDiagnosticReason.UnsupportedProfile);
      if (inputs.key.installKey !== ready.installKey) fail(HostedRetentionDiagnosticReason.PreservationRequired);
      if (!placement) fail(HostedRetentionDiagnosticReason.HistoryUnresolved);
      const baseline = await placement.get(ready.manifestDigest);
      const scan = await observeDependencyTree({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
        expectedWorkspace: binding.workspace, expectedTree: ready.tree, limits: hostedDependencyObservationLimits,
        ...(item.sourceSession ? { sourceLinkSession: item.sourceSession } : {}) });
      if (scan.status !== DependencyTreeObservationStatus.Complete) fail(HostedRetentionDiagnosticReason.Changed);
      if (!sameDependencyTree(scan.tree, item.tree.identity) || scan.mountId !== item.tree.volume.mountId) fail(HostedRetentionDiagnosticReason.Changed);
      const after = await readHostedDependencyKeyInputs(binding);
      if (!sameHostedDependencyKeyInputs(inputs, after)) fail(HostedRetentionDiagnosticReason.Changed);
      item.inputs = inputs; item.scan = scan;
      item.mutated = scan.digest !== ready.manifestDigest || !Buffer.from(scan.canonicalBytes).equals(Buffer.from(baseline));
      item.costMs += performance.now() - scanStarted;
    }
    if (placement) await placement.close();
    bounded();
    const result = withHostedActivationFence(fence => {
      if (!equal(store.dependencyReportOrigins(fence), initial.catalog)) fail(HostedRetentionDiagnosticReason.Changed);
      const now = Date.now(); if (!Number.isSafeInteger(now) || now < 0) fail(HostedRetentionDiagnosticReason.Unmeasured);
      const observedAtMs = String(now), cohorts = new Map<string, { samples: DependencyVolumeObservation[]; items: Captured[] }>();
      for (const f of initial.frames) {
        bounded();
        const cost = current(store, fence, initial.catalog, f), item = retained.find(value => value.frame === f);
        if (item) item.costMs += cost;
      }
      if (placement) placement.assertCurrent(fence);
      for (const item of retained) {
        const validationStarted = performance.now();
        if (!item.inputs || !item.scan) fail(HostedRetentionDiagnosticReason.Unmeasured);
        assertHostedDependencyKeyInputsCurrent(item.frame.authority.binding, item.inputs);
        if (item.sourceSession) readDependencySourceLinkSession(item.sourceSession, item.frame.authority.binding.workspace, "node_modules");
        const fresh = physical(item.observer), sample = measured(item.observer);
        if (!equal(fresh, item.tree) || !sameDependencyTree(item.scan.tree, fresh.identity)) fail(HostedRetentionDiagnosticReason.Changed);
        const cohort: { samples: DependencyVolumeObservation[]; items: Captured[] } = cohorts.get(sample.volume.volumeId) ?? { samples: [], items: [] };
        cohort.samples.push(sample); cohort.items.push(item); cohorts.set(sample.volume.volumeId, cohort);
        item.costMs += performance.now() - validationStarted;
      }
      const checked = [...cohorts.values()].map(cohort => {
        const sample = cohort.samples[0]; if (!sample || cohort.samples.some(s => !equal(s.volume, sample.volume) || !equal(s.capacity, sample.capacity))) fail(HostedRetentionDiagnosticReason.Unmeasured);
        const dedup = deduplicateDependencyPhysicalTrees(cohort.items.map(item => ({ tree: item.tree,
          bindingSha256: digest(item.frame.authority.binding), allocatedBytes: item.scan?.measurement.allocatedBytesEstimate ?? fail(HostedRetentionDiagnosticReason.Unmeasured) })));
        if (dedup.status !== DependencyVolumeStatus.Measured) fail(HostedRetentionDiagnosticReason.AliasConflict);
        return { cohort, sample, dedup };
      });
      closeAll();
      const volumes: VolumeReport[] = [];
      for (const { cohort, sample, dedup } of checked) {
        const candidates = cohort.items.map(item => {
          const ready = item.frame.receipt as Ready, bytes = item.scan?.measurement.allocatedBytesEstimate ?? fail(HostedRetentionDiagnosticReason.Unmeasured);
          const classification: Classification = item.mutated
            ? { state: DependencyRetentionFactState.Mutated, reason: HostedRetentionDiagnosticReason.PreservationRequired, holds: Object.freeze([DependencyRetentionHold.Preservation]) }
            : { state: DependencyRetentionFactState.Unknown, reason: HostedRetentionDiagnosticReason.CoverageUnqualified, holds: Object.freeze([]) };
          const activity = hostedRetentionActivity(item.frame.owner, observedAtMs);
          const clockUnresolved = (item.frame.owner.activity?.lastEntry !== undefined && item.frame.owner.activity.lastEntry !== null && activity.lastConsumerEntryAtMs === null) ||
            (item.frame.owner.activity?.lastRelease !== undefined && item.frame.owner.activity.lastRelease !== null && activity.lastConsumerReleaseAtMs === null);
          diagnostics.push(Object.freeze({ jobId: item.frame.authority.birth.jobId, ...classification, estimatedAllocatedBytes: bytes, policy: item.frame.policy,
            ...(clockUnresolved ? { activityReason: HostedRetentionDiagnosticReason.ActivityClockUnresolved } : {}) }));
          return Object.freeze({ candidateId: digest([item.tree.identity, item.tree.volume]),
            factRevision: digest([item.frame.revision, ready.installKey, item.scan?.digest, item.tree.volume, placement?.placementRevision]),
            state: classification.state, holds: classification.holds, estimatedAllocatedBytes: bytes,
            observedScanCostMs: String(Math.ceil(item.costMs)), ...activity });
        });
        const facts = { observedAtMs, availableBytes: sample.capacity.availableBytes, warmIdleAllocatedBytes: "0", candidates };
        volumes.push(Object.freeze({ volume: sample.volume, diagnosticAllocatedBytes: dedup.allocatedBytes, candidates: Object.freeze(candidates),
          policy: selectDependencyRetentionReport({ previousState: { pressure: DependencyRetentionPressure.Idle, warmBudget: DependencyRetentionPressure.Idle }, facts }) }));
      }
      return Object.freeze({ status: HostedRetentionFactsStatus.Reported, nomination: HostedRetentionNominationState.DiagnosticOnly,
        namespaceRevision: digest(initial.catalog), observedAtMs, catalogComplete: true,
        diagnostics: Object.freeze(jobId === undefined ? diagnostics : diagnostics.filter(d => d.jobId === jobId)), volumes: Object.freeze(volumes) });
    });
    bounded();
    const elapsed = performance.now() - started, attributed = retained.reduce((sum, item) => sum + item.costMs, 0);
    return Object.freeze({ ...result, observedReportCostMs: String(Math.ceil(elapsed)),
      sharedObservedCostMs: String(Math.ceil(Math.max(0, elapsed - attributed))) });
  } catch (error) {
    return Object.freeze({ status: HostedRetentionFactsStatus.Unknown,
      reason: error instanceof ReportError ? error.reason : HostedRetentionDiagnosticReason.AuthorityUnresolved });
  } finally {
    // Complete every join even when another close failed. A failed close can
    // never replace Unknown with a partially successful report or escape raw.
    try { if (placement) await placement.close(); } catch { closeUnresolved = true; }
    try { closeAll(); } catch { closeUnresolved = true; }
    if (closeUnresolved) return Object.freeze({ status: HostedRetentionFactsStatus.Unknown, reason: HostedRetentionDiagnosticReason.CloseUnresolved });
  }
}
