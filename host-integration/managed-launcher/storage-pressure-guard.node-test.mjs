// Source for the generated .mjs test; use npm run build:managed-pressure-guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { fstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareScratchPressureGuard, retainScratchProbe, ScratchPressureError, ScratchPressureReason } from './storage-pressure-guard.mjs';
// Existing JavaScript adapter; the new guard and test fixtures remain strict.
// @ts-expect-error Legacy adapter has no declaration file.
import { runGuardedPayload } from './payload-guard.mjs';
const bytes = 5368709120n, inodes = 50000n;
const healthy = { bavail: bytes, bsize: 1n, ffree: inodes };
const flush = async () => { for (let i = 0; i < 12; i++)
    await Promise.resolve(); };
class Clock {
    jobs = new Map();
    schedule = (fn, delay) => {
        const token = { cancel: () => { this.jobs.delete(token); } };
        this.jobs.set(token, { fn, delay });
        return token;
    };
    fire(delay) {
        const found = [...this.jobs].find(([, job]) => job.delay === delay);
        assert(found, `missing timer ${delay}`);
        this.jobs.delete(found[0]);
        found[1].fn();
    }
    count(delay) { return [...this.jobs.values()].filter(job => job.delay === delay).length; }
    get size() { return this.jobs.size; }
}
class OwnChild extends EventEmitter {
    signals = [];
    kill(signal) { this.signals.push(signal); return true; }
}
function fixture() {
    const clock = new Clock(), child = new OwnChild(), outside = new OwnChild();
    let value = async () => healthy, samples = 0, closes = 0, exits = 0;
    const reasons = [];
    const probe = { sample: () => { samples++; return value(); }, close: async () => { closes++; } };
    const input = { directory: '/TEST/jobs/owned', device: 2n, uid: 0n, minimumBytes: bytes, minimumInodes: inodes,
        probe, schedule: clock.schedule, report: (reason) => reasons.push(reason), forceExit: () => { exits++; } };
    return { clock, child, outside, reasons, input, change: (next) => { value = next; },
        get samples() { return samples; }, get closes() { return closes; }, get exits() { return exits; } };
}
for (const [reason, capacity] of [
    [ScratchPressureReason.Bytes, { ...healthy, bavail: bytes - 1n }],
    [ScratchPressureReason.Inodes, { ...healthy, ffree: inodes - 1n }],
])
    test(`healthy payload stops only its child on subsequent ${reason}`, async () => {
        const f = fixture(), guard = await prepareScratchPressureGuard(f.input);
        guard.attach(f.child);
        assert.equal(f.samples, 1);
        assert.deepEqual(f.child.signals, []);
        f.change(async () => capacity);
        f.clock.fire(1000);
        await flush();
        assert.equal(guard.reason, reason);
        assert.deepEqual(f.reasons, [reason]);
        assert.deepEqual(f.child.signals, ['SIGTERM']);
        assert.deepEqual(f.outside.signals, []);
        f.clock.fire(5000);
        assert.deepEqual(f.child.signals, ['SIGTERM', 'SIGKILL']);
        assert.equal(f.exits, 1);
        assert.equal(f.closes, 1);
        assert.equal(f.clock.size, 0);
    });
