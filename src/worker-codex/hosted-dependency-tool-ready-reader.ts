import { DependencyToolReadyReadStatus, DependencyToolReadyProvenanceKind, sameDependencyAttempt,
  type DependencyToolReadyReader, type DependencyToolReadyRead } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, readHostedOrdinaryProcessOrigin, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyAttempt, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedDependencyCommittedHistory, HostedDependencyHistoryStatus } from "./hosted-dependency-committed-history";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const unknown: DependencyToolReadyRead = Object.freeze({ status: DependencyToolReadyReadStatus.Unknown });
function fail(): never { throw new Error("hosted_dependency_tool_reader_changed"); }

/** Only the admitted worker composition captures the actual protected start.
 * No writable store, root selector or local-verification callback escapes. */
export function captureHostedDependencyToolReadyReader(fence: HostedActivationFence, identity: {
  readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string;
}): Readonly<{ reader: DependencyToolReadyReader; assertCurrent: (fence: HostedActivationFence) => void }> | undefined {
  assertHostedActivationFence(fence);
  const origin = readHostedOrdinaryProcessOrigin(fence), binding = readHostedDependencyBinding(String(origin.start.jobId));
  if (!binding || binding.version === 1) return undefined;
  if (origin.start.jobId !== identity.jobId || origin.start.jobRootDir !== identity.jobRootDir ||
      origin.start.workspacePath !== identity.workspacePath || binding.jobId !== identity.jobId ||
      binding.jobRootDir !== identity.jobRootDir || binding.workspace.canonicalPath !== identity.workspacePath) fail();
  const startId = String(origin.reservation.startId);
  const startBytes = readHostedActivationBytes(`ordinary-starts/${startId}.json`);
  if (!startBytes || !encode(origin.start).equals(startBytes)) fail();
  const attempt = readHostedDependencyAttempt(binding, origin.start, startId);
  const assertAttempt = () => {
    if (!encode(readHostedDependencyBinding(identity.jobId)).equals(encode(binding)) ||
        !readHostedActivationBytes(`ordinary-starts/${startId}.json`)?.equals(startBytes) ||
        !sameDependencyAttempt(readHostedDependencyAttempt(binding, origin.start, startId), attempt)) fail();
  };
  const reader: DependencyToolReadyReader = Object.freeze({ readCurrent(): DependencyToolReadyRead {
    try {
      assertAttempt();
      const history = readHostedDependencyCommittedHistory(identity.jobId);
      if (history.status !== HostedDependencyHistoryStatus.Known || !encode(history.binding).equals(encode(binding))) return unknown;
      const receipt = history.receipt;
      if (receipt.state !== DependencyReceiptState.Ready || receipt.provenance.kind !== DependencyInstallProofKind.CompletedInstall) return unknown;
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
    const current = readHostedOrdinaryProcessOrigin(held);
    if (current.reservation.startId !== startId || !encode(current.start).equals(startBytes)) fail();
    assertAttempt();
    if (reader.readCurrent().status !== DependencyToolReadyReadStatus.Ready) fail();
  };
  assertCurrent(fence);
  return Object.freeze({ reader, assertCurrent });
}
