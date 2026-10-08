import { describe, expect, it } from "vitest";
import { DependencyGenerationContinuityKind, DependencyOwnerKind, DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { HostedDependencyReferenceKind, hostedDependencyJobRoot } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { HostedDependencyRemovalRecordKind as Kind, parseHostedDependencyRemovalClaim, parseHostedDependencyRemovalActor,
  parseHostedDependencyRemovalLock, hostedDependencyRemovalUnit } from "../hosted-dependency-removal-records";
import { parseHostedDependencyRemoverTerminalFacts, parseHostedManagedProviderTerminalFacts,
  parseHostedOrdinaryReaderTerminalFacts, matchesManagedProviderProxyWait } from "../hosted-managed-provider-terminal-facts";

const eviction = "12345678-1234-4234-8234-123456789abc", removal = "23456789-1234-4234-8234-123456789abc",
  boot = "34567890-1234-4234-8234-123456789abc", installation = "45678901-1234-4234-8234-123456789abc";
const ref = (name: string) => ({ path: `/TEST-protected/${name}.json`, identity: { dev: "1", ino: "2" }, sha256: "a".repeat(64) });
function fixture() {
  const jobId = "TEST-removal-records", jobRootDir = hostedDependencyJobRoot(jobId), workspace = { canonicalPath: `${jobRootDir}/workspace`, dev: "1", ino: "3" };
  const binding = { version: 3, jobId, jobRootDir, workspace, installationId: installation, runtimeSha: "b".repeat(40), grantDigest: "c".repeat(64),
    reference: { kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1, operationId: eviction } };
  const slot = { version: 1, kind: DependencyGenerationContinuityKind.RetiredEvictingV1, operationId: eviction, generation: "TEST-generation", readyRevision: 10,
    evictingRevision: 11, previousReady: ref("ready"), retiredEvicting: ref("evicting"), baseline: ref("baseline"), writerBarrier: ref("barrier") };
  const previous = { version: 2, revision: 20, epoch: 4, workspace, owner: null, generationContinuity: slot };
  const attempt = { operationId: removal, epoch: 5, host: { installationId: installation, bootId: boot, supervisorId: "100:200", runtimeSha: binding.runtimeSha,
    inventoryDigest: "d".repeat(64), grantDigest: binding.grantDigest } };
  const claimed = { ...previous, revision: 21, epoch: 5, owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt } };
  const tree = { dev: "1", ino: "4" }, trash = { operationId: eviction, originalTree: tree, destinationParent: { canonicalPath: "/TEST-trash", dev: "1", ino: "5" }, destinationName: `dependency-${eviction}` };
  const proof = { operationId: eviction, generation: slot.generation, workspace, coverageRevision: "TEST-coverage", tree, manifestDigest: "e".repeat(64),
    installKey: "f".repeat(64), trash, commitEvidenceId: "a".repeat(64) };
  const receipt = { version: 1, state: DependencyReceiptState.Absent, revision: 12, operationId: eviction, generation: slot.generation, workspace,
    coverageRevision: proof.coverageRevision, installKey: proof.installKey, evictionCommit: proof };
  return { version: 1, kind: Kind.Claim, binding, previous, claimed, originalIdle: ref("original-idle"), sourceClosed: ref("source-closed"),
    absent: { receipt, reference: ref("absent") }, header: ref("header"), previousClaim: null, previousRetirement: null };
}

