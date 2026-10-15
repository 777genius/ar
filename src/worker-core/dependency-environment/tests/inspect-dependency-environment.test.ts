import { describe, expect, it } from "vitest";
import { inspectDependencyEnvironment } from "../application/inspect-dependency-environment";
import {
  DependencyAbsenceKind, DependencyConsumerState, DependencyInspectionOutcome as Outcome,
  DependencyInspectionReason as Reason, DependencyTreeObservationState as TreeState, DependencyTreeSafety,
  type DependencyInspectionInput,
} from "../domain/dependency-inspection";
import {
  DependencyInstallProofKind, DependencyPreservationKind, DependencyReceiptState as State, DependencyUnverifiedReason,
  type DependencyReceipt,
} from "../domain/dependency-receipt";
import { DependencyReceiptParseStatus as ParseStatus, parseDependencyReceipt } from "../domain/parse-dependency-receipt";

// All paths/identities are synthetic data. Tests never touch a project or invoke an installer.
const workspace = { canonicalPath: "/TEST/dependency-environment", dev: "7", ino: "100" };
const tree = { dev: "7", ino: "101" };
const manifestDigest = "a".repeat(64);
const binding = { workspace, tree, generation: "TEST-generation", coverageRevision: "TEST-coverage",
  installKey: "b".repeat(64), manifestDigest };
const base = { version: 1 as const, revision: 1, generation: binding.generation, workspace,
  coverageRevision: binding.coverageRevision };
const ready: DependencyReceipt = { ...base, state: State.Ready, tree, installKey: binding.installKey,
  manifestDigest, provenance: { ...binding, kind: DependencyInstallProofKind.CompletedInstall,
    operationId: "TEST-install", verificationEvidenceId: "TEST-verified", installerDrainEvidenceId: "TEST-drained" } };
const trash = { operationId: "TEST-eviction", originalTree: tree,
  destinationParent: { canonicalPath: "/TEST/protected-trash", dev: "7", ino: "200" },
  destinationName: "TEST-tree" };
const absent: DependencyReceipt = { ...base, state: State.Absent, operationId: trash.operationId,
  installKey: binding.installKey, evictionCommit: { ...binding, operationId: trash.operationId, trash,
    commitEvidenceId: "TEST-committed" } };
const input: DependencyInspectionInput = { workspace, coverageRevision: binding.coverageRevision,
  currentInstallKey: binding.installKey, requiredCapabilities: ["node"], consumer: { state: DependencyConsumerState.Idle },
  tree: { state: TreeState.Present, tree, safety: DependencyTreeSafety.Safe, availableCapabilities: ["node"] },
  receipt: ready };
const inspect = (changes: Partial<DependencyInspectionInput> = {}) => inspectDependencyEnvironment({ ...input, ...changes });

describe("non-destructive dependency inspection", () => {
  it("explicit operator retirement remains Busy before missing/unsafe/warm tree branches", () => {
    const receipt = {...base,state:State.Unverified as const,tree,reason:DependencyUnverifiedReason.ExplicitOperatorReinstallation};
    for(const observed of [input.tree,{state:TreeState.Absent as const,absence:DependencyAbsenceKind.ObservedMissing},
      {state:TreeState.Present as const,tree,safety:DependencyTreeSafety.RequiresPreservation,availableCapabilities:[]}]) {
      expect(inspect({receipt,tree:observed})).toEqual({outcome:Outcome.Busy,reason:Reason.UnresolvedOperation});
    }
  });
  it("hot reuse and separately verified legacy need identity/key/capabilities, not a content inventory", () => {
    expect(inspect()).toEqual({ outcome: Outcome.Reused, reason: Reason.ReadyIdentityMatched });
    const legacyReady = { ...ready, provenance: { ...binding, kind: DependencyInstallProofKind.LegacyCompared,
      referenceInstallationId: "TEST-reference-install", comparisonEvidenceId: "TEST-exact-equality" } };
    expect(inspect({ receipt: legacyReady }).outcome).toBe(Outcome.Reused);
    expect(inspect({ requiredCapabilities: [] }).outcome).toBe(Outcome.Reused);
  });

  it("safe self-installed and changed-key environments remain usable as-is without rewriting their receipt", () => {
    const before = JSON.stringify(ready);
    expect(inspect({ receipt: null })).toEqual({ outcome: Outcome.UnverifiedReuse, reason: Reason.BaselineMissing });
    expect(inspect({ currentInstallKey: "e".repeat(64) }))
      .toEqual({ outcome: Outcome.UnverifiedReuse, reason: Reason.InputsChanged });
    expect(inspect({ coverageRevision: "TEST-new-coverage" }).outcome).toBe(Outcome.UnverifiedReuse);
    expect(inspect({ tree: { state: TreeState.Present, tree: { dev: "7", ino: "999" },
      safety: DependencyTreeSafety.Safe, availableCapabilities: ["node"] } }).reason).toBe(Reason.TreeChanged);
    expect(JSON.stringify(ready)).toBe(before);
  });

  it.each([DependencyConsumerState.Running, DependencyConsumerState.ExclusiveMutation] as const)(
    "does not let same attempt, legacy reuse or missing dependencies bypass %s", (state) => {
      const consumer = { state, attemptId: "TEST-same-attempt", fence: 1, ownershipEvidenceId: "TEST-live-owner" };
      expect(inspect({ receipt: null, consumer })).toEqual({ outcome: Outcome.Busy, reason: Reason.ActiveOwner });
      expect(inspect({ receipt: absent, consumer, tree: { state: TreeState.Absent,
        absence: DependencyAbsenceKind.ObservedMissing } }).outcome).toBe(Outcome.Busy);
    },
  );

  it("unknown ownership and unsafe/missing capability trees cannot be declared reusable", () => {
    expect(inspect({ receipt: null, consumer: { state: DependencyConsumerState.Unknown } }).outcome).toBe(Outcome.Unknown);
    expect(inspect({ receipt: null, tree: { state: TreeState.Present, tree,
      safety: DependencyTreeSafety.RequiresPreservation, availableCapabilities: ["node"] } }).reason).toBe(Reason.UnsafeTree);
    expect(inspect({ requiredCapabilities: ["profile-declared-tool"] }))
      .toEqual({ outcome: Outcome.RequiresPreservation, reason: Reason.MissingCapabilities });
  });

  it("requests installation only for fresh absence or a coherent eviction, without bypassing unexpected trees", () => {
    const missing = { state: TreeState.Absent as const, absence: DependencyAbsenceKind.ObservedMissing };
    expect(inspect({ receipt: absent, tree: missing }))
      .toEqual({ outcome: Outcome.NeedsInstall, reason: Reason.CommittedAbsence });
    expect(inspect({ receipt: null, tree: { ...missing, absence: DependencyAbsenceKind.KnownFresh } }).outcome)
      .toBe(Outcome.NeedsInstall);
    expect(inspect({ receipt: null, tree: missing }).reason).toBe(Reason.UnprovenAbsence);
    expect(inspect({ tree: missing }).reason).toBe(Reason.ReceiptTreeMissing);
    expect(inspect({ receipt: absent })).toEqual({ outcome: Outcome.Conflict, reason: Reason.UnexpectedTree });
    expect(inspect({ receipt: absent, tree: missing, coverageRevision: "TEST-stale" }).outcome).toBe(Outcome.Unknown);
  });

  it("unresolved install/eviction intent and corrupt receipts cannot fall back to legacy reuse", () => {
    const installing = { ...base, state: State.Installing, operationId: "TEST-install", requestedKey: binding.installKey,
      preservation: { generation: base.generation, workspace, coverageRevision: base.coverageRevision,
        operationId: "TEST-install", kind: DependencyPreservationKind.KnownFreshAbsence, absenceEvidenceId: "TEST-fresh" } };
    const evicting = { ...base, state: State.Evicting, operationId: trash.operationId,
      installKey: binding.installKey, tree, manifestDigest, trash };
    for (const receipt of [installing, evicting]) {
      expect(inspect({ receipt })).toEqual({ outcome: Outcome.Busy, reason: Reason.UnresolvedOperation });
    }
    expect(inspect({ receipt: { ...ready, provenance: null } }))
      .toEqual({ outcome: Outcome.Unknown, reason: Reason.InvalidReceipt });
    expect(inspect({ workspace: { ...workspace, ino: "999" } }).reason).toBe(Reason.WorkspaceChanged);
  });
});

