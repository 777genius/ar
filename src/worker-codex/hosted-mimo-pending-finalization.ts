import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { hostedMimoProjectOperationCold, isHostedMimoOperationCause, observeHostedMimoProjectOperation, readHostedMimoProjectOperationOwner,
  type HostedMimoOperationCause } from "./hosted-mimo-project-bridge-operation";
import { HostedMimoWorkstreamClosure, observeHostedMimoWorkstreamClosure } from "./hosted-mimo-project-workstream-fence";
import { observeMimoCandidateAwaitingPublication, observePendingMimoFinalization } from "./research-launch-lifecycle";
import { researchCustody } from "./research-launch-files";
import { assertResearchInitialRoot, assertResearchSharedHost } from "./research-launch-host";

const bindingRoot = "/etc/subscription-runtime/mimo-projects";
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const statusReleasePattern = /^\/opt\/subscription-runtime\/releases\/([a-f0-9]{40})\/dist\/worker-codex\/hosted-mimo-project-bridge-cli\.js$/;
const jobReleasePattern = /^\/opt\/subscription-runtime\/releases\/([a-f0-9]{40})$/;
const errorPattern = /^[a-z][a-z0-9_]{0,119}$/;

/** Why a workstream or job is left out of the listing. Closed: the timer treats each as "try later". */
export enum HostedMimoPendingFinalizationUncertain {
  RecoveryPending = "recovery_pending", RetirementPending = "retirement_pending", MaintenanceFenceActive = "maintenance_fence_active",
  OperationBusy = "operation_busy", RepairUnresolved = "repair_unresolved", RecordUnreadable = "record_unreadable",
}
export type HostedMimoPendingFinalizationUncertainRow = Readonly<{
  reason: HostedMimoPendingFinalizationUncertain; projectId?: string; workstreamId?: string; jobId?: string;
}>;
/** One job whose finished MiMo candidate waits for a Status to finalize it. Closed fields only: no paths or error text. */
export type HostedMimoPendingFinalization = Readonly<{
  projectId: string; workstreamId: string; jobId: string; startId: string; candidateSha256: string;
  /** The 40-hex release the job was started on. Finalization of this job runs on it, whatever bridge is installed. */
  jobRelease?: string;
  /** The last Status failure code and its closed cause, when a Status result exists. */
  error?: string; cause?: HostedMimoOperationCause;
  /** The installed release that ran that last Status; informational, it does not change what finalization runs. */
  statusRelease?: string;
}>;
export type HostedMimoPendingFinalizationListing = Readonly<{
  ok: true; pending: readonly HostedMimoPendingFinalization[]; uncertain: readonly HostedMimoPendingFinalizationUncertainRow[];
}>;
type Failure = Readonly<{ error?: string; cause?: HostedMimoOperationCause }>;

const closureReason: Readonly<Record<HostedMimoWorkstreamClosure, HostedMimoPendingFinalizationUncertain>> = {
  [HostedMimoWorkstreamClosure.RecoveryPending]: HostedMimoPendingFinalizationUncertain.RecoveryPending,
  [HostedMimoWorkstreamClosure.RetirementPending]: HostedMimoPendingFinalizationUncertain.RetirementPending,
  [HostedMimoWorkstreamClosure.MaintenanceFence]: HostedMimoPendingFinalizationUncertain.MaintenanceFenceActive,
};
const entries = (path: string): string[] => existsSync(path) ? readdirSync(path).sort() : [];
const operations = Object.values(MimoProjectBridgeOperation);
const repairOperations: readonly MimoProjectBridgeOperation[] = [MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair];

function lastStatusFailure(result: unknown): Failure {
  if (!result || typeof result !== "object") return {};
  const row = result as { ok?: unknown; error?: unknown; cause?: unknown };
  if (row.ok !== false || typeof row.error !== "string" || !errorPattern.test(row.error)) return {};
  return { error: row.error, ...(isHostedMimoOperationCause(row.cause) ? { cause: row.cause } : {}) };
}

/** Read-only listing for the finalization timer. It takes no lock, writes nothing and never calls Status: it
 * reads the retained owners and results, asks systemd about the units, and applies the lifecycle's own selection rule
 * plus the conditions under which bridge ingress itself refuses. A job whose owner is written but whose unit is not yet
 * scheduled is a known window; ingress handles that concurrency itself. */
