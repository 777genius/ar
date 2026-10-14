import type { HostedOrdinaryProcessOriginFacts } from "./hosted-process-activation";
import type { CodexProviderEgressProfileId } from "../../codex-provider-egress-policy";

/** Immutable selected-parent comparison facts, never origin/purpose authority.
 * Installation/grant/kernel/catalog/descriptor and dependency checks must still
 * run freshly at the actual original-map call site. No binding is inferred. */
export interface HostedOrdinarySelectedParentLineageFacts {
  readonly installationId: string;
  readonly hostId: string;
  readonly runtimeDirectory: string;
  readonly runtimeSha: string;
  readonly runtimeManifestSha256: string;
  readonly inventorySha256: string;
  readonly bootId: string;
  readonly supervisorId: string;
  readonly parentStartId: string;
  readonly parentStartSha256: string;
  readonly parentUnit: string;
  readonly parentCreatorId: string;
  readonly parentOriginSha256: string;
  readonly parentGeneration: number;
  readonly parentCreatorPidBirth: string;
  readonly parentControlGroup: string;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly grantSha256: string | null;
  readonly profileId: CodexProviderEgressProfileId;
  readonly childBound: boolean;
}
function invalid(): never { throw new Error("hosted_ordinary_selected_parent_changed"); }
function text(value: unknown): string { if (typeof value !== "string" || !value) invalid(); return value; }
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(); return value;
}
/** Pure factual projection. Calling this with a DTO grants no authority. The
 * current generation/catalog/other starts are authenticated by the collector,
 * not copied into immutable lineage and not globally ignored by admission. */
export function formHostedOrdinarySelectedParentLineageFacts(facts: HostedOrdinaryProcessOriginFacts): HostedOrdinarySelectedParentLineageFacts {
  const { installation, activation, start, reservation } = facts;
  const parentGeneration = positive(reservation.generation);
  if (activation.phase !== "ORDINARY" || reservation.state !== "reserved" ||
      positive(start.activationGeneration) !== parentGeneration || positive(activation.generation) < parentGeneration ||
      installation.installationId !== activation.installationId || installation.installationId !== start.installationId ||
      installation.hostId !== activation.hostId || start.bootId !== activation.bootId || start.supervisorId !== activation.supervisorId ||
      start.unit !== reservation.unit || start.creatorId !== reservation.creatorId || start.originSha256 !== reservation.originSha256 ||
      !/^[a-f0-9]{64}$/.test(facts.parentStartSha256)) invalid();
  const current = activation.ordinaryStarts.filter(row => row.startId === reservation.startId);
  if (current.length !== 1 || current[0]!.unit !== reservation.unit || current[0]!.creatorId !== reservation.creatorId ||
      current[0]!.originSha256 !== reservation.originSha256 || current[0]!.generation !== parentGeneration || current[0]!.state !== "reserved") invalid();
  return Object.freeze({ installationId: text(installation.installationId), hostId: text(installation.hostId),
    runtimeDirectory: text(installation.runtimeDirectory), runtimeSha: text(installation.runtimeSha),
    runtimeManifestSha256: text(installation.runtimeManifestSha256), inventorySha256: text(installation.inventorySha256),
    bootId: text(start.bootId), supervisorId: text(start.supervisorId), parentStartId: text(reservation.startId),
    parentStartSha256: facts.parentStartSha256, parentUnit: text(start.unit), parentCreatorId: text(start.creatorId),
    parentOriginSha256: text(start.originSha256), parentGeneration,
    parentCreatorPidBirth: text(start.creatorPidBirth), parentControlGroup: text(start.controlGroup),
    jobId: text(start.jobId), jobRootDir: text(start.jobRootDir), workspacePath: text(start.workspacePath),
    grantSha256: start.grantSha256 === null ? null : text(start.grantSha256), profileId: facts.profileId, childBound: facts.childBound });
}
/** Compare every selected field in a fresh projection. No expected DTO can
 * authenticate a process or become a retained original-map entry. */
export function assertSameHostedOrdinarySelectedParentLineageFacts(
  expected: HostedOrdinarySelectedParentLineageFacts, fresh: HostedOrdinaryProcessOriginFacts,
): void {
  const current = formHostedOrdinarySelectedParentLineageFacts(fresh);
  for (const key of Object.keys(current) as (keyof HostedOrdinarySelectedParentLineageFacts)[]) {
    if (current[key] !== expected[key]) invalid();
  }
}
