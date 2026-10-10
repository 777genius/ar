import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { NativeWire } from "./native-wire";
import { parseStorageFilesystem, parseStorageGeneration, sameStorageGeneration, storageUInt, sameStorageFilesystem, type StorageFilesystem, type StorageGeneration } from "../../src/worker-core/job-storage-exposure/domain/storage-exposure";
import { BoundedStorageFailure, BoundedStorageInspection,
  type BoundedStorageBinding, type BoundedStorageCapacity, type BoundedStorageNativeFacts, type BoundedStorageNativeHost,
  type BoundedStorageNativeSession, type BoundedStorageObservation, type BoundedStorageRequest } from "../../src/worker-core/storage/bounded-storage-contract";
import { boundedDigest, boundedFailure, boundedFields, parseBoundedBinding, parseBoundedFacts, parseBoundedRequest } from "../../src/worker-core/storage/bounded-storage-policy";

/** Installed root service configuration, never a launch/payload argument. The
 * service's existing native admission owner supplies the verified binding;
 * these metadata fields do not manufacture its receipt or start authority. */
export type RegisteredBoundedStorageHost = {
  readonly filesystem: StorageFilesystem;
  readonly binding: BoundedStorageBinding;
  readonly admissionGeneration: StorageGeneration;
  readonly scratchRoot: string;
  readonly scratchBlockDevice: string;
  readonly controlRoot: string;
  readonly helperPath: string;
  readonly helperSha256: string;
};
enum NativeStorageMode { Registered = "--registered-fd-session-v1", NewTestOwner = "--new-test-owner-fd-session-v1" }
const maxLedger = 4 * 1024 * 1024;
const maxHelper = 2 * 1024 * 1024;
const decode = new TextDecoder("utf-8", { fatal: true });
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function fail(): never { return boundedFailure(BoundedStorageFailure.Identity); }
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function protectedHandle(path: string, kind: "directory" | "block" | "helper"): Promise<FileHandle> {
  if (!isAbsolute(path) || path.includes("\0")) fail();
  const canonical = await realpath(path);
  for (let ancestor = dirname(canonical); ; ancestor = dirname(ancestor)) {
    const s = await lstat(ancestor, { bigint: true });
    if (!s.isDirectory() || s.uid !== 0n || (s.mode & 0o022n)) fail();
    if (ancestor === "/") break;
  }
  const before = await lstat(canonical, { bigint: true });
  // Device nodes use the installed root/disk policy. They are never interpreted
  // as executable bytes. Root directories/helper code must be non-writable.
  if (before.uid !== 0n || before.isSymbolicLink() ||
      (kind !== "block" && (before.mode & 0o022n)) ||
      (kind === "directory" && !before.isDirectory()) || (kind === "block" && !before.isBlockDevice()) ||
      (kind === "helper" && (!before.isFile() || before.nlink !== 1n || (before.mode & 0o6000n) || !(before.mode & 0o100n)))) fail();
  const fd = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "directory" ? constants.O_DIRECTORY : 0));
  try { if (!same(before, await fd.stat({ bigint: true }))) fail(); return fd; }
  catch (error) { await fd.close(); throw error; }
}
async function authenticateHelper(fd: FileHandle, digest: string): Promise<void> {
  const before = await fd.stat({ bigint: true });
  if (before.size < 4n || before.size > BigInt(maxHelper)) fail();
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await fd.read(buffer, used, buffer.length - used, used);
    if (!bytesRead) break;
    used += bytesRead;
  }
  if (used !== Number(before.size) || !same(before, await fd.stat({ bigint: true })) ||
      !buffer.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || hash(buffer.subarray(0, used)) !== digest) fail();
}