export function listHostedMimoPendingFinalization(): HostedMimoPendingFinalizationListing {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const machineId = hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim();
  const pending: HostedMimoPendingFinalization[] = [], uncertain: HostedMimoPendingFinalizationUncertainRow[] = [];
  const unreadable = (row: Omit<HostedMimoPendingFinalizationUncertainRow, "reason"> = {}) =>
    uncertain.push({ reason: HostedMimoPendingFinalizationUncertain.RecordUnreadable, ...row });
  let projects: string[] = [];
  try { projects = entries(bindingRoot); } catch { unreadable(); }
  for (const projectId of projects) {
    if (!idPattern.test(projectId)) { unreadable(); continue; }
    let files: string[];
    // A stray file here is ENOTDIR: one broken entry never stops the listing.
    try { files = entries(join(bindingRoot, projectId)); } catch { unreadable({ projectId }); continue; }
    for (const file of files) {
      const workstreamId = file.replace(/\.json$/, "");
      if (!file.endsWith(".json") || !idPattern.test(workstreamId)) { unreadable({ projectId }); continue; }
      const where = { projectId, workstreamId };
      try {
        const stateRoot = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(join(bindingRoot, projectId, file)).toString()),
          { kind: "MimoProject", schemaVersion: 1, machineId, projectId, workstreamId, operation: MimoProjectBridgeOperation.Status, jobId: "list" }).stateRoot;
        // The conditions under which ingress refuses the whole workstream.
        const closure = observeHostedMimoWorkstreamClosure(stateRoot);
        if (closure) { uncertain.push({ reason: closureReason[closure], ...where }); continue; }
        const root = join(stateRoot, "mimo-bridge-operations");
        if (!existsSync(root)) continue;
        researchCustody(root, true);
        const jobIds = new Set<string>();
        for (const name of entries(root)) {
          const match = /^(.+)\.([a-z-]+)\.owner\.json$/.exec(name);
          if (match && (operations as string[]).includes(match[2]!) && idPattern.test(match[1]!)) jobIds.add(match[1]!);
        }
        for (const jobId of jobIds) {
          const request = (operation: MimoProjectBridgeOperation): MimoProjectBridgeRequest =>
            ({ kind: "MimoProject", schemaVersion: 1, machineId, projectId, workstreamId, operation, jobId });
          try {
            // Filesystem first: a finished job never reaches systemd.
            if (!observeMimoCandidateAwaitingPublication(jobId)) continue;
            let busy: HostedMimoPendingFinalizationUncertain | undefined, status: Failure = {}, statusRelease: string | undefined;
            for (const operation of operations) {
              const observed = observeHostedMimoProjectOperation(request(operation)) as { state: string; result?: unknown };
              // Ingress returns without scheduling for a running operation and for an unresolved repair, cold or not.
              if (observed.state === "running") busy ??= HostedMimoPendingFinalizationUncertain.OperationBusy;
              else if (observed.state === "unresolved" && repairOperations.includes(operation)) busy ??= HostedMimoPendingFinalizationUncertain.RepairUnresolved;
              else if (observed.state === "unresolved" && !hostedMimoProjectOperationCold(request(operation))) busy ??= HostedMimoPendingFinalizationUncertain.OperationBusy;
              if (operation === MimoProjectBridgeOperation.Status && observed.state !== "absent") {
                if (observed.state === "settled") status = lastStatusFailure(observed.result);
                statusRelease = statusReleasePattern.exec(String(readHostedMimoProjectOperationOwner(request(operation)).value.entry))?.[1];
              }
            }
            if (busy) { uncertain.push({ reason: busy, ...where, jobId }); continue; }
            const waiting = observePendingMimoFinalization(jobId);
            if (!waiting) continue;
            const jobRelease = jobReleasePattern.exec(waiting.runtimeDirectory)?.[1];
            pending.push({ ...where, jobId, startId: waiting.startId, candidateSha256: waiting.candidateSha256,
              ...(jobRelease === undefined ? {} : { jobRelease }), ...status, ...(statusRelease === undefined ? {} : { statusRelease }) });
          } catch { unreadable({ ...where, jobId }); }
        }
      } catch { unreadable(where); }
    }
  }
  return { ok: true, pending, uncertain };
}
