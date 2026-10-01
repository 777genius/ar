import { EventEmitter } from "node:events";
// Independent transport: no production fake scripts or terminal DTOs. Each
// request remains unanswered until this peer explicitly completes it.
export class ControlledPeer extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly requests: { id: number; method: string; params: Record<string, unknown> }[] = [];
  readonly responses: Record<string, unknown>[] = [];
  ended = false;
  readonly stdin = {
    write: (line: string | Uint8Array) => {
      const request = JSON.parse(String(line));
      if (request.method) {
        this.requests.push(request);
        this.emit("request", request);
      } else this.responses.push(request);
      return true;
    },
    end: () => { this.ended = true; queueMicrotask(() => this.emit("exit", 0, null)); },
  };
  kill(): boolean { queueMicrotask(() => this.emit("exit", 0, null)); return true; }
  next(method: string, occurrence = 1): Promise<ControlledPeer["requests"][number]> {
    const found = this.requests.filter(request => request.method === method)[occurrence - 1];
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const listener = () => {
        const request = this.requests.filter(r => r.method === method)[occurrence - 1];
        if (request) { this.removeListener("request", listener); resolve(request); }
      };
      this.on("request", listener);
    });
  }
  reply(request: ControlledPeer["requests"][number], result: unknown): void {
    this.stdout.emit("data", JSON.stringify({ id: request.id, result }) + "\n");
  }
  fail(request: ControlledPeer["requests"][number]): void {
    this.stdout.emit("data", JSON.stringify({ id: request.id, error: { code: -1, message: "TEST failure" } }) + "\n");
  }
  goal(status = "active", threadId = "actual-TEST-thread") {
    return { goal: { threadId, objective: "TEST objective", status } };
  }
  async initialize(): Promise<void> { this.reply(await this.next("initialize"), {}); }
  async thread(): Promise<void> { this.reply(await this.next("thread/start"), { thread: { id: "actual-TEST-thread" } }); }
  async activate(): Promise<void> { this.reply(await this.next("thread/goal/set"), this.goal()); }
  async finishTurn(occurrence = 1): Promise<void> {
    const turnId = occurrence === 1 ? "actual-TEST-turn" : `actual-TEST-turn-${occurrence}`;
    this.reply(await this.next("turn/start", occurrence), { turn: { id: turnId } });
    this.stdout.emit("data", JSON.stringify({ method: "item/agentMessage/delta", params: {
      threadId: "actual-TEST-thread", turnId, delta: "TEST result" } }) + "\n");
    this.stdout.emit("data", JSON.stringify({ method: "turn/completed", params: {
      threadId: "actual-TEST-thread", turn: { id: turnId, status: "completed" } } }) + "\n");
  }
  async finish(): Promise<void> {
    await this.finishTurn();
    this.reply(await this.next("thread/goal/get"), this.goal("complete"));
  }
}
