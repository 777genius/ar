// Source for storage-pressure-guard.mjs; regenerate with the project-pinned tsc.
import { writeSync } from 'node:fs';
import { lstat, realpath, stat, statfs } from 'node:fs/promises';
export var ScratchPressureReason;
(function (ScratchPressureReason) {
    ScratchPressureReason["Bytes"] = "scratch_bytes";
    ScratchPressureReason["Inodes"] = "scratch_inodes";
    ScratchPressureReason["Unknown"] = "scratch_observation_unknown";
})(ScratchPressureReason || (ScratchPressureReason = {}));
export class ScratchPressureError extends Error {
    reason;
    constructor(reason) {
        super(`managed payload: ${reason}`);
        this.reason = reason;
    }
}
const schedule = (callback, delay) => { const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) }; };
// The trusted guard owns one payload. Its kernel cwd reference pins the exact
// admitted directory without adding a directory FD to the governed FD table.
// runGuardedPayload captures and passes the payload's workspace cwd explicitly.
let retainedCwd = false;
export async function retainScratchProbe(directory, device, uid) {
    if (retainedCwd)
        throw new ScratchPressureError(ScratchPressureReason.Unknown);
    retainedCwd = true;
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        // Relinquish the admitted inode even if its pathname was removed/replaced.
        process.chdir('/');
        retainedCwd = false;
    };
    try {
        const held = await lstat(directory, { bigint: true });
        if (!held.isDirectory() || held.isSymbolicLink() || held.dev !== device || held.uid !== uid ||
            (held.mode & 18n) !== 0n || await realpath(directory) !== directory)
            throw new ScratchPressureError(ScratchPressureReason.Unknown);
        process.chdir(directory);
        const identity = async () => {
            if (closed)
                throw new ScratchPressureError(ScratchPressureReason.Unknown);
            const named = await lstat(directory, { bigint: true }), current = await stat('.', { bigint: true });
            if (closed || !named.isDirectory() || named.isSymbolicLink() || named.dev !== device || named.uid !== uid ||
                (named.mode & 18n) !== 0n || named.ino !== held.ino || current.ino !== held.ino ||
                current.dev !== device || await realpath(directory) !== directory || closed)
                throw new ScratchPressureError(ScratchPressureReason.Unknown);
        };
        await identity();
        return { sample: async () => {
                await identity();
                const capacity = await statfs('.', { bigint: true });
                await identity();
                return capacity;
            }, close };
    }
    catch (error) {
        await close();
        throw error;
    }
}
export async function prepareScratchPressureGuard(input) {
    const clock = input.schedule ?? schedule;
    let probe;
    try {
        probe = input.probe ?? await retainScratchProbe(input.directory, input.device, input.uid);
    }
    catch {
        throw new ScratchPressureError(ScratchPressureReason.Unknown);
    }
    let closed = false, child, reason = null;
    let poll, deadline, grace;
    const close = () => {
        if (closed)
            return;
        closed = true;
        poll?.cancel();
        deadline?.cancel();
        grace?.cancel();
        child?.removeListener('exit', close);
        child?.removeListener('error', close);
        void probe.close().catch(() => { });
    };
    const report = input.report ?? (value => { writeSync(2, `managed payload: ${value}\n`); });
    const fail = (value) => {
        if (closed || reason !== null)
            return;
        reason = value;
        poll?.cancel();
        deadline?.cancel();
        // Reporting failure cannot prevent teardown or change the finite reason.
        try {
            report(value);
        }
        catch { /* The filesystem may already be full. */ }
        try {
            child?.kill('SIGTERM');
        }
        catch { /* Exit below still tears down the owned unit. */ }
        if (closed)
            return;
        grace = clock(() => {
            if (closed)
                return;
            try {
                child?.kill('SIGKILL');
            }
            catch { /* The captured child may have exited. */ }
            close();
            (input.forceExit ?? (() => process.exit(70)))();
        }, 5000);
    };
    const sample = () => new Promise(resolve => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            deadline?.cancel();
            resolve(value);
        };
        deadline = clock(() => finish(ScratchPressureReason.Unknown), 2000);
        void Promise.resolve().then(() => probe.sample()).then(capacity => {
            try {
                if (![capacity.bavail, capacity.bsize, capacity.ffree].every(v => typeof v === 'bigint' && v >= 0n) || capacity.bsize === 0n)
                    finish(ScratchPressureReason.Unknown);
                else if (capacity.bavail * capacity.bsize < input.minimumBytes)
                    finish(ScratchPressureReason.Bytes);
                else if (capacity.ffree < input.minimumInodes)
                    finish(ScratchPressureReason.Inodes);
                else
                    finish(null);
            }
            catch {
                finish(ScratchPressureReason.Unknown);
            }
        }, () => finish(ScratchPressureReason.Unknown));
    });
    const initial = await sample();
    if (initial !== null) {
        close();
        throw new ScratchPressureError(initial);
    }
    const tick = () => {
        if (closed || reason !== null)
            return;
        void sample().then(value => {
            if (closed || reason !== null)
                return;
            if (value !== null)
                fail(value);
            else
                poll = clock(tick, 1000);
        });
    };
    return { close, get reason() { return reason; }, attach: ownChild => {
            if (closed || child)
                throw new ScratchPressureError(ScratchPressureReason.Unknown);
            child = ownChild;
            child.once('exit', close);
            child.once('error', close);
            poll = clock(tick, 1000);
        } };
}
