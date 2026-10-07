import { DependencyToolReadyReadStatus, DependencyToolReadyProvenanceKind, DependencyOwnerPhase, sameDependencyAttempt,
  type DependencyToolReadyReader, type DependencyToolReadyRead } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { isHostedDependencyWorkspace, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyCommittedHistory, HostedDependencyHistoryStatus } from "./hosted-dependency-committed-history";
import { assertHostedDependencyQualifiedToolEntry, readHostedDependencyQualifiedToolAdmission, readCurrentHostedDependencyRootQualification,
  type HostedDependencyQualifiedToolEntry } from "./hosted-dependency-tool-profile";

import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";

import { readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt, readRetainedHostedDependencyAttemptFacts, assertCurrentHostedDependencyOrigin, CurrentHostedDependencyOriginKind } from "./hosted-current-dependency-origin";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const unknown: DependencyToolReadyRead = Object.freeze({ status: DependencyToolReadyReadStatus.Unknown });
function fail(): never { throw new Error("hosted_dependency_tool_reader_changed"); }

/** Only the admitted worker composition captures the actual protected start.
 * No writable store, root selector or local-verification callback escapes. */
export function captureHostedDependencyToolReadyReader(fence: HostedActivationFence, identity: {
  readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string;
}, entry?: HostedDependencyQualifiedToolEntry): Readonly<{ reader: DependencyToolReadyReader; assertCurrent: (fence: HostedActivationFence) => void; origin: import("./hosted-current-dependency-origin").CurrentHostedDependencyOrigin }> | undefined {
  assertHostedActivationFence(fence);
  const context = entry ? readCurrentHostedDependencyRootQualification(fence).context : readCurrentHostedDependencyOrigin(fence);
  const current = assertCurrentHostedDependencyOrigin(context,fence);
  if (current.kind === CurrentHostedDependencyOriginKind.Ordinary) {
    const start = current.ordinary.start;
    if (start.jobId !== identity.jobId || start.jobRootDir !== identity.jobRootDir || start.workspacePath !== identity.workspacePath) fail();
    const selected = readHostedDependencyBinding(String(start.jobId));
    if (!selected) {
      if (entry || isHostedDependencyWorkspace(String(start.workspacePath))) fail();
      return undefined; // Genuine ordinary Internet/research has no dependency owner.
    }
    if (selected.jobRootDir !== start.jobRootDir || selected.workspace.canonicalPath !== start.workspacePath ||
        selected.installationId !== start.installationId || selected.runtimeSha !== current.ordinary.installation.runtimeSha ||
        selected.grantDigest !== start.grantSha256 || selected.version === 3) fail();
    if (selected.version === 1) { if (entry) fail(); return undefined; }
  }
  const actual = assertCurrentHostedDependencyAttempt(context,fence);
  const {binding,attempt,facts:origin} = actual;
  if (binding.version !== 2) fail();
  if (binding.jobId !== identity.jobId || binding.jobRootDir !== identity.jobRootDir ||
      binding.workspace.canonicalPath !== identity.workspacePath ||
      (origin.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal && !entry)) fail();
  const startId = attempt.launch.startId;
  const startName = origin.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ?
    origin.originReference.path.slice("/var/lib/subscription-runtime-host-policy/".length) : `ordinary-starts/${startId}.json`;
  const startBytes = readHostedActivationBytes(startName), selectedStart = origin.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ? origin.start : origin.ordinary.start;
  if (!startBytes || !encode(selectedStart).equals(startBytes)) fail();
  const assertAttempt = () => {
    const current = readRetainedHostedDependencyAttemptFacts(context);
    if (!encode(readHostedDependencyBinding(identity.jobId)).equals(encode(binding)) ||
        !readHostedActivationBytes(startName)?.equals(startBytes) ||
        !sameDependencyAttempt(current.attempt,attempt) || !encode(current.binding).equals(encode(binding))) fail();
  };
  const reader: DependencyToolReadyReader = Object.freeze({ readCurrent(): DependencyToolReadyRead {
    try {
      assertAttempt();
      if (entry) {
        const admitted = readHostedDependencyQualifiedToolAdmission(entry);
        const workspace=admitted.status===DependencyToolReadyReadStatus.Ready ? admitted.facts.workspace :
          (admitted.status===DependencyToolReadyReadStatus.Usable || admitted.status===DependencyToolReadyReadStatus.Baseline) ? admitted.execution.workspace : fail();
        if (!encode(workspace).equals(encode(binding.workspace))) fail();
        assertAttempt();return admitted;
      }
      const history = readHostedDependencyCommittedHistory(identity.jobId);
      if (history.status !== HostedDependencyHistoryStatus.Known || !encode(history.binding).equals(encode(binding))) return unknown;
      const receipt = history.receipt;
      if (receipt.state !== DependencyReceiptState.Ready) return unknown;
      if (receipt.provenance.kind === DependencyInstallProofKind.LegacyCompared) {
        if (assertHostedDependencyLegacyComparedReady({ ...receipt, provenance: receipt.provenance }).version !== 1) return unknown;
      } else if (receipt.provenance.kind !== DependencyInstallProofKind.CompletedInstall) return unknown;
      assertAttempt();
      return Object.freeze({ status: DependencyToolReadyReadStatus.Ready, facts: Object.freeze({
        workspace: receipt.workspace, coverageRevision: receipt.coverageRevision, revision: receipt.revision,
        installKey: receipt.installKey, tree: receipt.tree, manifestDigest: receipt.manifestDigest,
        provenance: Object.freeze({ kind: DependencyToolReadyProvenanceKind.RegistryCompleted }),
      }) });
    } catch { return unknown; }
  } });
  const assertCurrent = (held: HostedActivationFence): void => {
    assertHostedActivationFence(held);
    const current = assertCurrentHostedDependencyAttempt(context,held);
    if (!sameDependencyAttempt(current.attempt,attempt) || !encode(current.binding).equals(encode(binding))) fail();
    assertAttempt();
    if (entry) assertHostedDependencyQualifiedToolEntry(entry, held, DependencyOwnerPhase.Running);
    const read=reader.readCurrent();
    if(read.status!==DependencyToolReadyReadStatus.Ready && !(entry && (read.status===DependencyToolReadyReadStatus.Usable || read.status===DependencyToolReadyReadStatus.Baseline)))fail();
  };
  assertCurrent(fence);
  return Object.freeze({ reader, assertCurrent, origin:context });
}
