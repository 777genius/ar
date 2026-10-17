import { readFileSync, readlinkSync } from "node:fs";
import { retainOriginalFullProjectControlGuestEntry, retainOriginalFullProjectControlSupervisorEntry,
  type OriginalFullProjectControlEntry } from "../provider-codex/app-server/adapters/hosted-full-backing-stage.js";

/** Budget facts alone never activate NativeEntryLive or issue an SDK scope. */
enum OriginalSetupClockPhase { Supervisor = "supervisor_reserved", Guest = "guest_pre_authentication",
  Tentative = "guest_tentative_data", Closed = "closed" }
export type OriginalFullSetupClock = Readonly<{
  remainingReadMilliseconds(): number;
  remainingQueryMilliseconds(): number;
  readTentativeFrameData(line: string): void;
  revalidate(): void;
  close(): void;
}>;
const clocks = new WeakMap<object, Readonly<{ remainingRead(): number; remainingQuery(): number;
  tentative(line: string): void; frame(): string; remainingSdk(): number; revalidate(): void; close(): void }>>();
let guestIssued = false, supervisorIssued = false;
let guestClock: OriginalFullSetupClock | undefined, supervisorClock: OriginalFullSetupClock | undefined;
function check(value: unknown): asserts value { if (!value) throw new Error("hosted_original_setup_clock_held"); }
function useClock<T>(receiver: object, operation: (clock: NonNullable<ReturnType<typeof clocks.get>>) => T): T {
  const own = clocks.get(receiver); check(own);
  try { return operation(own); }
  catch (error) { clocks.delete(receiver); try { own.close(); } catch { /* Already permanently Held; uncertain close grants nothing. */ } throw error; }
}

/** Actual original entry, fresh source/epoch/time joins and one local reserve.
 * This is the narrow source owner for the approved pre-authentication bound;
 * neither a caller number nor this receiver proves parent deadline provenance. */
function reserve(entry: OriginalFullProjectControlEntry, phase: OriginalSetupClockPhase): OriginalFullSetupClock {
  let active = true;
  try {
    entry.revalidate(); check(process.version === "v22.23.3");
    const descriptors = entry.descriptors(), self = descriptors.filter(row => row.path === "/proc/" + process.pid),
      parent = descriptors.filter(row => row.path === "/proc/" + entry.callerPid);
    check(self.length === 1 && parent.length === 1);
    const selfPath = "/proc/self/fd/" + self[0]!.fd, parentPath = "/proc/self/fd/" + parent[0]!.fd;
    const names = ["time", "time_for_children"] as const;
    const timeNames = names.map(name => readlinkSync(selfPath + "/ns/" + name));
    const offsets = readFileSync(selfPath + "/timens_offsets");
    check(offsets.length <= 256 && names.every((name, index) => readlinkSync(parentPath + "/ns/" + name) === timeNames[index]) &&
      readFileSync(parentPath + "/timens_offsets").equals(offsets));
    const began = process.hrtime.bigint(), localSdkDeadline = began + 60_000_000_000n;
    let sdkDeadline = localSdkDeadline, handoffDeadline = phase === OriginalSetupClockPhase.Supervisor
      ? began + 10_000_000_000n : undefined;
    const revalidate = () => {
      check(active && phase !== OriginalSetupClockPhase.Closed); entry.revalidate();
      check(names.every((name, index) => readlinkSync(selfPath + "/ns/" + name) === timeNames[index] &&
        readlinkSync(parentPath + "/ns/" + name) === timeNames[index]) &&
        readFileSync(selfPath + "/timens_offsets").equals(offsets) && readFileSync(parentPath + "/timens_offsets").equals(offsets));
    };
    const remaining = (deadline: bigint, maximum: number) => {
      revalidate(); const left = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
      check(Number.isSafeInteger(left) && left > 0); return Math.min(left, maximum);
    };
    const remainingRead = () => { check(phase === OriginalSetupClockPhase.Guest); return remaining(sdkDeadline, 5_000); };
    const remainingQuery = () => {
      check(phase === OriginalSetupClockPhase.Supervisor || phase === OriginalSetupClockPhase.Tentative);
      check(handoffDeadline !== undefined); return remaining(handoffDeadline < sdkDeadline ? handoffDeadline : sdkDeadline, 5_000);
    };
    const tentative = (line: string) => {
      check(phase === OriginalSetupClockPhase.Guest && Buffer.byteLength(line) <= 128); revalidate();
      const match = /^TEST_sdk_deadlines_v2:([1-9][0-9]{0,23}):([1-9][0-9]{0,23})\n$/.exec(line);
      check(match); const handoff = BigInt(match[1]!), sdk = BigInt(match[2]!), now = process.hrtime.bigint();
      check(now < handoff && handoff <= sdk && handoff <= now + 10_000_000_000n && sdk <= now + 60_000_000_000n);
      handoffDeadline = handoff; sdkDeadline = sdk < localSdkDeadline ? sdk : localSdkDeadline;
      // This transition only reduces time. It does NOT bind an authentic parent
      // deadline, authorize a gate, or produce any allocation/read capability.
      phase = OriginalSetupClockPhase.Tentative;
    };
    const frame = () => { check(phase === OriginalSetupClockPhase.Supervisor && handoffDeadline !== undefined); remainingQuery();
      return "TEST_sdk_deadlines_v2:" + handoffDeadline + ":" + sdkDeadline + "\n"; };
    const remainingSdk = () => { check(phase === OriginalSetupClockPhase.Supervisor || phase === OriginalSetupClockPhase.Tentative); return remaining(sdkDeadline, 60_000); };
    const close = () => { check(active); active = false; phase = OriginalSetupClockPhase.Closed; entry.close(); };
    revalidate(); const receiver: OriginalFullSetupClock = Object.freeze({
      remainingReadMilliseconds() { return useClock(this, own => own.remainingRead()); },
      remainingQueryMilliseconds() { return useClock(this, own => own.remainingQuery()); },
      readTentativeFrameData(line: string) { useClock(this, own => own.tentative(line)); },
      revalidate() { useClock(this, own => own.revalidate()); },
      close() { const own = clocks.get(this); check(own); clocks.delete(this); own.close(); },
    });
    clocks.set(receiver, Object.freeze({ remainingRead, remainingQuery, tentative, frame, remainingSdk, revalidate, close })); return receiver;
  } catch (error) { if (active) entry.close(); throw error; }
}