export class NativeBoundedStorageHost implements BoundedStorageNativeHost {
  private readonly config: RegisteredBoundedStorageHost;
  constructor(config: RegisteredBoundedStorageHost) {
    const captured = boundedFields(config, ["filesystem", "binding", "admissionGeneration", "scratchRoot", "scratchBlockDevice", "controlRoot", "helperPath", "helperSha256"]);
    const filesystem = parseStorageFilesystem(boundedFields(captured.filesystem, ["machineId", "uuid", "device"])), binding = parseBoundedBinding(captured.binding);
    const admissionGeneration = parseStorageGeneration(boundedFields(captured.admissionGeneration, ["jobId", "generationId", "projectId"]));
    if (!sameStorageFilesystem(filesystem, binding.filesystem)) fail();
    for (const key of ["scratchRoot", "scratchBlockDevice", "controlRoot", "helperPath"]) {
      if (typeof captured[key] !== "string" || (captured[key] as string).length > 4096 || !isAbsolute(captured[key] as string) || (captured[key] as string).includes("\0")) fail();
    }
    this.config = Object.freeze({ filesystem, binding, admissionGeneration, scratchRoot: captured.scratchRoot as string, scratchBlockDevice: captured.scratchBlockDevice as string,
      controlRoot: captured.controlRoot as string, helperPath: captured.helperPath as string, helperSha256: boundedDigest(captured.helperSha256) });
  }
  async withFilesystemFence<T>(effect: (session: BoundedStorageNativeSession) => Promise<T>): Promise<T> {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) boundedFailure(BoundedStorageFailure.Unsupported);
    const handles: FileHandle[] = [];
    let wire: NativeWire | undefined;
    try {
      for (const [path, kind] of [[this.config.scratchRoot, "directory"], [this.config.controlRoot, "directory"],
        [this.config.scratchBlockDevice, "block"], [this.config.helperPath, "helper"]] as const) handles.push(await protectedHandle(path, kind));
      const [scratch, control, block, helper] = handles as [FileHandle, FileHandle, FileHandle, FileHandle];
      const s = await scratch.stat({ bigint: true }), c = await control.stat({ bigint: true }), b = await block.stat({ bigint: true });
      if (String(s.dev) !== this.config.filesystem.device || b.rdev !== s.dev || c.dev === s.dev || (c.mode & 0o7777n) !== 0o700n) fail();
      await authenticateHelper(helper, this.config.helperSha256);
      const child = spawn("/proc/self/fd/6", [NativeStorageMode.Registered, this.config.filesystem.machineId, this.config.filesystem.uuid], {
        stdio: ["pipe", "pipe", "pipe", scratch.fd, control.fd, block.fd, helper.fd], cwd: "/",
        env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C", HOME: "/nonexistent" },
      }) as ChildProcessWithoutNullStreams;
      wire = new NativeWire(child);
      const ready = (await wire.line()).split(" ");
      if (ready.length !== 8 || ready[0] !== "READY1" || ready[1] !== String(c.dev) || !storageUInt(ready[2]) ||
          ready[3] !== String(s.dev) || ready[4] !== String(c.dev) || ready[5] !== this.config.filesystem.machineId ||
          ready[6] !== this.config.filesystem.uuid || ready[7] !== this.config.binding.bootId) fail();
      const result = await effect(new NativeSession(wire, this.config.binding, this.config.admissionGeneration));
      await wire.finish(); return result;
    } catch (error) { wire?.stop(); if (wire) await wire.exited; throw error; }
    finally { await Promise.all(handles.map(fd => fd.close())); }
  }
}

