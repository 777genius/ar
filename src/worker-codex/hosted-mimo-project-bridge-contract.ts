export enum MimoProjectBridgeOperation { Create = "create", Start = "start", Status = "status", Stop = "stop" }
export type MimoProjectBridgeRequest = Readonly<{
  kind: "MimoProject"; schemaVersion: 1; machineId: string; projectId: string; workstreamId: string;
  operation: MimoProjectBridgeOperation; jobId: string; prompt?: string; sourceCommit?: string;
}>;
export function parseMimoProjectBridgeRequest(value: unknown): MimoProjectBridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mimo_project_bridge_request_invalid");
  const row = value as Record<string, unknown>;
  const create = row.operation === MimoProjectBridgeOperation.Create;
  const keys = "kind,schemaVersion,machineId,projectId,workstreamId,operation,jobId" + (create ? ",prompt,sourceCommit" : "");
  if (Object.keys(row).sort().join(",") !== keys.split(",").sort().join(",") || row.kind !== "MimoProject" || row.schemaVersion !== 1 ||
      typeof row.machineId !== "string" || !/^[a-f0-9]{32}$/.test(row.machineId) ||
      !Object.values(MimoProjectBridgeOperation).includes(row.operation as MimoProjectBridgeOperation)) throw new Error("mimo_project_bridge_request_invalid");
  for (const key of ["projectId", "workstreamId", "jobId"]) if (typeof row[key] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row[key]))
    throw new Error("mimo_project_bridge_request_invalid");
  if (create && (typeof row.prompt !== "string" || !row.prompt.trim() || Buffer.byteLength(row.prompt) > 32768 || row.prompt.includes("\0") ||
      typeof row.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(row.sourceCommit))) throw new Error("mimo_project_bridge_request_invalid");
  return Object.freeze(row) as MimoProjectBridgeRequest;
}
