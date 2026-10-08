import { boundedNativeWebJson } from "./app-server-native-web-json";
import {
  anonymousWebUrl, nativeWebId, nativeWebReceiptLimit, NativeWebAction, NativeWebItemStatus,
  nativeWebSummaryByteLimit, NativeWebResultShape, NativeWebDigestScope,
  type NativeWebEvidence, type NativeWebReceipt, type NativeWebResultSummary,
} from "@vioxen/subscription-runtime/core";

type CapturedItem = { receipt: NativeWebReceipt; fingerprint: string; complete: boolean };
type BufferedEvent = { turnId: string; item?: CapturedItem; closed: boolean };
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function optionalString(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || value[key] === null || typeof value[key] === "string";
}
/** Private turn-local capture. Notification aliases never grant receipt authority. */
export class AppServerNativeWebCapture {
  private acknowledgedTurnId: string | undefined;
  private readonly pending: BufferedEvent[] = [];
  private readonly records = new Map<string, CapturedItem>();
  private closed = false;
  private inputClosed = false;
  private unknown = false;
  private truncated = false;
  private remainingBytes = 1024 * 1024;
  private remainingItems = nativeWebReceiptLimit * 4;
  constructor(private readonly threadId: string) {}
  bind(turnId: string): void {
    if (!nativeWebId(turnId)) { this.unknown = true; return; }
    this.acknowledgedTurnId = turnId;
    for (const event of this.pending) this.accept(event);
    this.pending.length = 0;
  }
  observe(params: Record<string, unknown> | null | undefined, completed: boolean): void {
    if (this.inputClosed || params?.threadId !== this.threadId) return;
    const item = object(params.item);
    const turnId = completed ? object(params.turn)?.id : params.turnId;
    if (!completed && item?.type !== "webSearch") return;
    // Closing never grants identity authority, but is a fence even before ACK.
    if (completed) this.inputClosed = true;
    if (!nativeWebId(turnId)) { this.unknown = true; return; }
    // Identity and capacity admission precede all expensive projection work.
    if (this.closed) return;
    if (this.acknowledgedTurnId && turnId !== this.acknowledgedTurnId && !completed) return;
    const itemId = item?.id;
    if (!completed && ((!this.acknowledgedTurnId && this.pending.length >= nativeWebReceiptLimit) || (this.acknowledgedTurnId && this.records.size >= nativeWebReceiptLimit && !(typeof itemId === 'string' && this.records.has(itemId))))) { this.truncated = true; this.unknown = true; return; }
    if (!completed && (this.remainingItems <= 0 || this.remainingBytes <= 0)) { this.truncated = true; this.unknown = true; return; }
    if (!completed) this.remainingItems--;
    const projected = completed ? undefined : this.project(item);
    const event: BufferedEvent = { turnId, closed: completed, ...(projected ? { item: projected } : {}) };
    if (!this.acknowledgedTurnId) {
      if (this.pending.length >= nativeWebReceiptLimit) { this.truncated = true; return; }
      this.pending.push(event);
    } else this.accept(event);
  }
  private project(item: Record<string, unknown> | undefined): CapturedItem | undefined {
    if (!nativeWebId(item?.id)) return undefined;
    const action = object(item.action);
    const kind = action?.type === "search" ? NativeWebAction.Search : action?.type === "openPage" ? NativeWebAction.OpenPage : action?.type === "findInPage" ? NativeWebAction.FindInPage : NativeWebAction.Unknown;
    // Official rust-v0.161.0 ThreadItem/WebSearchItem: results are opaque JSON, with no
    // typed returned-source or nested CodeMode variant. Do not guess either.
    const actionValid = !Object.hasOwn(item, "action") || item.action === null || action && (
      action.type === "other" ||
      (action.type === "openPage" || action.type === "findInPage") && optionalString(action, "url") && (action.type !== "findInPage" || optionalString(action, "pattern")) ||
      action.type === "search" && optionalString(action, "query") && (!Object.hasOwn(action, "queries") || action.queries === null || Array.isArray(action.queries) && action.queries.length <= nativeWebReceiptLimit && action.queries.every(query => typeof query === "string"))
    );
    if (Array.isArray(action?.queries) && action.queries.length > nativeWebReceiptLimit) { this.truncated = true; this.unknown = true; }
    const malformed = typeof item.query !== "string" || !(!Object.hasOwn(item, 'results') || item.results === null || Array.isArray(item.results)) || !actionValid;
    const status = item.error != null || item.status === "failed" ? NativeWebItemStatus.Failed : malformed || item.status !== undefined ? NativeWebItemStatus.Unknown : NativeWebItemStatus.CompletionOnly;
    const requestedUrl = kind === NativeWebAction.OpenPage || kind === NativeWebAction.FindInPage ? anonymousWebUrl(action?.url) : undefined;
    let resultSummary: NativeWebResultSummary;
    if (Array.isArray(item.results)) {
      const observed = boundedNativeWebJson(item.results, Math.min(nativeWebSummaryByteLimit, this.remainingBytes));
      this.remainingBytes -= observed.bytes;
      resultSummary = { shape: NativeWebResultShape.Array, count: item.results.length, observedJsonBytes: observed.bytes, sha256: observed.sha256, digestScope: observed.complete ? NativeWebDigestScope.Complete : NativeWebDigestScope.Prefix, truncated: !observed.complete };
      this.truncated ||= !observed.complete; this.unknown ||= !observed.complete;
    } else resultSummary = { shape: !Object.hasOwn(item, 'results') ? NativeWebResultShape.Absent : item.results === null ? NativeWebResultShape.Null : NativeWebResultShape.Invalid, truncated: false };
    const receipt: NativeWebReceipt = { itemId: item.id, status, action: kind, resultSummary, ...(requestedUrl === undefined ? {} : { requestedUrl }) };
    // Detect conflicts across the whole item, including omitted opaque fields;
    // neither the raw item nor this private fingerprint is exported.
    const fingerprint = boundedNativeWebJson(item, Math.min(nativeWebSummaryByteLimit, this.remainingBytes));
    this.remainingBytes -= fingerprint.bytes;
    this.truncated ||= !fingerprint.complete; this.unknown ||= !fingerprint.complete;
    return { receipt, fingerprint: fingerprint.sha256, complete: fingerprint.complete };
  }
  private accept(event: BufferedEvent): void {
    if (this.closed) return;
    if (event.turnId !== this.acknowledgedTurnId) {
      if (event.closed) { this.unknown = true; this.closed = true; }
      return;
    }
    if (event.closed) { this.closed = true; return; }
    if (!event.item) { this.unknown = true; return; }
    const { receipt, fingerprint } = event.item;
    const existing = this.records.get(receipt.itemId);
    if (existing) {
      if (!existing.complete || !event.item.complete || existing.fingerprint !== fingerprint) {
        existing.receipt = { itemId: receipt.itemId, status: NativeWebItemStatus.Unknown, action: NativeWebAction.Unknown };
        this.unknown = true;
      }
      return;
    }
    if (this.records.size === nativeWebReceiptLimit) { this.truncated = true; return; }
    this.unknown ||= receipt.status === NativeWebItemStatus.Unknown;
    this.records.set(receipt.itemId, event.item);
  }
  finish(): void { this.closed = true; this.inputClosed = true; }
  result(): NativeWebEvidence | undefined {
    if (!this.acknowledgedTurnId || !nativeWebId(this.threadId)) return undefined;
    return { turns: [{ threadId: this.threadId, acknowledgedTurnId: this.acknowledgedTurnId, records: [...this.records.values()].map(value => value.receipt), unknown: this.unknown, truncated: this.truncated }], truncated: this.truncated };
  }
}
