import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { LocalDependencyReceiptStore } from "../store-local-file/dependency-environment/local-dependency-receipt-store";
import { sameDependencyWorkspace, DependencyReceiptState,
  type DependencyReceipt } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { hostedDependencyReceiptHistoryRoot } from "../provider-codex/app-server/adapters/hosted-dependency-history-path";
import { assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedDependencyPhysicalWorkspace, readHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";

import { assertHostedDependencyReadySourceHistory } from "./hosted-dependency-ready-source-links";

export enum HostedDependencyHistoryStatus { Known = "known", Unknown = "unknown" }
export enum HostedDependencyHistoryFailure { Unresolved = "unresolved" }
export type HostedDependencyCommittedHistory =
  | Readonly<{ status: HostedDependencyHistoryStatus.Known; binding: HostedDependencyBinding; receipt: DependencyReceipt }>
  | Readonly<{ status: HostedDependencyHistoryStatus.Unknown; reason: HostedDependencyHistoryFailure }>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Current established history only. No initialization, legacy migration,
 * recovery, local proof callback or public writable store escapes this leaf. */
export function readHostedDependencyCommittedHistory(jobId: string): HostedDependencyCommittedHistory {
  assertHostedActivationOperator();
  try {
    const binding = readHostedDependencyBinding(jobId);
    const installed = readHostedActivationBytes("host-installation.json"), enrolled = readHostedActivationBytes("host-activation.json");
    if (!binding || !installed || !enrolled) throw new Error();
    const installation = decodeHostedActivationBytes(installed) as Record<string, unknown>, activation = decodeHostedActivationBytes(enrolled) as Record<string, unknown>;
    if (installation.installationId !== binding.installationId || installation.runtimeSha !== binding.runtimeSha ||
        activation.installationId !== binding.installationId || activation.phase !== "ORDINARY") throw new Error();
    assertHostedDependencyPhysicalWorkspace(binding);
    for (let path = hostedDependencyReceiptHistoryRoot;; path = dirname(path)) {
      const s = lstatSync(path);
      if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022) || realpathSync(path) !== path ||
          (path === hostedDependencyReceiptHistoryRoot && (s.mode & 0o777) !== 0o700)) throw new Error();
      if (path === "/") break;
    }
    const store = LocalDependencyReceiptStore.open({ rootPath: hostedDependencyReceiptHistoryRoot, maxRecordBytes: 16384, maxHistorySteps: 2048 });
    let receipt: DependencyReceipt | null;
    try { receipt = store.read(binding.workspace); } finally { store.close(); }
    if (!receipt || !sameDependencyWorkspace(receipt.workspace, binding.workspace) || receipt.coverageRevision !== hash(encode(binding)) ||
        !encode(readHostedDependencyBinding(jobId)).equals(encode(binding)) ||
        !readHostedActivationBytes("host-installation.json")?.equals(installed) || !readHostedActivationBytes("host-activation.json")?.equals(enrolled)) throw new Error();
    if (receipt.state === DependencyReceiptState.Ready) assertHostedDependencyReadySourceHistory(receipt);
    assertHostedDependencyPhysicalWorkspace(binding);
    return Object.freeze({ status: HostedDependencyHistoryStatus.Known, binding, receipt });
  } catch {
    return Object.freeze({ status: HostedDependencyHistoryStatus.Unknown, reason: HostedDependencyHistoryFailure.Unresolved });
  }
}