type SessionWire = Pick<NativeWire, "command" | "line" | "consume"> & {
  retainedIdentity?: () => NewDedicatedTestHolderIdentity;
  terminalProbe?: (frame: Buffer) => Promise<NewDedicatedTestTerminalEvidence>;
};
class NativeSession implements NewDedicatedTestBoundary {
  constructor(private readonly wire: SessionWire, private readonly binding: BoundedStorageBinding, private readonly generation: StorageGeneration, private readonly test = false) {}
  private async simple(command: string, expected: string): Promise<void> {
    await this.wire.command(`${command}\n`, undefined, async () => { if (await this.wire.line() !== expected) fail(); });
  }
  assertHeld(): Promise<void> { return this.simple("ASSERT", "OK1"); }
  requirePreparationCapability(input: BoundedStorageRequest, digest: string): Promise<void> {
    const request = this.captured(input, digest, true);
    if (BigInt(request.baseline.bytes) !== 0n || BigInt(request.baseline.inodes) !== 0n) boundedFailure(BoundedStorageFailure.Unsupported);
    if (this.test) {
      const bytes = Buffer.from(JSON.stringify(request));
      return this.wire.command(`CAPABILITY ${bytes.length} ${digest}\n`, bytes, async () => { if (await this.wire.line() !== "CAPABLE1") fail(); });
    }
    return this.simple("CAPABILITY", "CAPABLE1");
  }
  requireNativeCurrent(bytes: string, digest: string): Promise<void> {
    if (!this.test || Buffer.byteLength(bytes) > 2048) fail();
    return this.wire.command(`CAPABILITY ${Buffer.byteLength(bytes)} ${boundedDigest(digest)}\n`, Buffer.from(bytes), async () => { if (await this.wire.line() !== "CAPABLE1") fail(); });
  }
  prepareNative(bytes: string, digest: string): Promise<void> {
    if (!this.test || Buffer.byteLength(bytes) > 2048) fail();
    return this.wire.command(`PREPARE_TEST ${Buffer.byteLength(bytes)} ${boundedDigest(digest)}\n`, Buffer.from(bytes), async () => { parseFacts(await this.wire.line()); });
  }
  retainedHolder(): NewDedicatedTestHolderIdentity {
    if (!this.test || !this.wire.retainedIdentity) fail();
    return this.wire.retainedIdentity();
  }
  probePendingAfterOwnerLoss(expected: string, next: string): Promise<NewDedicatedTestTerminalEvidence> {
    const old = Buffer.from(expected), bytes = Buffer.from(next);
    if (!this.test || !this.wire.terminalProbe || old.length > maxLedger || !bytes.length || bytes.length > maxLedger) fail();
    return this.wire.terminalProbe(Buffer.concat([Buffer.from(`PUBLISH ${old.length} ${bytes.length}\n`), old, bytes]));
  }
  probePrepareAfterOwnerLoss(bytes: string, digest: string): Promise<NewDedicatedTestTerminalEvidence> {
    if (!this.test || !this.wire.terminalProbe || !bytes.length || Buffer.byteLength(bytes) > 2048) fail();
    return this.wire.terminalProbe(Buffer.concat([Buffer.from(`PREPARE_TEST ${Buffer.byteLength(bytes)} ${boundedDigest(digest)}\n`), Buffer.from(bytes)]));
  }
  async readCapacity(): Promise<BoundedStorageCapacity> {
    return this.wire.command("CAPACITY\n", undefined, async () => {
      const r = (await this.wire.line()).split(" ");
      if (r.length !== 4 || r[0] !== "CAP1") fail();
      r.slice(1).forEach(storageUInt);
      return { available: { bytes: r[1]!, inodes: r[2]! }, rootAvailableBytes: r[3]! };
    });
  }
  async readLedger(): Promise<string | null> {
    return this.wire.command("READ\n", undefined, async () => {
      const r = (await this.wire.line()).split(" ");
      if (r.length !== 2 || r[0] !== "LEDGER1" || storageUInt(r[1]) > BigInt(maxLedger)) fail();
      const length = Number(r[1]), bytes = await this.wire.consume(length);
      if ((await this.wire.consume(1))[0] !== 10) fail();
      return length ? decode.decode(bytes) : null;
    });
  }
  publishLedger(expected: string | null, next: string): Promise<void> {
    const old = Buffer.from(expected ?? ""), bytes = Buffer.from(next);
    if (old.length > maxLedger || !bytes.length || bytes.length > maxLedger) boundedFailure(BoundedStorageFailure.Exhausted);
    return this.wire.command(`PUBLISH ${old.length} ${bytes.length}\n`, Buffer.concat([old, bytes]), async () => { if (await this.wire.line() !== "OK1") fail(); });
  }
  private captured(input: BoundedStorageRequest, digest: string, preparation: boolean): BoundedStorageRequest {
    const request = parseBoundedRequest(input);
    if (!sameStorageFilesystem(request.binding.filesystem, this.binding.filesystem) || request.binding.bootId !== this.binding.bootId ||
        hash(JSON.stringify(request)) !== boundedDigest(digest)) fail();
    // Inspect prior registered rows under the protected ledger's exact digest,
    // even when their receipt differs from the next admission. Only preparation
    // must match the current native admission owner's binding/generation.
    if (preparation && (JSON.stringify(request.binding) !== JSON.stringify(this.binding) || !sameStorageGeneration(request.generation, this.generation))) fail();
    return request;
  }
  async prepare(input: BoundedStorageRequest, digest: string): Promise<BoundedStorageNativeFacts> {
    const request = this.captured(input, digest, true);
    // No sealed native import producer has been integrated yet. Refuse it,
    // retaining any Pending exposure; never pretend U0 was copied or verified.
    const nonempty = BigInt(request.baseline.bytes) !== 0n || BigInt(request.baseline.inodes) !== 0n;
    if (this.test) {
      const bytes = Buffer.from(JSON.stringify(request));
      return this.wire.command(`PREPARE_TEST ${bytes.length} ${digest}\n`, bytes,
        async () => parseBoundedFacts(parseFacts(await this.wire.line()), request, digest));
    }
    return this.wire.command(`PREPARE ${request.generation.generationId} ${request.operationId} ${digest} ${request.generation.projectId} ${request.cap.bytes} ${request.cap.inodes} ${request.physicalBytes} ${nonempty ? 1 : 0}\n`, undefined,
      async () => parseBoundedFacts(parseFacts(await this.wire.line()), request, digest));
  }
  async inspect(input: BoundedStorageRequest, digest: string): Promise<BoundedStorageObservation> {
    const request = this.captured(input, digest, false);
    const bytes = this.test ? Buffer.from(JSON.stringify(request)) : undefined;
    const command = bytes ? `INSPECT_TEST ${bytes.length} ${digest}\n` : `INSPECT ${request.generation.generationId} ${request.operationId} ${digest}\n`;
    return this.wire.command(command, bytes, async () => {
      const line = await this.wire.line();
      if (line === "ABSENT1") return { kind: BoundedStorageInspection.Absent };
      if (line === "PARTIAL1") return { kind: BoundedStorageInspection.Partial };
      return { kind: BoundedStorageInspection.Prepared, facts: parseBoundedFacts(parseFacts(line), request, digest) };
    });
  }
}
function parseFacts(line: string): BoundedStorageNativeFacts {
  const r = line.split(" ");
  if (r.length !== 19 || r[0] !== "FACT1") fail();
  return { requestSha256: r[1]!, backingDevice: r[2]!, backingInode: r[3]!, backingBytes: r[4]!, allocatedBytes: r[5]!,
    loopDevice: r[6]!, innerUuid: r[7]!, payloadDevice: r[8]!, payloadInode: r[9]!, payloadMountId: r[10]!,
    nativeNamespaceInode: r[11]!, projectId: Number(r[12]), hardLimit: { bytes: r[13]!, inodes: r[14]! },
    usage: { bytes: r[15]!, inodes: r[16]! }, reachable: { bytes: r[17]!, inodes: r[18]! } };
}

