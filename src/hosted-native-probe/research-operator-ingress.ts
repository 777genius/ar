import { parseResearchOperatorRequestEnvelope, ResearchOperatorKind } from "../core/research-operator-request.js";
/** Preserve original reserved-key evidence before the existing NativeProbe router. */
export function readResearchOperatorIngress(original: Buffer) {
  if (original.length > 65536) throw new Error("request too large");
  const bytes = new TextDecoder("utf-8", { fatal: true }).decode(original);
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value) || value.kind !== ResearchOperatorKind.OwnedResearch) return null;
  if (JSON.stringify(value) !== bytes) throw new Error("research_operator_request_invalid");
  return parseResearchOperatorRequestEnvelope(value);
}
