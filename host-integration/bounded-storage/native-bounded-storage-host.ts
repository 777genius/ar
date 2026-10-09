import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
const maxLedger = 4 * 1024 * 1024;
const maxHelper = 2 * 1024 * 1024;
const decode = new TextDecoder("utf-8", { fatal: true });
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => boundedFailure(BoundedStorageFailure.Identity);
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
      const child = spawn("/proc/self/fd/6", ["--registered-fd-session-v1", this.config.filesystem.machineId, this.config.filesystem.uuid], {
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

class NativeSession implements BoundedStorageNativeSession {
  constructor(private readonly wire: NativeWire, private readonly binding: BoundedStorageBinding, private readonly generation: StorageGeneration) {}
  private async simple(command: string, expected: string): Promise<void> {
    await this.wire.command(`${command}\n`, undefined, async () => { if (await this.wire.line() !== expected) fail(); });
  }
  assertHeld(): Promise<void> { return this.simple("ASSERT", "OK1"); }
  requirePreparationCapability(input: BoundedStorageRequest, digest: string): Promise<void> {
    const request = this.captured(input, digest, true);
    if (BigInt(request.baseline.bytes) !== 0n || BigInt(request.baseline.inodes) !== 0n) boundedFailure(BoundedStorageFailure.Unsupported);
    return this.simple("CAPABILITY", "CAPABLE1");
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
    return this.wire.command(`PREPARE ${request.generation.generationId} ${request.operationId} ${digest} ${request.generation.projectId} ${request.cap.bytes} ${request.cap.inodes} ${request.physicalBytes} ${nonempty ? 1 : 0}\n`, undefined,
      async () => parseBoundedFacts(parseFacts(await this.wire.line()), request, digest));
  }
  async inspect(input: BoundedStorageRequest, digest: string): Promise<BoundedStorageObservation> {
    const request = this.captured(input, digest, false);
    return this.wire.command(`INSPECT ${request.generation.generationId} ${request.operationId} ${digest}\n`, undefined, async () => {
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