/** Adapter-only TEST composition. No exports through worker-core or package
 * public API, no registry/launcher integration and no production A capability. */
export enum NewDedicatedTestPurpose { B1 = "NEW_TEST_storage_b1_dedicated_ext4_no_real_projects" }
export type NewDedicatedTestCreation = {
  readonly purpose: NewDedicatedTestPurpose.B1;
  readonly backingParent: FileHandle;
  readonly controlParent: FileHandle;
  readonly policy: FileHandle;
  readonly helper: FileHandle;
  readonly helperSha256: string;
};
export enum NewDedicatedTestRootProbe { CompetingControl = "ROOT2", Subtree = "SUBFS", LegacySession = "LEGAC" }
/** Observations from the already leased ingress, never serialized membership. */
export type NewDedicatedTestHolderIdentity = { readonly ownerPid: number; readonly holderPid: number; readonly channel: number };
export type NewDedicatedTestTerminalEvidence = NewDedicatedTestHolderIdentity & {
  readonly remoteEOF: boolean;
  readonly output: string;
  readonly writeError: string | null;
};
export interface NewDedicatedTestBoundary extends BoundedStorageNativeSession {
  retainedHolder(): NewDedicatedTestHolderIdentity;
  /** Terminal TEST probes write directly to the retained native ingress, even
   * after owner/TS stopped flags. No command guard can satisfy this regression. */
  probePendingAfterOwnerLoss(expected: string, next: string): Promise<NewDedicatedTestTerminalEvidence>;
  probePrepareAfterOwnerLoss(bytes: string, digest: string): Promise<NewDedicatedTestTerminalEvidence>;
  requireNativeCurrent(bytes: string, digest: string): Promise<void>;
  prepareNative(bytes: string, digest: string): Promise<void>;
}
export interface NewDedicatedTestHost extends BoundedStorageNativeHost {
  withNativeBoundary<T>(effect: (session: NewDedicatedTestBoundary) => Promise<T>): Promise<T>;
}
export type NewDedicatedTestAdmission = {
  readonly host: NewDedicatedTestHost;
  readonly request: BoundedStorageRequest;
  readonly binding: BoundedStorageBinding;
  readonly generation: StorageGeneration;
};
export type NewDedicatedTestObservation = {
  readonly ownerPid: number;
  readonly filesystem: StorageFilesystem;
  readonly bootId: string;
  readonly namespaceInode: string;
  readonly fenceDevice: string;
  readonly fenceInode: string;
  readonly claimInode: string;
  /** Read-only observation paths into the original owner's pinned descriptors.
   * These strings are not an admission or a namespace/start handoff. */
  readonly scratchRoot: string;
  readonly controlRoot: string;
  readonly blockDevice: string;
};
export interface NewDedicatedTestOwner {
  readonly observation: NewDedicatedTestObservation;
  admitPreparation(): Promise<NewDedicatedTestAdmission>;
  probeRoot(probe: NewDedicatedTestRootProbe): Promise<void>;
  /** WAIT1 reports an attempt; only /proc/locks proves kernel contention. */
  onLockAttempt(observer: ((pid: number, device: string, inode: string) => void) | undefined): void;
  /** TEST terminal boundary: kill exactly this original owned child process. */
  terminate(): Promise<void>;
}

