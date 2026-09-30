import { parseHostedControllerToolCall, type HostedControllerDynamicToolAdapter } from "../domain/hosted-controller-dynamic-tools";

/** Experimental Codex CLI 0.155.1 item/tool/call handler. It retains request
 * and call IDs for the whole process lifetime; saturation denies new calls. */
export class AppServerDynamicToolHandler {
  private readonly threads = new Set<string>();
  private readonly callIds = new Set<string>();
  private readonly requestIds = new Set<string>();
  private readonly pending = new Map<string, { controller: AbortController; threadId: string; turnId: string; cancelled: boolean }>();
  constructor(private readonly options: {
    readonly adapter?: HostedControllerDynamicToolAdapter;
    readonly isActiveTurn: (threadId: string, turnId: string) => boolean;
    readonly isTerminal: () => boolean;
    readonly failProtocol: (error: Error) => void;
    readonly respond: (id: string | number, result: Record<string, unknown>) => void;
  }) {}

  addThread(id: string): void {
    if (this.threads.size >= 512 || !id || id.length > 128) throw new Error("hosted_controller_thread_limit_exceeded");
    this.threads.add(id);
  }
  resolve(threadId: unknown, id: unknown): void {
    if (typeof threadId === "string" && this.threads.has(threadId) &&
        (typeof id === "string" || typeof id === "number")) {
      const pending = this.pending.get(this.key(id));
      if (pending?.threadId === threadId) { pending.cancelled = true; pending.controller.abort(); }
    }
  }
  cancelTurn(turnId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.turnId === turnId) { pending.cancelled = true; pending.controller.abort(); }
    }
  }
  close(): void { for (const pending of this.pending.values()) { pending.cancelled = true; pending.controller.abort(); } }
  private key(id: string | number): string { return `${typeof id}:${id}`; }

  async call(id: string | number, params: Record<string, unknown> | null): Promise<void> {
    const key = this.key(id);
    const duplicate = this.requestIds.has(key);
    if (duplicate) return;
    if (this.requestIds.size >= 512) {
      this.options.failProtocol(new Error("hosted_controller_request_id_limit_exceeded"));
      return;
    }
    this.requestIds.add(key);
    const threadId = params?.threadId;
    const turnId = params?.turnId;
    const callId = params?.callId;
    const call = parseHostedControllerToolCall(params?.tool, params?.arguments);
    const validIds = typeof threadId === "string" && threadId.length > 0 && threadId.length <= 128 &&
      typeof turnId === "string" && turnId.length > 0 && turnId.length <= 128 &&
      typeof callId === "string" && callId.length > 0 && callId.length <= 128;
    const callKey = validIds ? JSON.stringify([threadId, turnId, callId]) : "";
    const replay = this.callIds.has(callKey);
    if (validIds && !replay && this.callIds.size < 512) this.callIds.add(callKey);
    let status = "unavailable";
    if (replay || !validIds || params?.namespace !== null || !call ||
      Object.keys(params).sort().join(",") !== "arguments,callId,namespace,threadId,tool,turnId") return this.respondUnavailable(id);
    if (!this.options.adapter || !this.threads.has(threadId) ||
      !this.options.isActiveTurn(threadId, turnId)) status = "unavailable";
    else if (this.requestIds.size >= 512 || this.callIds.size >= 512 || this.pending.size >= 16) status = "unavailable";
    else {
      const controller = new AbortController();
      const pending = { controller, threadId, turnId, cancelled: false };
      this.pending.set(key, pending);
      let localTimeout = false;
      const timer = setTimeout(() => { localTimeout = true; controller.abort(); }, 5_000);
      try {
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort",
          () => reject(new Error("hosted_controller_call_cancelled")), { once: true }));
        const result = await Promise.race([this.options.adapter.dispatch(call, controller.signal), aborted]);
        status = !localTimeout && result.status === "disabled" ? "disabled" : "unavailable";
      } catch { status = "unavailable"; }
      finally { clearTimeout(timer); this.pending.delete(key); }
      if (pending.cancelled || (controller.signal.aborted && !localTimeout) || this.options.isTerminal() ||
          !this.options.isActiveTurn(threadId, turnId)) return;
    }
    this.options.respond(id, { success: false,
      contentItems: [{ type: "inputText", text: `hosted_controller_${status}` }] });
  }

  private respondUnavailable(id: string | number): void {
    this.options.respond(id, { success: false,
      contentItems: [{ type: "inputText", text: "hosted_controller_unavailable" }] });
  }
}
