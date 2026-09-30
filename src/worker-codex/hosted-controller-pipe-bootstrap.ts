import { spawn, type ChildProcess } from "node:child_process";
import { type Readable, type Writable } from "node:stream";
import { HostedControllerFramedDispatcher, hostedControllerPipe, relayHostedControllerPipe } from "./hosted-controller-framed-dispatcher";
import { bindHostedControllerOriginAndGrant, type HostedControllerRetainedOrigin } from "./hosted-controller-origin-binding";

const bootstrapLimit = 4 * 1024 * 1024;

/** Initial private environment is a single bounded frame. Subsequent bytes on
 * the same --pipe connection belong exclusively to the dispatcher protocol. */
export function encodeHostedControllerBootstrap(env: Readonly<Record<string, string>>): Buffer {
  if (!Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      typeof value === "string" && !value.includes("\0"))) throw new Error("hosted_controller_bootstrap_invalid");
  const body = Buffer.from(JSON.stringify({ version: 1, kind: "bootstrap", env }));
  if (body.length === 0 || body.length > bootstrapLimit) throw new Error("hosted_controller_bootstrap_invalid");
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Host foreground adapter for the exact owned systemd-run --pipe child. The
 * custody caller supplies the process; model traffic supplies no identity. */
export function attachHostedControllerSystemdPipe(input: {
  readonly child: ChildProcess;
  readonly env: Readonly<Record<string, string>>;
  readonly readRetainedOrigin: () => HostedControllerRetainedOrigin;
  readonly readPrivateGrant: (origin: HostedControllerRetainedOrigin) => Buffer;
}): HostedControllerFramedDispatcher {
  let dispatcher: HostedControllerFramedDispatcher | undefined;
  try {
    if (!input.child.stdin || !input.child.stdout) throw new Error("hosted_controller_pipe_unavailable");
    const verifyRetainedOriginAndGrant = bindHostedControllerOriginAndGrant(input);
    if (!verifyRetainedOriginAndGrant()) throw new Error("hosted_controller_pipe_authority_unavailable");
    const active = new HostedControllerFramedDispatcher(
      hostedControllerPipe(input.child.stdout, input.child.stdin), { verifyRetainedOriginAndGrant });
    dispatcher = active;
    input.child.once("error", () => active.close());
    input.child.once("exit", () => active.close());
    input.child.stdin.write(encodeHostedControllerBootstrap(input.env));
    return active;
  } catch {
    dispatcher?.close();
    try { input.child.kill("SIGTERM"); } catch { /* Already exited. */ }
    throw new Error("hosted_controller_pipe_unavailable");
  }
}

export async function readHostedControllerBootstrap(input: Readable): Promise<Readonly<Record<string, string>>> {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expected = 0;
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      input.off("data", onData); input.off("end", fail); input.off("close", fail); input.off("error", fail);
    };
    const fail = () => { cleanup(); input.destroy(); reject(new Error("hosted_controller_bootstrap_invalid")); };
    const onData = (chunk: Buffer) => {
      if (buffered.length + chunk.length > bootstrapLimit + 4 + 16 * 1024) return fail();
      buffered = Buffer.concat([buffered, chunk]);
      if (!expected && buffered.length >= 4) {
        expected = buffered.readUInt32BE(0);
        if (expected === 0 || expected > bootstrapLimit) return fail();
      }
      if (!expected || buffered.length < expected + 4) return;
      cleanup(); input.pause();
      const trailing = buffered.subarray(expected + 4);
      if (trailing.length) input.unshift(trailing);
      try {
        const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffered.subarray(4, expected + 4)));
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error();
        const record = frame as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "env,kind,version" || record.version !== 1 ||
            record.kind !== "bootstrap" || !record.env || typeof record.env !== "object" ||
            Array.isArray(record.env) || !Object.entries(record.env).every(([key, value]) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string" && !value.includes("\0"))) throw new Error();
        resolve(record.env as Record<string, string>);
      } catch { input.destroy(); reject(new Error("hosted_controller_bootstrap_invalid")); }
    };
    timer = setTimeout(fail, 5_000);
    input.on("data", onData); input.once("end", fail); input.once("close", fail); input.once("error", fail);
  });
}

/** Fixed inventory command crosses the second bootstrap handoff. Only the
 * controller runtime receives fd 3/4; its stdout is suppressed so --pipe
 * carries framed traffic only. Provider spawns retain their explicit 0–2 stdio. */
export async function runHostedControllerBootstrap(input: {
  readonly upstreamRead: Readable;
  readonly upstreamWrite: Writable;
  readonly verifyRetainedOriginAndGrant: () => boolean;
  readonly launch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
}): Promise<number> {
  const env = await readHostedControllerBootstrap(input.upstreamRead);
  if (!input.verifyRetainedOriginAndGrant()) {
    input.upstreamRead.destroy();
    input.upstreamWrite.destroy();
    throw new Error("hosted_controller_bootstrap_authority_unavailable");
  }
  const child = spawn(input.launch.command, [...input.launch.args], {
    cwd: input.launch.cwd, env,
    stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
  });
  const channel = hostedControllerPipe(child.stdio[4] as Readable, child.stdio[3] as Writable);
  const upstream = hostedControllerPipe(input.upstreamRead, input.upstreamWrite);
  const terminateIfRunning = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  // Pipe closure can precede the child's exit event even when it is exiting cleanly.
  const scheduleTermination = () => { setTimeout(terminateIfRunning, 250).unref(); };
  channel.once("close", scheduleTermination);
  upstream.once("close", scheduleTermination);
  const close = relayHostedControllerPipe(upstream, channel);
  return await waitForController(child, close);
}

function waitForController(child: ChildProcess, close: () => void): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => { if (settled) return; settled = true; close(); resolve(code); };
    child.once("error", () => finish(70));
    child.once("exit", (code, signal) => finish(signal === null ? code ?? 70 : 70));
  });
}