// Syntax/consistency fixtures only; no record here claims actual host authority.
// Red if parser conflates removal with eviction, loses predecessor joins, accepts
// unrelated V1/substituted actor custody, or lets stale/live terminal facts pass.
describe("closed removal history and exact terminal boundary", () => {
  it("preserves original eviction identity while requiring a fresh exact owner edge", () => {
    const input = fixture(), claim = parseHostedDependencyRemovalClaim(input);
    expect(claim.claimed.epoch).toBe(5);
    expect(claim.previous.version !== 1 && claim.previous.generationContinuity).toEqual(input.previous.generationContinuity);
    expect(claim.absent.receipt.operationId).toBe(eviction); expect(claim.claimed.owner?.kind).toBe(DependencyOwnerKind.Maintenance);
    expect(() => parseHostedDependencyRemovalClaim({ ...input, claimed: { ...input.claimed,
      owner: { ...input.claimed.owner, attempt: { ...input.claimed.owner.attempt, operationId: eviction } } } })).toThrow();
    expect(() => parseHostedDependencyRemovalClaim({ ...input, claimed: { ...input.claimed, revision: 22 } })).toThrow();
    expect(() => parseHostedDependencyRemovalClaim({ ...input, previousClaim: ref("old-claim") })).toThrow();
  });
  it("rejects V1 locks and immutable commit/actor substitution without silently upgrading", () => {
    const claim = parseHostedDependencyRemovalClaim(fixture()), actor = ref("actor"), lock = { version: 2, kind: Kind.Lock,
      evictionOperationId: eviction, absent: claim.absent.reference, header: claim.header, manifestDigest: claim.absent.receipt.evictionCommit.manifestDigest,
      firstAttempt: claim.claimed.owner?.kind === DependencyOwnerKind.Maintenance ? claim.claimed.owner.attempt : null, actor };
    expect(parseHostedDependencyRemovalLock(lock, claim, actor).evictionOperationId).toBe(eviction);
    const old = { version: 1, operationId: eviction, commitSha256: "a".repeat(64), bootId: boot, supervisorId: "100:200" }, before = JSON.stringify(old);
    expect(() => parseHostedDependencyRemovalLock(old, claim, actor)).toThrow(); expect(JSON.stringify(old)).toBe(before);
    expect(() => parseHostedDependencyRemovalLock({ ...lock, absent: ref("foreign") }, claim, actor)).toThrow();
    expect(() => parseHostedDependencyRemovalLock(lock, claim, ref("foreign-actor"))).toThrow();
  });
  it("binds actor, parent and proxy as distinct births under the fixed own Invocation", () => {
    const claim = parseHostedDependencyRemovalClaim(fixture()), reference = ref("claim"), unit = hostedDependencyRemovalUnit(removal), invocationId = "a".repeat(32),
      controlGroup = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
    const actor = { version: 1, kind: Kind.Actor, claim: reference, bootstrap: ref("bootstrap"),
      actor: { unit, controlGroup, invocationId, pidBirth: "300:400", bootId: boot, supervisorId: "100:200" },
      parent: { unit: "TEST-supervisor.service", controlGroup: "/TEST-supervisor.service", invocationId: "b".repeat(32), pidBirth: "100:200", bootId: boot, supervisorId: "100:200" },
      proxy: { pidBirth: "500:600", controlGroup: "/TEST-supervisor.service" } };
    expect(parseHostedDependencyRemovalActor(actor, claim, reference).actor.unit).toBe(unit);
    expect(() => parseHostedDependencyRemovalActor({ ...actor, proxy: { ...actor.proxy, pidBirth: actor.parent.pidBirth } }, claim, reference)).toThrow();
    expect(() => parseHostedDependencyRemovalActor({ ...actor, actor: { ...actor.actor, bootId: installation } }, claim, reference)).toThrow();
    expect(() => parseHostedDependencyRemovalActor(actor, claim, ref("foreign-claim"))).toThrow();
  });
  it("requires exact terminal Invocation and genuine systemd signal mapping without widening existing roles", () => {
    const unit = hostedDependencyRemovalUnit(removal), invocation = "a".repeat(32), text = `Id=${unit}\nInvocationID=${invocation}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=2\nExecMainStatus=15\nResult=signal\n`;
    const terminal = parseHostedDependencyRemoverTerminalFacts(unit, text);
    expect(matchesManagedProviderProxyWait(terminal, invocation, 255)).toBe(true);
    expect(matchesManagedProviderProxyWait(terminal, invocation, 143)).toBe(false);
    expect(matchesManagedProviderProxyWait(terminal, "b".repeat(32), 255)).toBe(false);
    for (const parser of [parseHostedManagedProviderTerminalFacts, parseHostedOrdinaryReaderTerminalFacts]) expect(() => parser(unit, text)).toThrow();
    for (const bytes of [text.replace("MainPID=0", "MainPID=300"), text.replace("Job=\n", "Job=1\n"), text.replace(`InvocationID=${invocation}\n`, "")])
      expect(() => parseHostedDependencyRemoverTerminalFacts(unit, bytes)).toThrow();
  });
});
