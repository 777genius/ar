import { ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { spawnHostedFdProcess, readHostedFdProcessBirth, invalidateHostedFdProcess, HostedFdLaunchKind, type HostedFdOriginalSpawnCustody } from "./hosted-fd-child";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { Writable, PassThrough, type Readable } from "node:stream";
import { assertHostedActivationFence, type HostedActivationFence } from "./hosted-process-activation";
import { assertHostedFdBootstrap, assertHostedFdConfinement, assertHostedFdManagedGuard, collectHostedFdPeers, hostedFdGroupPids, hostedFdTable, observeHostedFdProcess,
  observeHostedFdUnit, readHostedFdProfile, type HostedFdFact, type HostedFdProcess, type HostedFdUnit } from "./hosted-fd-observation";
import { knownFdCollectorPeer, type FdCollectorProfile } from "@vioxen/subscription-runtime/core";
import { hostedFdReadyMarker, hostedInstallerReleaseMarker } from "./hosted-fd-prelude";
import { assertHostedDependencyToolParentFrame, assertHostedDependencyToolRelease } from "./hosted-dependency-tool-plan";
import { hostedDependencySystemdRunExecutable } from "./hosted-dependency-provider-launch";
import { revokeHostedToolFilesForChild } from "./hosted-retained-tool-files";

export { hostedFdReadyMarker, hostedInstallerReleaseMarker } from "./hosted-fd-prelude";
export { HostedFdLaunchKind } from "./hosted-fd-child";
export type { HostedFdOriginalSpawnCustody } from "./hosted-fd-child";
const launches = new WeakMap<object, HostedFdLaunch>();
// Cleanup identity survives revocation of execution/release permission. Only
// the completed fixed constructor can associate its actual child with a unit.
const cleanupUnits = new WeakMap<object, string>();
export enum HostedForegroundArtifactKind { Stdout = "hosted_foreground_stdout", Stderr = "hosted_foreground_stderr" }
export type HostedForegroundResult = Readonly<{ exitCode: number; unit: string; startId: string;
  artifacts: readonly Readonly<{ kind: HostedForegroundArtifactKind; path: string; dev: string; ino: string; byteLength: number; sha256: string }>[] }>;
export type HostedForegroundLaunchObservation = Readonly<{unit:string;startId:string;proxyPid:number;proxyBirth:string;invocationId:string;closeStatus:number}>;
// Existing result association retains only actual fixed-launch observations.
// These are factual inputs; kernel/current creator/drain checks grant authority.
const foregroundResults = new WeakMap<object,Readonly<{launch:HostedFdLaunch;observation:HostedForegroundLaunchObservation}>>();
export type HostedRemoverActorObservation = Readonly<{ unit: HostedFdUnit; actor: HostedFdProcess; proxy: HostedFdProcess }>;
export type HostedRemoverCloseResult = Readonly<{ unit: string; invocationId: string; actorBirth: string; proxyBirth: string;
  exitCode: number | null; signal: NodeJS.Signals | null }>;
const removerCloses = new WeakMap<object, HostedFdLaunch>();
/** A close result is produced only by the exact physical child retained here.
 * It supplies creator discharge facts; it never declares the unit terminal. */
export function assertHostedRemoverCloseResultForChild(result: HostedRemoverCloseResult, child: ChildProcess): void {
  if (removerCloses.get(result) !== launches.get(child) || !removerCloses.has(result)) invalid();
}
export function readHostedForegroundLaunchObservation(result:HostedForegroundResult):HostedForegroundLaunchObservation {
  const observed=foregroundResults.get(result); if (!observed) invalid(); return observed.observation;
}
export function assertHostedForegroundResultForChild(result:HostedForegroundResult,child:ChildProcess):void {
  const observed=foregroundResults.get(result); if (!observed || launches.get(child)!==observed.launch) invalid();
}
export function assertHostedForegroundResult(result: HostedForegroundResult): void {
  if (!foregroundResults.has(result)) invalid();
}
function invalid(): never { throw new Error("hosted_fd_boundary_unresolved"); }
const socket = (fd: HostedFdFact): string => {
  const match = /^socket:\[([1-9][0-9]*)\]$/.exec(fd.target);
  if (!fd.socket || !match || BigInt(match[1]!) > 4294967295n) invalid();
  return match[1]!;
};
type Proof = Readonly<{ unit: HostedFdUnit; proxy: HostedFdProcess; bootstrap: HostedFdProcess; endpoints: readonly string[] }>;

/** Owns the real streams from this exact fixed spawn. No serialized object can
 * reconstruct the launch, endpoint ownership or a successful release. */
export class HostedFdLaunch {
  readonly #physicalChild: ChildProcess;
  #providerGate:Writable|undefined;
  readonly #input: Writable;
  readonly #output: NodeJS.ReadableStream | null;
  readonly #errorOutput: NodeJS.ReadableStream | null;
  readonly #started = process.hrtime.bigint();
  readonly #proxyBirth: string;
  readonly #profile: FdCollectorProfile;
  readonly #originalParentSockets: ReadonlySet<string>;
  readonly #serviceArgv: readonly string[];
  readonly #managedJobId: string | undefined;
  readonly #root: string;
  #proof: Proof | undefined;
  #released = false;
  #invalidated = false;
  #ready = false;
  #closed = false;
  #outputFailed = false;
  #exitStatus = 70;
  #signalTerminated = true;
  #closeExitCode: number | null = null;
  #closeSignal: NodeJS.Signals | null = null;
  #pending = Buffer.alloc(0);
  readonly #filtered = new PassThrough();
  readonly #logs: readonly { path: string; fd: number; dev: number; ino: number }[];
  readonly outputPaths: readonly string[];

  private constructor(readonly child: ChildProcess, readonly unit: string, readonly kind: HostedFdLaunchKind,
    profile: FdCollectorProfile, before: readonly HostedFdFact[], command: string, args: readonly string[]) {
    this.#physicalChild = child;
    if (!child.pid || !child.stdin) invalid();
    this.#profile = profile; this.#input = child.stdin; this.#output = child.stdout; this.#errorOutput = child.stderr;
    this.#proxyBirth = readHostedFdProcessBirth(child, unit, kind, command, args);
    if (command === hostedDependencySystemdRunExecutable) {
      const at = args.indexOf("--"); if (at < 0) invalid(); this.#serviceArgv = Object.freeze(args.slice(at + 1));
      const roots = args.filter(arg => arg.startsWith("--property=RootDirectory="));
      if (roots.length > 1) invalid(); this.#root = roots[0]?.slice("--property=RootDirectory=".length) ?? "";
    } else {
      const request = JSON.parse(args[2]!) as { jobId: string; payload: string[] };
      if (args[0] !== "/opt/subscription-runtime/managed-launcher/launch.mjs" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.jobId)) invalid();
      this.#managedJobId = request.jobId;
      this.#root = "";
      this.#serviceArgv = Object.freeze(["/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL",
        "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--",
        profile.node.path, "/opt/subscription-runtime/managed-launcher/payload-guard.mjs", "--job-id", request.jobId, "--", ...request.payload]);
    }
    this.#originalParentSockets = new Set(before.filter(fd => fd.socket).map(socket));
    const logs: { path: string; fd: number; dev: number; ino: number }[] = [];
    try { if (kind === HostedFdLaunchKind.Foreground) for (const name of ["stdout", "stderr"]) logs.push(this.#createLog(name)); }
    catch (error) { for (const log of logs) closeSync(log.fd); throw error; }
    this.#logs = logs;
    this.outputPaths = Object.freeze(this.#logs.map(log => log.path));
    child.once("error", () => this.invalidate());
    child.once("exit", () => { if (!this.#released) this.invalidate(); });
    child.once("close", (code, signal) => { this.#closed = true; this.#signalTerminated = signal !== null;
      this.#closeExitCode = code; this.#closeSignal = signal;
      this.#exitStatus = signal === null ? code ?? 70 : 70; this.#closeStreams(); });
    this.#input.on("error", () => this.invalidate());
    if (kind !== HostedFdLaunchKind.Installer) {
      if (!this.#output || !this.#errorOutput) invalid();
      this.#output.on("data", (chunk: Buffer) => this.#onOutput(Buffer.from(chunk)));
      this.#output.once("end", () => this.#filtered.end());
      this.#errorOutput.on("data", (chunk: Buffer) => {
        if (kind === HostedFdLaunchKind.Foreground) this.#writeLog(1, Buffer.from(chunk));
      });
      this.#output.on("error", () => this.invalidate());
      this.#errorOutput.on("error", () => this.invalidate());
    }
    if (kind === HostedFdLaunchKind.Provider) {
      // Preserve the actual ChildProcess pid/events/kill identity. Public stdin
      // waits behind a genuine Writable; the private spawn stream stays retained.
      const gate = new Writable({ highWaterMark: profile.limits.maxBufferedInputBytes,
        write: (chunk, _encoding, done) => {
          if (this.#invalidated) { done(new Error("hosted_fd_launch_invalidated")); return; }
          if (chunk.length > profile.limits.maxBufferedInputBytes ||
              gate.writableLength > profile.limits.maxBufferedInputBytes) {
            this.invalidate(); done(new Error("hosted_fd_input_overflow")); return;
          }
          this.#waitReleased().then(() => this.#input.write(chunk, done), error => done(error as Error));
        },
        final: done => this.#waitReleased().then(() => this.#input.end(done), error => done(error as Error)),
        destroy: (error, done) => {
          if (!this.#released || error || !gate.writableFinished) this.invalidate();
          this.#input.destroy(error ?? undefined); done(error);
        } });
      // highWaterMark only signals backpressure: callers may keep writing while
      // the first callback waits. Bound every public enqueue, including end's
      // optional final chunk, before Writable can accumulate that queue.
      const write = gate.write.bind(gate), finish = gate.end.bind(gate);
      gate.write = ((chunk: string | Buffer | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void): boolean => {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined) :
          Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.byteLength : 0;
        if (!gate.writableEnded && gate.writableLength + bytes > profile.limits.maxBufferedInputBytes) {
          this.invalidate();
          const error = new Error("hosted_fd_input_overflow"), done = typeof encoding === "function" ? encoding : callback;
          queueMicrotask(() => { done?.(error); gate.destroy(error); }); return false;
        }
        return typeof encoding === "string" ? write(chunk, encoding, callback) : write(chunk, encoding ?? callback);
      }) as typeof gate.write;
      gate.end = ((chunk?: string | Buffer | Uint8Array | (() => void), encoding?: BufferEncoding | (() => void), callback?: () => void) => {
        if (typeof chunk === "function") return finish(chunk);
        const done = typeof encoding === "function" ? encoding : callback;
        if (chunk !== undefined && chunk !== null) {
          if (typeof encoding === "string") gate.write(chunk, encoding);
          else gate.write(chunk);
        }
        return done ? finish(done) : finish();
      }) as typeof gate.end;
      Object.defineProperty(child, "stdin", { configurable: true, enumerable: true, value: gate });
      Object.defineProperty(child, "stdout", { configurable: true, enumerable: true, value: this.#filtered });
      this.#providerGate = gate; gate.on("error", () => this.invalidate());
    }
  }

  #createLog(name: string) {
    const directory = "/var/lib/subscription-runtime-host-policy/foreground-output";
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o077)) invalid();
    const path = `${directory}/${this.unit}.${name}`;
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077)) { closeSync(fd); invalid(); }
    return { path, fd, dev: stat.dev, ino: stat.ino };
  }
  #writeLog(index: number, bytes: Buffer): void {
    const log = this.#logs[index];
    if (!log || this.#invalidated) return;
    try {
    const fd = fstatSync(log.fd), entry = lstatSync(log.path);
    if (!fd.isFile() || fd.nlink !== 1 || fd.uid !== 0 || (fd.mode & 0o077) ||
        fd.dev !== log.dev || fd.ino !== log.ino || entry.dev !== log.dev || entry.ino !== log.ino ||
        fd.size + bytes.length > 64 * 1024 * 1024) {
      this.invalidate(); this.child.kill("SIGTERM"); return;
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(log.fd, bytes, offset, bytes.length - offset);
      if (!written) { this.invalidate(); return; } offset += written;
    }
    } catch { this.invalidate(); this.child.kill("SIGTERM"); }
  }
  #onOutput(chunk: Buffer): void {
    if (this.#invalidated) return;
    if (!this.#ready) {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      if (this.#pending.length > this.#profile.limits.maxBufferedInputBytes) { this.invalidate(); return; }
      const at = this.#pending.indexOf(10);
      if (at < 0) return;
      if (this.#pending.subarray(0, at + 1).toString("ascii") !== hostedFdReadyMarker) { this.invalidate(); return; }
      this.#ready = true; chunk = this.#pending.subarray(at + 1); this.#pending = Buffer.alloc(0);
    }
    if (chunk.length) {
      if (!this.#released) { this.invalidate(); return; }
      if (this.kind === HostedFdLaunchKind.Foreground) this.#writeLog(0, chunk);
      else if (!this.#filtered.write(chunk)) {
        this.#output?.pause(); this.#filtered.once("drain", () => this.#output?.resume());
      }
    }
  }
  invalidate(): void {
    invalidateHostedFdProcess(this.child);
    revokeHostedToolFilesForChild(this.child);
    this.#outputFailed = true;
    this.#closeStreams();
  }
  #closeStreams(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    if (this.kind === HostedFdLaunchKind.Provider) { this.#providerGate?.destroy(); this.#input.destroy(); }
    for (const log of this.#logs) {
      try { fsyncSync(log.fd); } catch { this.#outputFailed = true; }
      try { closeSync(log.fd); } catch { this.#outputFailed = true; }
    }
  }
  #remaining(): number {
    const elapsed = Number((process.hrtime.bigint() - this.#started) / 1_000_000n);
    if (this.#invalidated || this.child.exitCode !== null || this.child.signalCode !== null ||
        this.#input.destroyed || elapsed >= this.#profile.limits.setupTimeoutMs) invalid();
    return this.#profile.limits.setupTimeoutMs - elapsed;
  }
  remainingSetupMs(): number { return this.#remaining(); }
  removerActorObservation(): HostedRemoverActorObservation {
    if (this.kind !== HostedFdLaunchKind.Remover || !this.#proof || this.#released) invalid();
    const actual = this.#collect(), previous = this.#proof;
    if (actual.bootstrap.birth !== previous.bootstrap.birth || actual.proxy.birth !== previous.proxy.birth ||
        JSON.stringify(actual.unit) !== JSON.stringify(previous.unit) || actual.endpoints.join(",") !== previous.endpoints.join(",")) invalid();
    this.#proof = actual;
    return Object.freeze({ unit: actual.unit, actor: actual.bootstrap, proxy: actual.proxy });
  }
  removerCloseResult(): HostedRemoverCloseResult {
    if (this.kind !== HostedFdLaunchKind.Remover || !this.#closed || !this.#released || this.#outputFailed || !this.#proof ||
        launches.get(this.#physicalChild) !== this || this.#proof.proxy.birth !== this.#proxyBirth) invalid();
    const result = Object.freeze({ unit: this.unit, invocationId: this.#proof.unit.invocation, actorBirth: this.#proof.bootstrap.birth,
      proxyBirth: this.#proxyBirth, exitCode: this.#closeExitCode, signal: this.#closeSignal });
    removerCloses.set(result, this); return result;
  }
  /** Production wait supplier must retain actual close and raw EOF, not just
   * exit/Stop or serialized kernel metadata. Works for the retained provider. */
  assertOriginalZeroWaitClosed(): void {
    if (!this.#closed || !this.#released || this.#outputFailed || this.#signalTerminated || this.#exitStatus !== 0 ||
        !this.#input.writableFinished || !this.#output || !this.#errorOutput ||
        !(this.#output as Readable).readableEnded || !(this.#errorOutput as Readable).readableEnded) invalid();
  }
  /** Called after the real --wait proxy closes all streams, and only after the
   * owner has separately proved its exact unit/cgroup terminal under its fence. */
  foregroundResult(): HostedForegroundResult {
    if (this.kind !== HostedFdLaunchKind.Foreground || !this.#closed || !this.#released || this.#outputFailed ||
        this.#signalTerminated || !Number.isInteger(this.#exitStatus) || this.#exitStatus < 0 || this.#exitStatus > 255) invalid();
    const artifacts = this.#logs.map((log, index) => {
      const fd = openSync(log.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd), entry = lstatSync(log.path);
        if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o077) ||
            before.dev !== log.dev || before.ino !== log.ino || entry.dev !== log.dev || entry.ino !== log.ino ||
            before.size > 64 * 1024 * 1024) invalid();
        const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(log.path);
        if (bytes.length !== before.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
            current.dev !== log.dev || current.ino !== log.ino || current.ctimeMs !== after.ctimeMs) invalid();
        return Object.freeze({ kind: index === 0 ? HostedForegroundArtifactKind.Stdout : HostedForegroundArtifactKind.Stderr,
          path: log.path, dev: String(log.dev), ino: String(log.ino), byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      } finally { closeSync(fd); }
    });
    const result = Object.freeze({ exitCode: this.#exitStatus, unit: this.unit,
      startId: this.unit.replace(/^subscription-runtime-(?:outer|ordinary)-/, "").replace(/\.service$/, ""), artifacts: Object.freeze(artifacts) });
    if (!this.#proof || launches.get(this.#physicalChild)!==this || this.#proof.proxy.birth!==this.#proxyBirth) invalid();
    foregroundResults.set(result,Object.freeze({launch:this,observation:Object.freeze({unit:result.unit,startId:result.startId,proxyPid:this.#proof.proxy.pid,
      proxyBirth:this.#proxyBirth,invocationId:this.#proof.unit.invocation,closeStatus:this.#exitStatus})})); return result;
  }
  /** Actual retained-launch facts; worker authority rechecks before physical IO. */
  #assertProviderInputReceiver(): void {
    if (launches.get(this.#physicalChild) !== this || this.child !== this.#physicalChild) invalid();
  }
  providerInputByteLimit(): number {
    this.#assertProviderInputReceiver();
    if (this.kind !== HostedFdLaunchKind.Provider || this.#invalidated) invalid();
    return this.#profile.limits.maxBufferedInputBytes;
  }
  awaitReleasedProviderInput(): Promise<void> {
    this.#assertProviderInputReceiver();
    if (this.kind !== HostedFdLaunchKind.Provider) invalid(); return this.#waitReleased();
  }
  writeReleasedProviderInput(chunk?: string | Uint8Array): Promise<void> {
    this.#assertProviderInputReceiver();
    if (this.kind !== HostedFdLaunchKind.Provider || this.#invalidated || !this.#released || this.#closed || this.#input.destroyed) invalid();
    if (chunk !== undefined && (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength) > this.#profile.limits.maxBufferedInputBytes) invalid();
    return new Promise((resolve,reject) => {
      if (chunk === undefined) { this.#input.end(() => resolve()); return; }
      this.#input.write(chunk,error => { if (error) reject(error); else resolve(); });
    });
  }
  async #waitReleased(): Promise<void> {
    while (!this.#released) { this.#remaining(); await new Promise(resolve => setTimeout(resolve, 10)); }
    if (this.#invalidated) invalid();
  }
  async observe(): Promise<void> {
    while (true) {
      this.#remaining();
      try {
        if (this.kind !== HostedFdLaunchKind.Installer && !this.#ready) invalid();
        this.#proof = this.#collect(); return;
      } catch {
        this.#remaining(); await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  #collect(): Proof {
    this.#remaining();
    // This closure measures this actual spawn's original monotonic allowance;
    // it is not a caller timeout, admission token or new budget per child query.
    const remaining = () => this.#remaining();
    const profile = readHostedFdProfile(remaining);
    if (!profile || JSON.stringify(profile) !== JSON.stringify(this.#profile) || !this.child.pid) invalid();
    const unit = observeHostedFdUnit(this.unit, this.#serviceArgv, remaining), proxy = observeHostedFdProcess(this.child.pid);
    if (unit.root !== this.#root) invalid();
    if (proxy.birth !== this.#proxyBirth || proxy.net !== observeHostedFdProcess(process.pid).net) invalid();
    if (proxy.exe !== profile.node.path && !profile.wrappers.some(pin => pin.path === proxy.exe)) invalid();
    const candidates = hostedFdGroupPids(unit.group).map(observeHostedFdProcess);
    const targetNames = this.kind === HostedFdLaunchKind.Remover ? ["hosted-dependency-remover-bootstrap.js"] :
      ["hosted-readonly-runtime-bootstrap.js", "hosted-readonly-host-launch-cli.js", "hosted-app-server-launcher.js"];
    const bootstraps = candidates.filter(p => p.exe === profile.node.path &&
      (targetNames.some(name => p.argv[1]?.endsWith("/" + name)) || this.kind !== HostedFdLaunchKind.Remover && p.argv[1] === "/runtime/bootstrap.js"));
    if (bootstraps.length !== 1 || !candidates.some(p => p.pid === unit.mainPid)) invalid();
    for (const p of candidates) {
      if (p.group !== `0::${unit.group}`) invalid();
      if (p !== bootstraps[0]) {
        if (profile.wrappers.some(pin => pin.path === p.exe)) {
          const at = this.#serviceArgv.indexOf(p.exe);
          if (at < 0 || JSON.stringify(p.argv) !== JSON.stringify(this.#serviceArgv.slice(at))) invalid();
        } else {
          if (!this.#managedJobId) invalid(); assertHostedFdManagedGuard(p, profile, this.#managedJobId, remaining);
          assertHostedFdConfinement(p, this.#serviceArgv, unit.root);
        }
      }
      let cursor = p, depth = 0;
      while (cursor.pid !== unit.mainPid) {
        const parent = candidates.find(candidate => candidate.pid === cursor.parentPid);
        if (!parent || ++depth > 8) invalid(); cursor = parent;
      }
    }
    const bootstrap = bootstraps[0]!;
    assertHostedFdBootstrap(bootstrap, profile, remaining);
    assertHostedFdConfinement(bootstrap, this.#serviceArgv, unit.root);
    const peers = collectHostedFdPeers(profile, remaining), parent = hostedFdTable(process.pid), endpoints: string[] = [];
    for (const n of this.kind === HostedFdLaunchKind.Installer ? [0] : [0, 1, 2]) {
      const b = bootstrap.descriptors.find(fd => fd.fd === n), transferred = proxy.descriptors.find(fd => fd.fd === n);
      if (!b || !transferred || socket(b) !== socket(transferred)) invalid();
      const remote = socket(b), local = knownFdCollectorPeer(peers, remote);
      if (!local || knownFdCollectorPeer(peers, local) !== remote || this.#originalParentSockets.has(local) ||
          parent.filter(fd => fd.socket && socket(fd) === local).length !== 1) invalid();
      endpoints.push(local, remote);
    }
    if (new Set(endpoints).size !== endpoints.length) invalid();
    if (this.kind === HostedFdLaunchKind.Installer && [1, 2].some(n => {
      const fd = bootstrap.descriptors.find(fd => fd.fd === n);
      return !fd || !fd.character || fd.rdev !== "259" || (fd.flags & 3) !== 1;
    })) invalid();
    const after = observeHostedFdProcess(bootstrap.pid), nextUnit = observeHostedFdUnit(this.unit, this.#serviceArgv, remaining);
    assertHostedFdConfinement(after, this.#serviceArgv, nextUnit.root);
    if (after.birth !== bootstrap.birth || after.exe !== bootstrap.exe || after.group !== bootstrap.group ||
        after.net !== bootstrap.net || JSON.stringify(after.argv) !== JSON.stringify(bootstrap.argv) ||
        after.user !== bootstrap.user || after.mount !== bootstrap.mount || after.pidNamespace !== bootstrap.pidNamespace ||
        after.uidMap !== bootstrap.uidMap || after.gidMap !== bootstrap.gidMap ||
        JSON.stringify(after.descriptors) !== JSON.stringify(bootstrap.descriptors) ||
        JSON.stringify(nextUnit) !== JSON.stringify(unit) || observeHostedFdProcess(proxy.pid).birth !== proxy.birth) invalid();
    return Object.freeze({ unit, proxy, bootstrap, endpoints: Object.freeze(endpoints) });
  }
  /** Called only by the existing authority owner's final synchronous fence. */
  release(fence: HostedActivationFence, frame: string | Buffer, end: boolean, revalidateOwner: () => void): void {
    assertHostedActivationFence(fence);
    if (this.#released || !this.#proof) invalid();
    const current = this.#collect(), old = this.#proof;
    if (current.unit.invocation !== old.unit.invocation || current.unit.group !== old.unit.group ||
        current.unit.mainPid !== old.unit.mainPid || current.unit.root !== old.unit.root ||
        current.bootstrap.birth !== old.bootstrap.birth || current.proxy.birth !== old.proxy.birth ||
        current.bootstrap.exe !== old.bootstrap.exe || current.bootstrap.group !== old.bootstrap.group ||
        current.bootstrap.net !== old.bootstrap.net || current.bootstrap.user !== old.bootstrap.user ||
        current.bootstrap.mount !== old.bootstrap.mount || current.bootstrap.pidNamespace !== old.bootstrap.pidNamespace ||
        current.bootstrap.uidMap !== old.bootstrap.uidMap || current.bootstrap.gidMap !== old.bootstrap.gidMap ||
        JSON.stringify(current.bootstrap.argv) !== JSON.stringify(old.bootstrap.argv) ||
        JSON.stringify(current.bootstrap.descriptors) !== JSON.stringify(old.bootstrap.descriptors) ||
        current.endpoints.join(",") !== old.endpoints.join(",")) invalid();
    if (Buffer.byteLength(frame) > 4 * 1024 * 1024) invalid();
    // Synchronous observations can outlast a deadline while JS timers cannot
    // run. The actual authority owner and own live setup budget are rechecked
    // after collection, inside the very same fence, immediately before enqueue.
    revalidateOwner();
    if (this.kind === HostedFdLaunchKind.Foreground) {
      assertHostedDependencyToolParentFrame(fence, this.unit, frame);
      revalidateOwner();
    }
    if (this.kind === HostedFdLaunchKind.Provider) {
      assertHostedDependencyToolRelease(this.child, fence, current.bootstrap, current.unit);
      // N3's synchronous namespace/file observations are also bounded by the
      // real owner lifetime and this same one-shot release fence.
      revalidateOwner();
    }
    if (this.kind === HostedFdLaunchKind.Remover && (!end ||
        !Buffer.from(frame).equals(Buffer.from("subscription-runtime-remover-fd-release-v1\n")))) invalid();
    this.#remaining();
    this.#input.write(frame);
    this.#released = true;
    if (end) this.#input.end();
  }

  static spawn(command: string, args: readonly string[], options: Pick<SpawnOptions, "cwd" | "detached">,
    unit: string, kind: HostedFdLaunchKind, original?: HostedFdOriginalSpawnCustody): ChildProcess {
    if (!/^subscription-runtime-(?:outer|ordinary|hosted|installer|research-provider|dependency-remove)-[a-f0-9-]{36}\.service$/.test(unit) ||
        (kind === HostedFdLaunchKind.Remover) !== /^subscription-runtime-dependency-remove-/.test(unit)) invalid();
    const profile = readHostedFdProfile();
    if (!profile || (command !== profile.node.path && command !== hostedDependencySystemdRunExecutable)) invalid();
    if (command === profile.node.path && !profile.bootstraps.some(pin => pin.path === args[0] &&
        pin.path === "/opt/subscription-runtime/managed-launcher/launch.mjs")) invalid();
    const before = hostedFdTable(process.pid);
    const child = spawnHostedFdProcess(command, args, options, unit, kind, original);
    child.once("error", () => {}); // A synchronous setup failure must not leave an unhandled spawn error.
    try {
      const launch = new HostedFdLaunch(child, unit, kind, profile, before, command, args);
      launches.set(child, launch); cleanupUnits.set(child, unit); Object.freeze(launch); return child;
    } catch (error) {
      invalidateHostedFdProcess(child);
      if (!original) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.kill("SIGTERM"); }
      // The persisted reservation remains held; killing this exact returned
      // proxy never proves the owned service/cgroup terminal or permits retry.
      throw error;
    }
  }
}

/** Only this fixed three-channel constructor can register a launch. */
export function spawnHostedFdChild(command: string, args: readonly string[], options: Pick<SpawnOptions, "cwd" | "detached">,
  unit: string, kind: HostedFdLaunchKind.Provider | HostedFdLaunchKind.Foreground | HostedFdLaunchKind.Remover): ChildProcessWithoutNullStreams;
export function spawnHostedFdChild(command: string, args: readonly string[], options: Pick<SpawnOptions, "cwd" | "detached">,
  unit: string, kind: HostedFdLaunchKind, original?: HostedFdOriginalSpawnCustody): ChildProcess;
export function spawnHostedFdChild(command: string, args: readonly string[], options: Pick<SpawnOptions, "cwd" | "detached">,
  unit: string, kind: HostedFdLaunchKind, original?: HostedFdOriginalSpawnCustody): ChildProcess {
  return HostedFdLaunch.spawn(command, args, options, unit, kind, original);
}
export function hostedFdLaunch(child: object): HostedFdLaunch {
  const launch = launches.get(child);
  if (!launch) invalid();
  if (!(child instanceof ChildProcess) || launch.child !== child) invalid();
  return launch;
}
/** Cleanup only: this lookup never authenticates execution or service drain. */
export function hostedFdCleanupUnit(child: object): string | undefined {
  return cleanupUnits.get(child);
}
export function hostedFdInvocationUnit(args: readonly string[]): string {
  const units = args.filter(arg => arg.startsWith("--unit="));
  if (units.length !== 1) invalid();
  return units[0]!.slice("--unit=".length);
}

// Fixed dispatch cannot leak a privately retained child through an override.
Object.freeze(HostedFdLaunch.prototype);
Object.freeze(HostedFdLaunch);