/** One reusable inherited duplex ingress. The native owner forks a fresh
 * holder and creates its private liveness socketpair for each BEGIN. EOF of
 * that private channel is fatal; this TS stream cannot manufacture membership. */
class TestHolderWire implements SessionWire {
  private bytes = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private deadline = Date.now() + 300000;
  private busy = false;
  private terminal = false;
  private refused = false;
  private remoteEOF = false;
  private probed = false;
  private readonly receive = (bytes: Buffer): void => {
    if (this.bytes.length + bytes.length > maxLedger + 4096) { this.terminal = true; }
    else this.bytes = Buffer.concat([this.bytes, bytes]);
    this.wake?.();
  };
  private readonly closed = (): void => { this.terminal = true; this.wake?.(); };
  private readonly ended = (): void => { this.remoteEOF = true; this.wake?.(); };
  constructor(private readonly stream: Duplex, private readonly owner: ChildProcessWithoutNullStreams, private readonly channel: number) {
    stream.on("end", this.ended);
    stream.on("data", this.receive); stream.on("error", this.closed); stream.on("close", this.closed); owner.on("close", this.closed);
  }
  dispose(): void {
    this.stream.off("end", this.ended); this.stream.off("data", this.receive); this.stream.off("error", this.closed); this.stream.off("close", this.closed); this.owner.off("close", this.closed);
  }
  retainedIdentity(): NewDedicatedTestHolderIdentity {
    if (!this.pid || !this.owner.pid) fail();
    return { ownerPid: this.owner.pid, holderPid: this.pid, channel: this.channel };
  }
  async terminalProbe(frame: Buffer): Promise<NewDedicatedTestTerminalEvidence> {
    const identity = this.retainedIdentity();
    if (this.probed || this.busy || this.bytes.length) fail();
    this.probed = true;
    // Deliberately bypass command()/write() terminal and stopped guards. An
    // actual socket EOF/refusal plus exact owned-process death is the evidence.
    let writeError: string | null = null;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { writeError = "native_ingress_write_timeout"; resolve(); }, 2000);
      this.stream.write(frame, (error?: Error | null) => {
        clearTimeout(timer);
        if (error) writeError = (error as NodeJS.ErrnoException).code ?? "native_ingress_write_error";
        resolve();
      });
    });
    if (!this.remoteEOF) await new Promise<void>(resolve => {
      const ended = (): void => { clearTimeout(timer); this.stream.off("end", ended); resolve(); };
      const timer = setTimeout(ended, 2000);
      this.stream.once("end", ended);
      if (this.remoteEOF) ended();
    });
    if (this.bytes.length > 4096) boundedFailure(BoundedStorageFailure.Exhausted);
    return { ...identity, remoteEOF: this.remoteEOF, output: decode.decode(this.bytes), writeError };
  }
  async consume(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLedger) fail();
    while (this.bytes.length < length) {
      if (this.terminal || Date.now() >= this.deadline) boundedFailure(BoundedStorageFailure.Uncertain);
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, Math.min(1000, this.deadline - Date.now()));
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
    const bytes = this.bytes.subarray(0, length); this.bytes = this.bytes.subarray(length); return bytes;
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 1024) {
      const b = (await this.consume(1))[0]!;
      if (b === 10) {
        const text = decode.decode(Uint8Array.from(bytes));
        if (text.startsWith("ERROR1 ")) {
          this.refused = true;
          const reason = text.split(" ")[1];
          boundedFailure(Object.values(BoundedStorageFailure).includes(reason as BoundedStorageFailure) ? reason as BoundedStorageFailure : BoundedStorageFailure.Uncertain);
        }
        return text;
      }
      bytes.push(b);
    }
    boundedFailure(BoundedStorageFailure.Exhausted);
  }
  async command<T>(header: string, payload: Buffer | undefined, response: () => Promise<T>): Promise<T> {
    if (this.busy || this.terminal || this.refused || !/^[A-Z0-9_ .a-f-]+\n$/.test(header)) boundedFailure(BoundedStorageFailure.Uncertain);
    this.busy = true; this.deadline = Date.now() + 300000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([ (async () => {
        await this.write(header); if (payload) await this.write(payload); return response();
      })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.terminal = true; this.wake?.(); reject(new Error("TEST_holder_command_uncertain")); }, 300000); }) ]);
    } finally { if (timer) clearTimeout(timer); this.busy = false; }
  }
  private async write(bytes: string | Buffer): Promise<void> {
    if (this.terminal || this.refused) boundedFailure(BoundedStorageFailure.Uncertain);
    await new Promise<void>((resolve, reject) => this.stream.write(bytes, error => error ? reject(error) : resolve()));
  }
  pid: number | undefined;
  async begin(mode = "BEGIN"): Promise<{ pid: number; device: string; inode: string }> {
    if (!["BEGIN", ...Object.values(NewDedicatedTestRootProbe)].includes(mode)) fail();
    return this.command(`${mode}\n`, undefined, async () => {
      const start = (await this.line()).split(" ");
      if (start.length !== 2 || start[0] !== "START1" || storageUInt(start[1]) < 2n) fail();
      this.pid = Number(start[1]);
      const wait = (await this.line()).split(" ");
      if (wait.length !== 4 || wait[0] !== "WAIT1" || Number(storageUInt(wait[1])) !== this.pid) fail();
      storageUInt(wait[2]); storageUInt(wait[3]);
      return { pid: this.pid, device: wait[2]!, inode: wait[3]! };
    });
  }
  async held(device: string, inode: string): Promise<void> {
    if (await this.line() !== `HELD1 ${device} ${inode}`) fail();
  }
  async finish(): Promise<void> {
    await this.command("END\n", undefined, async () => { if (await this.line() !== "EXIT1 0") boundedFailure(BoundedStorageFailure.Uncertain); });
    if (this.bytes.length) fail();
  }
  async killed(): Promise<void> {
    this.deadline = Date.now() + 5000;
    // A refusal can precede termination. Consume bounded native terminal output
    // before reusing this ingress for a new distinct holder.
    for (let n = 0; n < 4; n++) {
      try { if ((await this.line()).startsWith("EXIT1 ")) { if (this.bytes.length) fail(); return; } }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith("bounded_storage:")) throw error; }
    }
    boundedFailure(BoundedStorageFailure.Uncertain);
  }
}

