import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { hostedControllerPipe, relayHostedControllerPipe } from "../hosted-controller-framed-dispatcher";
import { attachHostedControllerSystemdPipe, encodeHostedControllerBootstrap, readHostedControllerBootstrap, runHostedControllerBootstrap } from "../hosted-controller-pipe-bootstrap";

function pair(): [Duplex, Duplex] {
  const left = new PassThrough(); const right = new PassThrough();
  const a = hostedControllerPipe(left, right), b = hostedControllerPipe(right, left);
  a.on("error", () => undefined); b.on("error", () => undefined);
  return [a, b];
}

const syntheticController = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const read = fs.createReadStream('', { fd: 3, autoClose: false });
const write = fs.createWriteStream('', { fd: 4, autoClose: false });
const channelTarget = fs.readlinkSync('/proc/self/fd/3');
const grandchild = spawnSync(process.execPath, ['-e',
  "const fs=require('node:fs');const targets=fs.readdirSync('/proc/self/fd').flatMap(n=>{try{return [fs.readlinkSync('/proc/self/fd/'+n)]}catch{return []}});process.stdout.write(JSON.stringify(targets))"
], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
if (grandchild.status !== 0 || JSON.parse(grandchild.stdout).includes(channelTarget)) process.exit(71);
const body = Buffer.from(JSON.stringify({ version: 1, kind: 'request',
  requestId: '00000000-0000-0000-0000-000000000001', deadlineMs: Date.now() + 5000,
  tool: 'observe', arguments: { handle: 'synthetic' } }));
const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
write.write(Buffer.concat([header, body]));
let response = Buffer.alloc(0);
const deadline = setTimeout(() => process.exit(73), 2000);
read.on('data', chunk => {
  response = Buffer.concat([response, chunk]);
  if (response.length < 4 || response.length < response.readUInt32BE(0) + 4) return;
  const value = JSON.parse(response.subarray(4, response.readUInt32BE(0) + 4).toString());
  clearTimeout(deadline);
  setTimeout(() => { read.destroy(); write.destroy(); process.exitCode = value.status === 'disabled' ? 0 : 72; }, 80);
});
`;

describe("framed controller bootstrap handoff", () => {
  it("preserves a full-duplex pipe through two synthetic handoffs while the child lives", async () => {
    const [hostPipe, firstPipe] = pair();
    const [secondPipe, bootstrapPipe] = pair();
    const closeFirst = relayHostedControllerPipe(firstPipe, secondPipe);
    let acknowledgments = 0;
    let notifyAcknowledged: (() => void) | undefined;
    const acknowledged = new Promise<void>((resolve) => { notifyAcknowledged = resolve; });
    const origin = { installationId: "00000000-0000-0000-0000-000000000001",
      startId: "00000000-0000-0000-0000-000000000002", jobId: "synthetic-controller",
      originSha256: "a".repeat(64) };
    const systemdRun = Object.assign(new EventEmitter(), {
      stdin: hostPipe, stdout: hostPipe, kill: () => true,
    }) as unknown as ChildProcess;
    const host = attachHostedControllerSystemdPipe({ child: systemdRun, env: { CI: "true" },
      readRetainedOrigin: () => { acknowledgments += 1; if (acknowledgments === 3) notifyAcknowledged?.(); return origin; },
      readPrivateGrant: () => Buffer.alloc(32, 7),
    });
    let completed = false;
    let bootstrapVerified = false;
    const running = runHostedControllerBootstrap({
      upstreamRead: bootstrapPipe, upstreamWrite: bootstrapPipe,
      verifyRetainedOriginAndGrant: () => { bootstrapVerified = true; return true; },
      launch: { command: process.execPath, args: ["-e", syntheticController], cwd: process.cwd() },
    }).then((code) => { completed = true; return code; });
    await Promise.race([acknowledged, running.then((code) => { throw new Error(`synthetic_controller_exited_before_ack:${code}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`synthetic_controller_ack_timeout:bootstrap=${bootstrapVerified}`)), 1000))]);
    expect(completed).toBe(false);
    // The host's upstream can close before Node reports an already exiting child.
    closeFirst();
    expect(await running).toBe(0);
    expect(acknowledgments).toBe(3);
    host.close();
  });

  it("denies the child spawn when private authority is absent", async () => {
    const [hostPipe, bootstrapPipe] = pair();
    const running = runHostedControllerBootstrap({
      upstreamRead: bootstrapPipe, upstreamWrite: bootstrapPipe,
      verifyRetainedOriginAndGrant: () => false,
      launch: { command: process.execPath, args: ["-e", "process.exit(99)"], cwd: process.cwd() },
    });
    hostPipe.write(encodeHostedControllerBootstrap({ CI: "true" }));
    await expect(running).rejects.toThrow("hosted_controller_bootstrap_authority_unavailable");
    hostPipe.destroy(); bootstrapPipe.destroy();
  });

  it("closes a malformed bootstrap stream before any child spawn", async () => {
    const [hostPipe, bootstrapPipe] = pair();
    let verified = 0;
    const running = runHostedControllerBootstrap({
      upstreamRead: bootstrapPipe, upstreamWrite: bootstrapPipe,
      verifyRetainedOriginAndGrant: () => { verified += 1; return true; },
      launch: { command: process.execPath, args: ["-e", "process.exit(99)"], cwd: process.cwd() },
    });
    const malformed = Buffer.from(encodeHostedControllerBootstrap({ CI: "true" }));
    malformed[4] = 0xff;
    hostPipe.write(malformed);
    await expect(running).rejects.toThrow("hosted_controller_bootstrap_invalid");
    expect(verified).toBe(0);
    expect(bootstrapPipe.destroyed).toBe(true);
    hostPipe.destroy();
  });

  it("rejects close-only truncation and removes bootstrap listeners", async () => {
    const input = new PassThrough();
    const reading = readHostedControllerBootstrap(input);
    input.write(Buffer.from([0, 0]));
    input.destroy();
    await expect(reading).rejects.toThrow("hosted_controller_bootstrap_invalid");
    for (const event of ["data", "end", "close", "error"]) expect(input.listenerCount(event)).toBe(0);
  });

  it("bounds bootstrap waiting and removes every listener on deadline", async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      const reading = readHostedControllerBootstrap(input);
      const rejected = expect(reading).rejects.toThrow("hosted_controller_bootstrap_invalid");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(input.destroyed).toBe(true);
      for (const event of ["data", "end", "close", "error"]) expect(input.listenerCount(event)).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("fences the owned systemd pipe before sending bootstrap data without a private grant", () => {
    const [hostPipe, peer] = pair();
    let killed = 0;
    let bytes = 0;
    peer.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    const systemdRun = Object.assign(new EventEmitter(), {
      stdin: hostPipe, stdout: hostPipe, kill: () => { killed += 1; return true; },
    }) as unknown as ChildProcess;
    expect(() => attachHostedControllerSystemdPipe({ child: systemdRun, env: { CI: "true" },
      readRetainedOrigin: () => ({ installationId: "00000000-0000-0000-0000-000000000001",
        startId: "00000000-0000-0000-0000-000000000002", jobId: "synthetic-controller",
        originSha256: "a".repeat(64) }),
      readPrivateGrant: () => Buffer.alloc(0),
    })).toThrow("hosted_controller_pipe_unavailable");
    expect(killed).toBe(1);
    expect(bytes).toBe(0);
    hostPipe.destroy(); peer.destroy();
  });
});
