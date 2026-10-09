// Source for storage-pressure-guard.mjs; regenerate with the project-pinned tsc.
import { constants, fstatSync, writeSync } from 'node:fs';
import { lstat, open, realpath, statfs } from 'node:fs/promises';

export enum ScratchPressureReason {
  Bytes = 'scratch_bytes', Inodes = 'scratch_inodes', Unknown = 'scratch_observation_unknown',
}
export class ScratchPressureError extends Error {
  constructor(readonly reason: ScratchPressureReason) { super(`managed payload: ${reason}`); }
}
type Capacity = { bavail: bigint; bsize: bigint; ffree: bigint };
export type ScratchProbe = { sample(): Promise<Capacity>; close(): Promise<void> };
type Child = { kill(signal: NodeJS.Signals): boolean; once(event: 'exit' | 'error', fn: () => void): unknown; removeListener(event: 'exit' | 'error', fn: () => void): unknown };
export type Timer = { cancel(): void };
export type Schedule = (callback: () => void, delay: number) => Timer;
export type ScratchGuard = { attach(child: Child): void; close(): void; readonly reason: ScratchPressureReason | null };
const schedule: Schedule = (callback, delay) => { const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) }; };

// Retain only the admitted job filesystem. '/' inside a native/private
// namespace is not a trustworthy observation of the host root filesystem.
export async function retainScratchProbe(directory: string, device: bigint, uid: bigint): Promise<ScratchProbe> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat({ bigint: true });
    const identity = async (): Promise<void> => {
      const named = await lstat(directory, { bigint: true }), current = fstatSync(handle.fd, { bigint: true });
      if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== device || named.uid !== uid ||
          (named.mode & 0o022n) !== 0n || named.ino !== held.ino || current.ino !== held.ino ||
          current.dev !== device || await realpath(directory) !== directory) throw new ScratchPressureError(ScratchPressureReason.Unknown);
    };
    await identity();
    return { sample: async () => {
      await identity();
      const capacity = await statfs(`/proc/self/fd/${handle.fd}`, { bigint: true });
      await identity(); return capacity;
    }, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

export async function prepareScratchPressureGuard(input: {
  directory: string; device: bigint; uid: bigint; minimumBytes: bigint; minimumInodes: bigint;
  probe?: ScratchProbe; schedule?: Schedule; report?: (reason: ScratchPressureReason) => void;
  forceExit?: () => void;
}): Promise<ScratchGuard> {
  const clock = input.schedule ?? schedule;
  let probe: ScratchProbe;
  try { probe = input.probe ?? await retainScratchProbe(input.directory, input.device, input.uid); }
  catch { throw new ScratchPressureError(ScratchPressureReason.Unknown); }
  let closed = false, child: Child | undefined, reason: ScratchPressureReason | null = null;
  let poll: Timer | undefined, deadline: Timer | undefined, grace: Timer | undefined;
  const close = (): void => {
    if (closed) return; closed = true;
    poll?.cancel(); deadline?.cancel(); grace?.cancel();
    child?.removeListener('exit', close); child?.removeListener('error', close);
    void probe.close().catch(() => {});
  };
  const report = input.report ?? (value => { writeSync(2, `managed payload: ${value}\n`); });
  const fail = (value: ScratchPressureReason): void => {
    if (closed || reason !== null) return; reason = value; poll?.cancel(); deadline?.cancel();
    // Reporting failure cannot prevent teardown or change the finite reason.
    try { report(value); } catch { /* The filesystem may already be full. */ }
    try { child?.kill('SIGTERM'); } catch { /* Exit below still tears down the owned unit. */ }
    if (closed) return;
    grace = clock(() => {
      if (closed) return;
      try { child?.kill('SIGKILL'); } catch { /* The captured child may have exited. */ }
      close(); (input.forceExit ?? (() => process.exit(70)))();
    }, 5000);
  };
  const sample = (): Promise<ScratchPressureReason | null> => new Promise(resolve => {
    let settled = false;
    const finish = (value: ScratchPressureReason | null): void => {
      if (settled) return; settled = true; deadline?.cancel(); resolve(value);
    };
    deadline = clock(() => finish(ScratchPressureReason.Unknown), 2000);
    void Promise.resolve().then(() => probe.sample()).then(capacity => {
      try {
        if (![capacity.bavail, capacity.bsize, capacity.ffree].every(v => typeof v === 'bigint' && v >= 0n) || capacity.bsize === 0n) finish(ScratchPressureReason.Unknown);
        else if (capacity.bavail * capacity.bsize < input.minimumBytes) finish(ScratchPressureReason.Bytes);
        else if (capacity.ffree < input.minimumInodes) finish(ScratchPressureReason.Inodes);
        else finish(null);
      } catch { finish(ScratchPressureReason.Unknown); }
    }, () => finish(ScratchPressureReason.Unknown));
  });
  const initial = await sample();
  if (initial !== null) { close(); throw new ScratchPressureError(initial); }
  const tick = (): void => {
    if (closed || reason !== null) return;
    void sample().then(value => {
      if (closed || reason !== null) return;
      if (value !== null) fail(value); else poll = clock(tick, 1000);
    });
  };
  return { close, get reason() { return reason; }, attach: ownChild => {
    if (closed || child) throw new ScratchPressureError(ScratchPressureReason.Unknown);
    child = ownChild; child.once('exit', close); child.once('error', close); poll = clock(tick, 1000);
  } };
}
