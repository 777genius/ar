import type { CodexReasoningEffort } from "@vioxen/subscription-runtime/provider-codex";

export enum MimoProjectBridgeOperation { Create = "create", Start = "start", Status = "status", Stop = "stop", RepairAdmission = "repair-admission", FinalizeAdmissionRepair = "finalize-admission-repair" }
export type MimoAdmissionRepairPlan = Readonly<{
  schemaVersion: 1; projectId: string; workstreamId: string; machineId: string; jobId: string;
  expectedBindingSha256: string; expectedControllerManifestSha256: string; expectedManifestSha256: string;
  expectedContractSha256: string; expectedStateSha256: string; expectedReceiptSha256: string;
  ownedPaths: readonly string[];
}>;
export type MimoProjectBridgeRequest = Readonly<{
  kind: "MimoProject"; schemaVersion: 1; machineId: string; projectId: string; workstreamId: string;
  operation: MimoProjectBridgeOperation; jobId: string; prompt?: string; sourceCommit?: string; reasoningEffort?: CodexReasoningEffort;
  repairPlan?: MimoAdmissionRepairPlan;
}>;
export function parseMimoProjectBridgeRequest(value: unknown): MimoProjectBridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mimo_project_bridge_request_invalid");
  const row = value as Record<string, unknown>;
  const create = row.operation === MimoProjectBridgeOperation.Create;
  const repair = row.operation === MimoProjectBridgeOperation.RepairAdmission;
  const hasReasoning = Object.hasOwn(row, "reasoningEffort");
  const efforts: readonly CodexReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
  if (hasReasoning && (!create || !efforts.includes(row.reasoningEffort as CodexReasoningEffort))) throw new Error("mimo_project_bridge_request_invalid");
  const keys = "kind,schemaVersion,machineId,projectId,workstreamId,operation,jobId" + (create ? ",prompt,sourceCommit" + (hasReasoning ? ",reasoningEffort" : "") : repair ? ",repairPlan" : "");
  if (Object.keys(row).sort().join(",") !== keys.split(",").sort().join(",") || row.kind !== "MimoProject" || row.schemaVersion !== 1 ||
      typeof row.machineId !== "string" || !/^[a-f0-9]{32}$/.test(row.machineId) ||
      !Object.values(MimoProjectBridgeOperation).includes(row.operation as MimoProjectBridgeOperation)) throw new Error("mimo_project_bridge_request_invalid");
  for (const key of ["projectId", "workstreamId", "jobId"]) if (typeof row[key] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row[key]))
    throw new Error("mimo_project_bridge_request_invalid");
  if (create && (typeof row.prompt !== "string" || !row.prompt.trim() || Buffer.byteLength(row.prompt) > 32768 || row.prompt.includes("\0") ||
      typeof row.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(row.sourceCommit))) throw new Error("mimo_project_bridge_request_invalid");
  if (repair) {
    if (!row.repairPlan || typeof row.repairPlan !== "object" || Array.isArray(row.repairPlan)) throw new Error("mimo_project_bridge_request_invalid");
    const plan = row.repairPlan as Record<string, unknown>;
    const digests = ["expectedBindingSha256", "expectedControllerManifestSha256", "expectedManifestSha256", "expectedContractSha256", "expectedStateSha256", "expectedReceiptSha256"];
    const planKeys = ["schemaVersion", "projectId", "workstreamId", "machineId", "jobId", ...digests, "ownedPaths"];
    if (Object.keys(plan).sort().join(",") !== planKeys.sort().join(",") || plan.schemaVersion !== 1 ||
        ["projectId", "workstreamId", "machineId", "jobId"].some(key => plan[key] !== row[key]) ||
        digests.some(key => typeof plan[key] !== "string" || !/^[a-f0-9]{64}$/.test(plan[key])) ||
        !Array.isArray(plan.ownedPaths) || plan.ownedPaths.length < 1 || plan.ownedPaths.length > 256 ||
        plan.ownedPaths.some(path => typeof path !== "string" || !path || Buffer.byteLength(path) > 4096 || path.includes("\0")) ||
        Buffer.byteLength(JSON.stringify(plan)) > 49152) throw new Error("mimo_project_bridge_request_invalid");
  }
  if (repair) {
    const plan = row.repairPlan as MimoAdmissionRepairPlan;
    return Object.freeze({ ...row, repairPlan: Object.freeze({ ...plan, ownedPaths: Object.freeze([...plan.ownedPaths]) }) }) as MimoProjectBridgeRequest;
  }
  return Object.freeze(row) as MimoProjectBridgeRequest;
}