test('exact existing thresholds stay healthy; timer and descriptors close on exit', async () => {
    const f = fixture(), guard = await prepareScratchPressureGuard(f.input);
    guard.attach(f.child);
    f.clock.fire(1000);
    await flush();
    assert.equal(guard.reason, null);
    assert.equal(f.clock.count(1000), 1);
    f.child.emit('exit', 0, null);
    guard.close();
    await flush();
    assert.equal(f.closes, 1);
    assert.equal(f.clock.size, 0);
});
test('initial low capacity refuses spawn and closes the retained probe', async () => {
    const f = fixture();
    f.change(async () => ({ ...healthy, ffree: 0n }));
    await assert.rejects(prepareScratchPressureGuard(f.input), (error) => error instanceof ScratchPressureError && error.reason === ScratchPressureReason.Inodes);
    assert.equal(f.closes, 1);
    assert.deepEqual(f.child.signals, []);
});
test('failed or malformed live observation fails closed despite reporting error', async () => {
    for (const next of [async () => { throw Error('opaque failure'); }, async () => ({ ...healthy, bsize: 0n })]) {
        const f = fixture(), guard = await prepareScratchPressureGuard({ ...f.input, report: () => { throw Error('full log'); } });
        guard.attach(f.child);
        f.change(next);
        f.clock.fire(1000);
        await flush();
        assert.equal(guard.reason, ScratchPressureReason.Unknown);
        assert.deepEqual(f.child.signals, ['SIGTERM']);
        f.child.emit('exit');
        assert.equal(f.clock.size, 0);
    }
});
test('stalled live probe times out, never overlaps, and ignores its late result', async () => {
    const f = fixture(), guard = await prepareScratchPressureGuard(f.input);
    guard.attach(f.child);
    let resolve;
    f.change(() => new Promise(done => { resolve = done; }));
    f.clock.fire(1000);
    await flush();
    assert.equal(f.samples, 2);
    assert.equal(f.clock.count(1000), 0);
    f.clock.fire(2000);
    await flush();
    assert.deepEqual(f.reasons, [ScratchPressureReason.Unknown]);
    resolve(healthy);
    await flush();
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.equal(f.clock.count(1000), 0);
    guard.close();
});
test('stalled initial observation has a finite deadline before any payload', async () => {
    const f = fixture();
    f.change(() => new Promise(() => { }));
    const rejected = assert.rejects(prepareScratchPressureGuard(f.input), ScratchPressureError);
    f.clock.fire(2000);
    await rejected;
    assert.equal(f.closes, 1);
    assert.equal(f.clock.size, 0);
});
test('child exit races an in-flight pressure sample without late signals', async () => {
    const f = fixture(), guard = await prepareScratchPressureGuard(f.input);
    guard.attach(f.child);
    let resolve;
    f.change(() => new Promise(done => { resolve = done; }));
    f.clock.fire(1000);
    await flush();
    f.child.emit('exit');
    resolve({ ...healthy, bavail: 0n });
    await flush();
    assert.deepEqual(f.child.signals, []);
    assert.deepEqual(f.reasons, []);
    assert.equal(f.clock.size, 0);
    assert.equal(f.closes, 1);
});
test('payload lifecycle actually installs the guard on only its admitted scratch child', async () => {
    const f = fixture();
    let launched = 0;
    const result = await runGuardedPayload(['/usr/bin/owned-synthetic'], { cwd: '/TEST/jobs/owned/workspace', jobId: 'owned', owner: async () => 0n,
        admit: async () => ({ layout: { jobRoot: '/TEST/jobs/owned' }, device: 2n }),
        fstat: () => ({ isFile: () => false, isFIFO: () => true }),
        pressure: async (input) => {
            assert.equal(input.directory, f.input.directory);
            assert.equal(input.device, 2n);
            assert.equal(input.minimumBytes, bytes);
            assert.equal(input.minimumInodes, inodes);
            return prepareScratchPressureGuard(f.input);
        }, launch: () => { launched++; return f.child; } });
    assert.equal(result, f.child);
    assert.equal(launched, 1);
    f.change(async () => ({ ...healthy, bavail: 0n }));
    f.clock.fire(1000);
    await flush();
    assert.deepEqual(f.child.signals, ['SIGTERM']);
    assert.deepEqual(f.outside.signals, []);
    f.child.emit('exit');
});
// This fails with an FD-backed probe: the admitted inode is retained as cwd,
// while the payload still starts in its explicit workspace. Replacing the named
// directory must fail closed even though the retained directory remains alive.
test('real retained probe keeps exact inode custody without changing payload cwd', async () => {
    const previous = process.cwd(), root = await realpath(await mkdtemp(join(tmpdir(), 'scratch-pressure-cwd-')));
    const directory = join(root, 'job'), workspace = join(directory, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory, { bigint: true }), child = new OwnChild(), clock = new Clock();
    let probe;
    try {
        const result = await runGuardedPayload(['/usr/bin/owned-synthetic'], { cwd: workspace, jobId: 'owned', owner: async () => metadata.uid,
            admit: async () => ({ layout: { jobRoot: directory }, device: metadata.dev }),
            fstat: () => ({ isFile: () => false, isFIFO: () => true }),
            pressure: async () => {
                probe = await retainScratchProbe(directory, metadata.dev, metadata.uid);
                assert.equal(process.cwd(), directory);
                await assert.rejects(retainScratchProbe(directory, metadata.dev, metadata.uid), ScratchPressureError);
                return prepareScratchPressureGuard({ directory, device: metadata.dev, uid: metadata.uid, minimumBytes: 0n, minimumInodes: 0n,
                    probe, schedule: clock.schedule, report: () => { } });
            },
            launch: (_command, _args, options) => {
                assert.equal(options.cwd, workspace);
                assert.equal(process.cwd(), directory);
                return child;
            } });
        assert.equal(result, child);
        await probe.sample();
        if (process.platform === 'linux') {
            for (const name of readdirSync('/proc/self/fd')) {
                const fd = Number(name);
                if (fd <= 2)
                    continue;
                try {
                    assert.equal(fstatSync(fd).isDirectory(), false, `unexpected retained directory FD ${fd}`);
                }
                catch (error) {
                    if (error.code !== 'EBADF')
                        throw error;
                }
            }
        }
        await rename(directory, join(root, 'retained-job'));
        await mkdir(directory, { mode: 0o700 });
        await assert.rejects(probe.sample(), ScratchPressureError);
        child.emit('exit');
        await probe.close();
        assert.equal(process.cwd(), '/');
        await assert.rejects(probe.sample(), ScratchPressureError);
        assert.deepEqual(child.signals, []);
        await assert.rejects(prepareScratchPressureGuard({ directory, device: metadata.dev, uid: metadata.uid,
            minimumBytes: 1n << 128n, minimumInodes: 0n }), (error) => error instanceof ScratchPressureError && error.reason === ScratchPressureReason.Bytes);
        assert.equal(process.cwd(), '/');
        const next = await retainScratchProbe(directory, metadata.dev, metadata.uid);
        await next.close();
    }
    finally {
        child.emit('exit');
        await probe?.close();
        process.chdir(previous);
        await rm(root, { recursive: true, force: true });
    }
});