/** Finite original Guest reserve. No input selects an actor, epoch or budget. */
export function reserveOriginalGuestSetupOnce(): OriginalFullSetupClock {
  check(!guestIssued); const entry = retainOriginalFullProjectControlGuestEntry(); guestIssued = true;
  guestClock = reserve(entry, OriginalSetupClockPhase.Guest); return guestClock;
}
/** Finite original Supervisor reserve before its first effect. Whole-run child
 * deadline/native cancellation remains the private actual spawn owner's duty. */
export function reserveOriginalSupervisorSetupOnce(): OriginalFullSetupClock {
  check(!supervisorIssued); const entry = retainOriginalFullProjectControlSupervisorEntry(); supervisorIssued = true;
  supervisorClock = reserve(entry, OriginalSetupClockPhase.Supervisor); return supervisorClock;
}

/** A factual effect bound from the original once-issued owner only. No caller
 * selects a receiver, timer, actor or reset; an absent/tentative-unready/closed
 * owner refuses before an auxiliary query can be dispatched. */
export function remainingOriginalPeerQueryMilliseconds(): number {
  const clock = process.argv[2] === "supervisor" ? supervisorClock : guestClock;
  check(clock); return clock.remainingQueryMilliseconds();
}

/** Original temporal DATA only; the hidden actual producer must still join its
 * live source-created child, kernel peers and capped whole-run reservation. */
export function originalSupervisorDeadlineFrame(): string {
  check(supervisorClock); return useClock(supervisorClock, own => own.frame());
}
/** An effect veto, never NativeEntryLive or a scope constructor. */
export function remainingOriginalSdkMilliseconds(): number {
  const clock = process.argv[2] === "supervisor" ? supervisorClock : guestClock;
  check(clock); return useClock(clock, own => own.remainingSdk());
}

/** Same once-reserved SDK clock, capped to the finite peer query bound. */
export function remainingOriginalSdkPeerQueryMilliseconds(): number {
  return Math.min(remainingOriginalSdkMilliseconds(), 5_000);
}
