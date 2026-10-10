export enum ResearchOperatorKind { OwnedResearch = "ResearchOperator" }
export enum ResearchOperatorOperation { Start = "start", Status = "status", Cancel = "cancel", Revoke = "revoke" }
export enum ResearchOperatorState { NotSubmitted = "not-submitted", Settled = "settled", Unresolved = "unresolved", Submitted = "submitted", Revoked = "revoked" }
export type ResearchOperatorRequest = Readonly<{
  kind: ResearchOperatorKind; schemaVersion: 1; machineId: string; projectId: string;
  jobId: string; operation: ResearchOperatorOperation; bindingSha256: string;
}>;
export function parseResearchOperatorRequestEnvelope(value: unknown): ResearchOperatorRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("research_operator_request_invalid");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "bindingSha256,jobId,kind,machineId,operation,projectId,schemaVersion" ||
      r.kind !== ResearchOperatorKind.OwnedResearch || r.schemaVersion !== 1 ||
      typeof r.machineId !== "string" || !/^[a-f0-9]{32}$/.test(r.machineId) ||
      typeof r.bindingSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.bindingSha256) ||
      !Object.values(ResearchOperatorOperation).includes(r.operation as ResearchOperatorOperation)) throw new Error("research_operator_request_invalid");
  for (const key of ["projectId", "jobId"]) if (typeof r[key] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(r[key] as string))
    throw new Error("research_operator_request_invalid");
  return Object.freeze(r) as ResearchOperatorRequest;
}