class InvocationTestOwner implements NewDedicatedTestOwner {
  private readonly leased = new Set<number>();
  private observer: ((pid: number, device: string, inode: string) => void) | undefined;
  private stopped = false;
  private issuedRequest: BoundedStorageRequest | undefined;
  constructor(readonly observation: NewDedicatedTestObservation, private readonly master: NativeWire,
    private readonly channels: readonly Duplex[]) {
    for (const channel of channels) channel.on("error", () => {
      if (!this.stopped) { this.stopped = true; this.master.stop(); }
    });
  }
  onLockAttempt(observer: ((pid: number, device: string, inode: string) => void) | undefined): void { this.observer = observer; }
  async admitPreparation(): Promise<NewDedicatedTestAdmission> {
    if (this.stopped || this.leased.size) boundedFailure(BoundedStorageFailure.Conflict);
    return this.master.command("ADMIT\n", undefined, async () => {
      const header = (await this.master.line()).split(" ");
      if (header.length !== 2 || header[0] !== "CURRENT1" || storageUInt(header[1]) > 2048n) fail();
      const bytes = await this.master.consume(Number(header[1])); if ((await this.master.consume(1))[0] !== 10) fail();
      const request = parseBoundedRequest(JSON.parse(decode.decode(bytes)) as unknown);
      if (JSON.stringify(request) !== decode.decode(bytes) || !sameStorageFilesystem(request.binding.filesystem, this.observation.filesystem) || request.binding.bootId !== this.observation.bootId) fail();
      this.issuedRequest = request;
      const host: NewDedicatedTestHost = Object.freeze({
        withFilesystemFence: <T>(effect: (session: BoundedStorageNativeSession) => Promise<T>) => this.withFence(request, effect),
        withNativeBoundary: <T>(effect: (session: NewDedicatedTestBoundary) => Promise<T>) => this.withFence(request, effect),
      });
      return Object.freeze({ host, request, binding: request.binding, generation: request.generation });
    });
  }
  private async withFence<T>(request: BoundedStorageRequest, effect: (session: NewDedicatedTestBoundary) => Promise<T>, mode = "BEGIN"): Promise<T> {
    if (this.stopped) boundedFailure(BoundedStorageFailure.Uncertain);
    const slot = this.channels.findIndex((_channel, index) => !this.leased.has(index));
    if (slot < 0) boundedFailure(BoundedStorageFailure.Exhausted);
    this.leased.add(slot);
    const wire = new TestHolderWire(this.channels[slot]!, this.master.child, slot);
    let pid: number | undefined;
    try {
      const wait = await wire.begin(mode); pid = wait.pid;
      if (wait.device !== this.observation.fenceDevice || wait.inode !== this.observation.fenceInode) fail();
      this.observer?.(pid, wait.device, wait.inode);
      await wire.held(wait.device, wait.inode);
      const result = await effect(new NativeSession(wire, request.binding, request.generation, true));
      await wire.finish(); return result;
    } catch (error) {
      // Parent verifies persisted fork ownership before KILL. If it already
      // observed holder exit, KILL would be uncertain: consume EXIT first.
      pid ??= wire.pid;
      if (pid && !this.stopped) {
        try {
          await this.master.command(`KILL ${pid}\n`, undefined, async () => { const line = await this.master.line(); if (line !== "OK1" && line !== "DONE1") fail(); });
          await wire.killed();
        } catch { this.stopped = true; this.master.stop(); await this.master.exited; }
      } else if (!pid && !this.stopped) {
        this.stopped = true; this.master.stop(); await this.master.exited;
      }
      throw error;
    } finally { wire.dispose(); this.leased.delete(slot); }
  }
  async probeRoot(probe: NewDedicatedTestRootProbe): Promise<void> {
    if (!Object.values(NewDedicatedTestRootProbe).includes(probe)) fail();
    if (!this.issuedRequest) boundedFailure(BoundedStorageFailure.Conflict);
    await this.withFence(this.issuedRequest, async () => { throw new Error("native_competing_root_unexpectedly_admitted"); }, probe);
  }
  async terminate(): Promise<void> {
    this.stopped = true;
    const child = this.master.child;
    // Wait for the exact owner's process exit, not stdio close: a retained
    // holder inherits stderr and must never hold this kill/callback barrier.
    const exited = new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); child.off("exit", done); resolve(); };
      const timer = setTimeout(() => { child.off("exit", done); reject(new Error("native_TEST_owner_exit_timeout")); }, 5000);
      child.once("exit", done);
      if (child.exitCode !== null || child.signalCode !== null) done();
    });
    this.master.stop(); await exited;
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.master.command("CLOSE\n", undefined, async () => { if (await this.master.line() !== "CLOSED1") fail(); });
    await this.master.finish();
  }
}

