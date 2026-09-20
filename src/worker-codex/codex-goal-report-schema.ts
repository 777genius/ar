export const codexWorkerReportSchemaName = "codex-worker-report";

export const codexWorkerReportSchema = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["done", "partial", "blocked", "failed"],
    },
    evidence: {
      type: "array",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
    nextActionHint: { type: "string" },
    summary: { type: "string" },
  },
  required: ["outcome", "evidence", "blockers", "nextActionHint", "summary"],
  additionalProperties: false,
} as const;

export const codexWorkerReportSystemPrompt = [
  "When your task is finished or blocked, make the final assistant response a JSON object matching the codex-worker-report schema.",
  "Use outcome done only when the requested work is complete.",
  "Use partial when useful workspace changes exist but verification or completion is incomplete.",
  "Use blocked when you need operator input, account capacity, auth, permissions, or another external condition.",
  "Use failed when no useful result can be preserved.",
  "Keep evidence and blockers concise and factual.",
].join("\n");
