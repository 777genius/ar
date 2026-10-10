import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BoundedStorageError, BoundedStorageFailure } from "../../src/worker-core/storage/bounded-storage-contract";
import { boundedFailure } from "../../src/worker-core/storage/bounded-storage-policy";

const maxLedger = 4 * 1024 * 1024;
const decode = new TextDecoder("utf-8", { fatal: true });

/** Fixed, bounded wire reader. Every native acknowledgement is consumed once;
 * a lost/extra/oversized response is uncertainty, never an automatic replay. */
export class NativeWire {
  private bytes = Buffer.alloc(0);
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private busy = false;
  private closed = false;
  private deadline: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly operationTimeoutMs = 300000) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 300000) boundedFailure(BoundedStorageFailure.Invalid);
    this.deadline = Date.now() + operationTimeoutMs;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.bytes.length + chunk.length > maxLedger + 2048) { this.stop(); return; }
      this.bytes = Buffer.concat([this.bytes, chunk]); this.wake?.();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) this.stop(); });
    child.stdin.on("error", () => this.stop());
    this.exited = new Promise(resolve => {
      child.once("error", () => { this.stop(); resolve({ code: null, signal: null }); });
      child.once("close", (code, signal) => { this.closed = true; this.wake?.(); resolve({ code, signal }); });
    });
  }
  stop(): void {
    this.failure = new BoundedStorageError(BoundedStorageFailure.Uncertain); this.wake?.();
    // Only this exact child. Its PDEATHSIG also kills its own mke2fs child;
    // retained mounts/loops/claims survive and require reconciliation.
    if (!this.child.stdin.destroyed) this.child.stdin.destroy(this.failure);
    if (!this.closed && !this.child.killed) this.child.kill("SIGKILL");
  }
  async consume(length: number): Promise<Buffer> {
    while (this.bytes.length < length) {
      if (this.failure || this.closed || Date.now() >= this.deadline) { this.stop(); throw this.failure; }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, Math.min(1000, this.deadline - Date.now()));
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
    const result = this.bytes.subarray(0, length); this.bytes = this.bytes.subarray(length); return result;
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 1024) { const byte = (await this.consume(1))[0]!; if (byte === 10) {
      const line = decode.decode(Uint8Array.from(bytes));
      if (line.startsWith("ERROR1 ")) {
        const fields = line.split(" "), reason = fields[1];
        throw new BoundedStorageError(Object.values(BoundedStorageFailure).includes(reason as BoundedStorageFailure)
          ? reason as BoundedStorageFailure : BoundedStorageFailure.Uncertain);
      }
      return line;
    } bytes.push(byte); }
    this.stop(); throw this.failure;
  }
  async command<T>(header: string, payload: Buffer | undefined, response: () => Promise<T>): Promise<T> {
    if (this.busy || this.failure || this.closed || !/^[A-Z0-9_ .a-f-]+\n$/.test(header)) boundedFailure(BoundedStorageFailure.Uncertain);
    this.busy = true;
    this.deadline = Date.now() + this.operationTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { this.stop(); reject(this.failure); }, this.operationTimeoutMs);
    });
    const operation = async (): Promise<T> => {
      await this.write(header);
      if (payload) await this.write(payload);
      if (this.failure || this.closed) boundedFailure(BoundedStorageFailure.Uncertain);
      return response();
    };
    try {
      // Includes header/payload backpressure and the complete response. A timed
      // out operation can never enqueue another write or consume a later reply.
      return await Promise.race([operation(), expired]);
    } catch (error) {
      if (error instanceof BoundedStorageError) throw error;
      this.stop(); throw this.failure;
    } finally { if (timeout) clearTimeout(timeout); this.busy = false; }
  }
  private async write(bytes: string | Buffer): Promise<void> {
    if (this.failure || this.closed) boundedFailure(BoundedStorageFailure.Uncertain);
    await new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, error => {
      if (error) this.stop();
      if (this.failure || this.closed) reject(this.failure ?? new BoundedStorageError(BoundedStorageFailure.Uncertain));
      else resolve();
    }));
  }
  async finish(): Promise<void> {
    this.child.stdin.end();
    const timeout = setTimeout(() => this.stop(), 5000);
    try { const status = await this.exited; if (status.code !== 0 || status.signal !== null || this.bytes.length || this.failure) boundedFailure(BoundedStorageFailure.Uncertain); }
    finally { clearTimeout(timeout); }
  }
}