export async function withNewDedicatedTestOwner<T>(creation: NewDedicatedTestCreation, use: (owner: NewDedicatedTestOwner) => Promise<T>): Promise<T> {
  const captured = boundedFields(creation, ["purpose", "backingParent", "controlParent", "policy", "helper", "helperSha256"]);
  if (captured.purpose !== NewDedicatedTestPurpose.B1 || process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) boundedFailure(BoundedStorageFailure.Unsupported);
  const digest = boundedDigest(captured.helperSha256);
  const handles: FileHandle[] = [];
  let wire: NativeWire | undefined, owner: InvocationTestOwner | undefined;
  try {
    for (const [key, kind] of [["backingParent", "directory"], ["controlParent", "directory"], ["helper", "helper"]] as const) {
      const input = captured[key] as FileHandle;
      if (!Number.isSafeInteger(input?.fd) || input.fd < 3) fail();
      const fd = await protectedHandle(await realpath(`/proc/self/fd/${input.fd}`), kind);
      if (!same(await input.stat({ bigint: true }), await fd.stat({ bigint: true }))) { await fd.close(); fail(); }
      handles.push(fd);
    }
    const [backing, control, helper] = handles as [FileHandle, FileHandle, FileHandle];
    const backingPath = await realpath(`/proc/self/fd/${backing.fd}`), controlPath = await realpath(`/proc/self/fd/${control.fd}`);
    if (!/^\/srv\/workers\/test-storage-b1-[0-9a-f-]{36}\/new-parent$/.test(backingPath) ||
        !/^\/var\/lib\/subscription-runtime-test\/test-storage-b1-[0-9a-f-]{36}\/new-parent$/.test(controlPath)) fail();
    const b = await backing.stat({ bigint: true }), c = await control.stat({ bigint: true });
    if (b.dev === c.dev || (b.mode & 0o7777n) !== 0o700n || (c.mode & 0o7777n) !== 0o700n) fail();
    const inputPolicy = captured.policy as FileHandle;
    if (!Number.isSafeInteger(inputPolicy?.fd) || inputPolicy.fd < 3) fail();
    const policyPath = await realpath(`/proc/self/fd/${inputPolicy.fd}`);
    for (let path = dirname(policyPath); ; path = dirname(path)) {
      const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.uid !== 0n || (s.mode & 0o022n)) fail(); if (path === "/") break;
    }
    const policy = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(policy);
    const p = await policy.stat({ bigint: true });
    if (!same(p, await inputPolicy.stat({ bigint: true })) || !p.isFile() || p.uid !== 0n || p.gid !== 0n || p.nlink !== 1n || (p.mode & 0o7777n) !== 0o400n || p.size > 511n) fail();
    await authenticateHelper(helper, digest);
    const child = spawn("/proc/self/fd/6", [NativeStorageMode.NewTestOwner], {
      stdio: ["pipe", "pipe", "pipe", backing.fd, control.fd, policy.fd, helper.fd, "pipe", "pipe", "pipe", "pipe"], cwd: "/",
      env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C", HOME: "/nonexistent" },
    }) as ChildProcessWithoutNullStreams;
    wire = new NativeWire(child);
    const r = (await wire.line()).split(" ");
    if (r.length !== 9 || r[0] !== "OWNER1" || !child.pid) fail();
    const filesystem = parseStorageFilesystem({ machineId: r[1], uuid: r[2], device: r[3] });
    const observation: NewDedicatedTestObservation = Object.freeze({ ownerPid: child.pid, filesystem, bootId: r[4]!, namespaceInode: r[5]!, fenceDevice: r[6]!, fenceInode: r[7]!, claimInode: r[8]!,
      scratchRoot: `/proc/${child.pid}/fd/3`, controlRoot: `/proc/${child.pid}/fd/4`, blockDevice: `/proc/${child.pid}/fd/5` });
    if (!/^[0-9a-f-]{36}$/.test(observation.bootId) || r.slice(5).some(value => storageUInt(value) === 0n) || observation.fenceDevice !== String(c.dev)) fail();
    const channels = child.stdio.slice(7, 11) as Duplex[];
    if (channels.length !== 4 || channels.some(channel => !channel?.readable || !channel.writable)) fail();
    owner = new InvocationTestOwner(observation, wire, channels);
    const result = await use(owner); await owner.close(); return result;
  } catch (error) { if (owner) await owner.terminate(); else if (wire) { wire.stop(); await wire.exited; } throw error; }
  finally { await Promise.all(handles.map(handle => handle.close())); }
}