describe("protected dependency receipt shape and proof bindings", () => {
  it("accepts structurally complete installation and eviction records", () => {
    expect(parseDependencyReceipt(ready).status).toBe(ParseStatus.Valid);
    expect(parseDependencyReceipt(absent).status).toBe(ParseStatus.Valid);
  });

  it("Installing requires a generation-bound absence or committed complete preservation mapping", () => {
    const operationId = "TEST-replacement";
    const preservation = { generation: base.generation, workspace, coverageRevision: base.coverageRevision,
      operationId, kind: DependencyPreservationKind.CommittedPreservation, originalTree: tree,
      preservedTree: tree, destinationParent: trash.destinationParent, destinationName: "TEST-preserved",
      mappingDigest: "c".repeat(64), commitEvidenceId: "TEST-preservation-commit" };
    const installing = { ...base, state: State.Installing, operationId,
      requestedKey: "d".repeat(64), preservation };
    expect(parseDependencyReceipt(installing).status).toBe(ParseStatus.Valid);
    for (const proof of [{ ...preservation, commitEvidenceId: undefined },
      { ...preservation, operationId: "TEST-other" },
      { ...preservation, preservedTree: { dev: "7", ino: "999" } }]) {
      expect(parseDependencyReceipt({ ...installing, preservation: proof }).status).toBe(ParseStatus.Invalid);
    }
    expect(parseDependencyReceipt({ ...installing, preservation: null }).status).toBe(ParseStatus.Invalid);
  });

  it.each([
    { ...ready, version: 2 }, { ...ready, revision: -1 }, { ...ready, state: "future_state" },
    { ...ready, extraClaim: true }, { ...ready, provenance: { ...ready.provenance, installerDrainEvidenceId: undefined } },
    { ...ready, provenance: { ...ready.provenance, generation: "TEST-other-generation" } },
    { ...ready, provenance: { ...ready.provenance, tree: { dev: "7", ino: "777" } } },
    { ...ready, installKey: "TEST-not-a-digest" },
    { ...ready, provenance: { ...ready.provenance, installKey: "f".repeat(64) } },
    { ...ready, provenance: { ...ready.provenance, manifestDigest: "b".repeat(64) } },
    { ...ready, provenance: { ...ready.provenance, workspace: { ...workspace, canonicalPath: "/TEST/other" } } },
    { ...ready, tree: { dev: 7, ino: "101" } },
    { ...absent, evictionCommit: { ...absent.evictionCommit, operationId: "TEST-other-operation" } },
    { ...absent, evictionCommit: { ...absent.evictionCommit, trash: { ...trash, destinationName: "../external" } } },
    { ...absent, evictionCommit: { ...absent.evictionCommit, trash: { ...trash, destinationParent: workspace } } },
  ])("rejects missing, conflicting or unknown fields without returning the payload", (receipt) => {
    expect(parseDependencyReceipt(receipt)).toEqual({ status: ParseStatus.Invalid });
  });
});
