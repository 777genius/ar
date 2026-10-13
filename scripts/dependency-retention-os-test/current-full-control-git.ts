import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { retainOriginalFullProjectControlControlGitEntry } from "../../dist/provider-codex/app-server/adapters/hosted-full-backing-stage.js";
import { assertHostedFdPreludeDescriptors } from "../../dist/provider-codex/app-server/adapters/hosted-process-descriptors.js";
import { originalFullPeerLoader, originalFullPeerNode } from "../../dist/worker-codex/hosted-project-control-peer-recipe.js";
import { decodeOriginalControlGitFrame, originalControlGitArguments, originalControlGitEnvironment,
  originalControlGitExecutable, originalControlGitProgram, originalControlGitReady } from "../../dist/worker-codex/hosted-project-control-git-recipe.js";

function check(value: unknown): asserts value { if (!value) throw new Error("TEST_original_control_git_held"); }
/** The finite child does not adopt a scope from its frame. Only its original
 * producer owns the real child/gate, allocation phase and signed tool closure. */
async function main(): Promise<never> {
  check(process.platform === "linux" && process.version === "v22.23.3" && process.execPath === originalFullPeerNode &&
    process.argv.length === 3 && process.argv[1] === originalControlGitProgram && process.argv[2] === "control-git" && process.execArgv.length === 0);
  const entry = retainOriginalFullProjectControlControlGitEntry(); let active = true, failed = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    entry.revalidate(); check(process.env.TEST_SOURCE_SHA === entry.sourceSha);
    const environment = originalControlGitEnvironment();
    check(Object.keys(process.env).sort().join(",") === [...Object.keys(environment), "TEST_SOURCE_SHA"].sort().join(",") &&
      Object.entries(environment).every(([key, value]) => process.env[key] === value));
    const input = process.stdin; check(input instanceof Socket && fstatSync(0).isSocket());
    const handle: unknown = Reflect.get(input, "_handle"), readable: unknown = Reflect.get(input, "_readableState"), writable: unknown = Reflect.get(input, "_writableState");
    check(handle && typeof handle === "object" && Reflect.get(handle, "fd") === 0 && readable && typeof readable === "object" && writable && typeof writable === "object");
    input.allowHalfOpen = true; Reflect.set(readable, "autoDestroy", false); Reflect.set(writable, "autoDestroy", false);
    check(Reflect.get(readable, "autoDestroy") === false && Reflect.get(writable, "autoDestroy") === false);
    const stdin = fstatSync(0, { bigint: true });
    const initialDeadline = process.hrtime.bigint() + 5_000_000_000n;
    let deadline = initialDeadline, text = "", lineReady = false, eof = false;
    let resolveLine: ((line: string) => void) | undefined, rejectLine: ((error: Error) => void) | undefined;
    let resolveEnd: (() => void) | undefined, rejectEnd: ((error: Error) => void) | undefined;
    const failure = () => { const error = new Error("TEST_original_control_git_protocol_held"); rejectLine?.(error); rejectEnd?.(error); };
    const line = new Promise<string>((resolve, reject) => { resolveLine = resolve; rejectLine = reject; });
    const ended = new Promise<void>((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
    // Both promises can fail before the frame parser finishes; prevent an
    // unrelated unhandled rejection without converting failure into success.
    void ended.catch(() => undefined);
    input.on("data", (chunk: Buffer) => {
      if (lineReady || text.length + chunk.length > 192 || chunk.some(byte => byte > 127)) return failure();
      text += chunk.toString("ascii"); const newline = text.indexOf("\n");
      if (newline >= 0) { if (newline !== text.length - 1) return failure(); lineReady = true; resolveLine?.(text); }
    });
    input.once("error", failure); input.once("end", () => { eof = true; if (lineReady) resolveEnd?.(); else failure(); });
    const timed = async <T>(effect: Promise<T>): Promise<T> => {
      const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n); check(Number.isSafeInteger(remaining) && remaining > 0);
      try { return await Promise.race([effect, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_original_control_git_timeout_held")), remaining); })]); }
      finally { if (timer) clearTimeout(timer); timer = undefined; }
    };
    const frame = decodeOriginalControlGitFrame(await timed(line));
    const now = process.hrtime.bigint(); check(now < frame.deadline && frame.deadline <= now + 5_000_000_000n);
    deadline = frame.deadline < initialDeadline ? frame.deadline : initialDeadline;
    const args = originalControlGitArguments(frame); entry.revalidate();
    await timed(new Promise<void>((resolve, reject) => process.stdout.write(originalControlGitReady, error => error ? reject(error) : resolve())));
    await timed(ended); check(eof && !input.destroyed && process.hrtime.bigint() < deadline);
    input.pause(); input.unref(); const retained = fstatSync(0, { bigint: true });
    check(retained.isSocket() && retained.dev === stdin.dev && retained.ino === stdin.ino && Reflect.get(input, "_handle") === handle);
    check(fstatSync(3).isSocket()); const gate = new Socket({ fd: 3, readable: true, writable: false });
    const consumed = new Promise<void>((resolve, reject) => {
      let count = 0, ended = false, failed = false;
      const refuse = () => { if (!failed) { failed = true; gate.destroy(); reject(new Error("TEST_original_control_git_gate_held")); } };
      gate.on("data", (bytes: Buffer) => { if (bytes.length !== 1 || bytes[0] !== 1 || count !== 0) refuse(); else count++; });
      gate.once("error", refuse); gate.once("end", () => { ended = true; if (count !== 1) refuse(); else gate.destroy(); });
      gate.once("close", () => { if (!failed && ended && count === 1) resolve(); else refuse(); });
    });
    await timed(consumed);
    let positivelyClosed = false;
    try { fstatSync(3); } catch (error) { check(error instanceof Error && "code" in error && error.code === "EBADF"); positivelyClosed = true; }
    check(positivelyClosed && process.hrtime.bigint() < deadline); entry.revalidate(); entry.close(); active = false;
    assertHostedFdPreludeDescriptors(); check(process.hrtime.bigint() < deadline && typeof process.execve === "function");
    process.execve(originalFullPeerLoader, [originalFullPeerLoader, "--inhibit-cache", "--glibc-hwcaps-mask", "",
      "--library-path", "/usr/lib/x86_64-linux-gnu", originalControlGitExecutable, ...args], environment);
    throw new Error("TEST_original_control_git_execve_returned");
  } catch (error) {
    failed = true; throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (active) {
      try { entry.close(); } catch (error) { if (!failed) throw error; }
    }
  }
}
await main();
