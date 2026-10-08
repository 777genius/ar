/** Transport observations only. Host decides qualification; completion is not page retrieval. */
export enum NativeWebItemStatus { CompletionOnly = "completion_only", Failed = "failed", Unknown = "unknown" }
export enum NativeWebAction { Search = "search", OpenPage = "open_page", FindInPage = "find_in_page", Unknown = "unknown" }
export const nativeWebReceiptLimit = 64;
/** Opaque transport JSON observation; never page content or raw wire bytes. */
export enum NativeWebResultShape { Absent = "absent", Null = "null", Array = "array", Invalid = "invalid" }
export enum NativeWebDigestScope { Complete = "complete_reserialized_json", Prefix = "prefix_reserialized_json" }
export const nativeWebSummaryByteLimit = 64 * 1024;
export type NativeWebResultSummary = {
  readonly shape: NativeWebResultShape;
  /** Actual array length, available independently of bounded serialization. */
  readonly count?: number;
  readonly observedJsonBytes?: number;
  readonly sha256?: string;
  readonly digestScope?: NativeWebDigestScope;
  readonly truncated: boolean;
};
export type NativeWebReceipt = {
  readonly itemId: string;
  readonly status: NativeWebItemStatus;
  readonly action: NativeWebAction;
  /** Request target only, never evidence of returned page content. */
  readonly requestedUrl?: string;
  readonly resultSummary?: NativeWebResultSummary;
};
export type NativeWebTurnObservation = {
  readonly threadId: string;
  readonly acknowledgedTurnId: string;
  readonly records: readonly NativeWebReceipt[];
  readonly unknown: boolean;
  readonly truncated: boolean;
};
export type NativeWebEvidence = { readonly turns: readonly NativeWebTurnObservation[]; readonly truncated: boolean };
export function nativeWebId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}
export function anonymousWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//iu.test(value) || /[\s\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || value.split('/')[2]?.includes('@') || url.search || url.hash || value.includes('?') || value.includes('#')) return undefined;
    return url.href;
  } catch { return undefined; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_web_evidence_invalid");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("native_web_evidence_invalid");
}
/** Reconstruct the finite public contract at serialization boundaries; never copy opaque payloads. */
export function parseNativeWebEvidence(value: unknown): NativeWebEvidence {
  const input = record(value); keys(input, ['turns', 'truncated']);
  if (typeof input.truncated !== 'boolean' || !Array.isArray(input.turns) || input.turns.length > nativeWebReceiptLimit) throw new Error("native_web_evidence_invalid");
  let count = 0;
  const identities = new Set<string>();
  const turns = input.turns.map(value => {
    const turn = record(value); keys(turn, ['threadId', 'acknowledgedTurnId', 'records', 'unknown', 'truncated']);
    if (!nativeWebId(turn.threadId) || !nativeWebId(turn.acknowledgedTurnId) || typeof turn.unknown !== 'boolean' || typeof turn.truncated !== 'boolean' || !Array.isArray(turn.records)) throw new Error("native_web_evidence_invalid");
    const identity = `${turn.threadId}/${turn.acknowledgedTurnId}`;
    if (identities.has(identity)) throw new Error("native_web_evidence_invalid"); identities.add(identity);
    const ids = new Set<string>();
    const records = turn.records.map(value => {
      const item = record(value); keys(item, ['itemId', 'status', 'action', 'requestedUrl', 'resultSummary']);
      if (++count > nativeWebReceiptLimit || !nativeWebId(item.itemId) || ids.has(item.itemId) || !Object.values(NativeWebItemStatus).includes(item.status as NativeWebItemStatus) || !Object.values(NativeWebAction).includes(item.action as NativeWebAction)) throw new Error("native_web_evidence_invalid");
      ids.add(item.itemId);
      const requestedUrl = item.requestedUrl === undefined ? undefined : anonymousWebUrl(item.requestedUrl);
      if (item.requestedUrl !== undefined && requestedUrl !== item.requestedUrl) throw new Error("native_web_evidence_invalid");
      if (requestedUrl !== undefined && item.action !== NativeWebAction.OpenPage && item.action !== NativeWebAction.FindInPage) throw new Error("native_web_evidence_invalid");
      const resultSummary = item.resultSummary === undefined ? undefined : parseNativeWebResultSummary(item.resultSummary);
      if (resultSummary?.shape === NativeWebResultShape.Invalid && item.status === NativeWebItemStatus.CompletionOnly) throw new Error("native_web_evidence_invalid");
      return { ...(resultSummary === undefined ? {} : { resultSummary }), itemId: item.itemId, status: item.status as NativeWebItemStatus, action: item.action as NativeWebAction, ...(requestedUrl === undefined ? {} : { requestedUrl }) };
    });
    if (records.some(item => item.resultSummary?.truncated) && !turn.truncated) throw new Error("native_web_evidence_invalid");
    if (records.some(item => item.status === NativeWebItemStatus.Unknown) && !turn.unknown || turn.truncated && !input.truncated) throw new Error("native_web_evidence_invalid");
    return { threadId: turn.threadId, acknowledgedTurnId: turn.acknowledgedTurnId, records, unknown: turn.unknown, truncated: turn.truncated };
  });
  return { turns, truncated: input.truncated };
}
export function parseNativeWebResultSummary(value: unknown): NativeWebResultSummary {
  const input = record(value);
  keys(input, ['shape', 'count', 'observedJsonBytes', 'sha256', 'digestScope', 'truncated']);
  if (!Object.values(NativeWebResultShape).includes(input.shape as NativeWebResultShape) || typeof input.truncated !== 'boolean') throw new Error("native_web_evidence_invalid");
  if (input.shape !== NativeWebResultShape.Array) {
    if (input.count !== undefined || input.observedJsonBytes !== undefined || input.sha256 !== undefined || input.digestScope !== undefined || input.truncated) throw new Error("native_web_evidence_invalid");
    return { shape: input.shape as NativeWebResultShape, truncated: false };
  }
  if (!Number.isSafeInteger(input.count) || (input.count as number) < 0 || !Number.isSafeInteger(input.observedJsonBytes) || (input.observedJsonBytes as number) < 0 || (input.observedJsonBytes as number) > nativeWebSummaryByteLimit || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256) || !Object.values(NativeWebDigestScope).includes(input.digestScope as NativeWebDigestScope) || input.truncated !== (input.digestScope === NativeWebDigestScope.Prefix) || !input.truncated && (input.observedJsonBytes as number) < 2) throw new Error("native_web_evidence_invalid");
  return { shape: NativeWebResultShape.Array, count: input.count as number, observedJsonBytes: input.observedJsonBytes as number, sha256: input.sha256, digestScope: input.digestScope as NativeWebDigestScope, truncated: input.truncated };
}
export function appendNativeWebEvidence(previous: NativeWebEvidence, next: NativeWebEvidence | undefined): NativeWebEvidence {
  if (!next) return previous;
  const turns = [...previous.turns]; let count = turns.reduce((n, turn) => n + turn.records.length, 0);
  let truncated = previous.truncated || next.truncated;
  for (const turn of next.turns) {
    if (turns.length === nativeWebReceiptLimit) { truncated = true; break; }
    const records = turn.records.slice(0, nativeWebReceiptLimit - count); count += records.length;
    const overflow = records.length !== turn.records.length;
    turns.push({ ...turn, records, truncated: turn.truncated || overflow }); truncated ||= overflow;
  }
  return { turns, truncated };
}
