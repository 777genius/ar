import { trustedOrdinaryQualificationOuterLaunch, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseFdCollectorProfile } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalOrdinaryInstallationOperation, type OrdinaryInstallationOperation } from "./hosted-ordinary-installation-owned";
import { collectBootId, collectJobs, collectProcessBirth, collectProcessCgroup, collectScopedRecursiveEmpty,
  collectUnitInvocation, collectUnitNotFound, collectUnitShow, requestScopedManagerEffect, withScopedCollectionBudget } from "./hosted-readonly-linux-collector";
import { parseScopedManagerJobs } from "./hosted-readonly-observations";

export type OrdinaryLauncherCandidate = Readonly<{ candidateArtifactPath: string; runtimeSha: string; runtimeManifestSha256: string;
  launcherSha256: string; codecSha256: string; profileSha256: string; sourceScopeSha256: string }>;
export type OrdinaryLauncherQualificationFixture = Readonly<{ rootfsPath: string; rootfsReceiptSha256: string;
  guestMachineId: string; guestHostname: string; guestEntrySha256: string; inputSha256: string; testId: string }>;
export type QualifiedOrdinaryLauncherPair = Readonly<{ readonly kind: "ordinary_launcher_pair" }>;
export const qualificationRoot = "/var/lib/subscription-runtime-host-policy/ordinary-qualification";
export const qualificationLauncher = "/opt/subscription-runtime/managed-launcher/launch.mjs";
export const qualificationCodec = "/opt/subscription-runtime/managed-launcher/host-inventory-codec.cjs";
const fixedCopiedCohort = ["managed-launcher/launch.mjs", "managed-launcher/host-inventory-codec.cjs",
  "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs", "managed-launcher/hosted-host-policy.mjs", "managed-launcher/storage-pressure-guard.mjs"] as const;
export const qualificationProfile = "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json";
export const qualificationBootUnit = "ordinary-qualification.service";
export function qualificationBootRecipe(node: string, entry: string): Buffer {
  return Buffer.from(`[Unit]\nDescription=Disposable ordinary launcher qualification\nRequires=dbus.service dbus.socket\nAfter=dbus.service dbus.socket\n[Service]\nType=exec\nExecStart=${node} ${entry} coordinator\nRestart=no\nKillMode=control-group\n[Install]\nWantedBy=multi-user.target\n`);
}
export const qualificationSha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const qualificationBytes = (data: unknown) => Buffer.from(JSON.stringify(data) + "\n");
export function qualificationHeld(): never { throw new Error("ordinary_launcher_qualification_held"); }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const pathPattern = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
export function qualificationObject(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) qualificationHeld();
  return value as Record<string, unknown>;
}
export function qualificationJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { qualificationHeld(); }
}
function canonical(path: string): void {
  if (!pathPattern.test(path) || path.length > 4096 || path.split("/").some(p => p === "." || p === "..") || realpathSync(path) !== path) qualificationHeld();
}
/** Limiting protected DATA only. Every FD is closed before descriptor checks. */
export function qualificationRead(path: string, maximum = 65536, privateLeaf = false): Buffer {
  canonical(path);
  const parents: { path: string; dev: number; ino: number }[] = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const node = lstatSync(parent);
    if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== 0 || (node.mode & 0o022) ||
        privateLeaf && parent === dirname(path) && (node.mode & 0o077)) qualificationHeld();
    parents.push({ path: parent, dev: node.dev, ino: node.ino });
    if (parent === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & (privateLeaf ? 0o077 : 0o022)) ||
        before.size < 1 || before.size > maximum) qualificationHeld();
    const bounded = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bounded.length) { const count = readSync(fd, bounded, length, bounded.length - length, length); if (!count) break; length += count; }
    const bytes = bounded.subarray(0, length), after = fstatSync(fd), current = lstatSync(path);
    if (bytes.length !== before.size || after.size !== before.size || before.dev !== current.dev || before.ino !== current.ino ||
        before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || current.mtimeMs !== after.mtimeMs) qualificationHeld();
    for (const parent of parents) {
      const node = lstatSync(parent.path);
      if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== 0 || (node.mode & 0o022) || node.dev !== parent.dev || node.ino !== parent.ino) qualificationHeld();
    }
    return bytes;
  } finally { closeSync(fd); }
}
/** Unlike idempotent diagnostic publishers, this reserves exactly one effect. */
export function qualificationCreate(path: string, bytes: Buffer): void {
  if (bytes.length > 65536) qualificationHeld();
  canonical(dirname(path)); const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o077)) qualificationHeld();
  for (let current = dirname(path);; current = dirname(current)) {
    const node = lstatSync(current);
    if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== 0 || (node.mode & 0o022)) qualificationHeld();
    if (current === "/") break;
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  if (!qualificationRead(path, 65536, true).equals(bytes)) qualificationHeld();
}
export class QualificationClock {
  private readonly issuedNs: bigint;
  constructor(readonly operation: OrdinaryInstallationOperation, private readonly issued: Readonly<{ issuedEpochMs: number; issuedMonotonicNs: string }>) {
    if (!uuid.test(operation.operationId) || !digest.test(operation.operationSha256) || !Number.isSafeInteger(operation.workEndEpochMs) ||
        !Number.isSafeInteger(operation.cleanupEndEpochMs) || operation.cleanupEndEpochMs <= operation.workEndEpochMs) qualificationHeld();
    if (!Number.isSafeInteger(issued.issuedEpochMs) || issued.issuedEpochMs < 1 || !/^[0-9]{1,20}$/.test(issued.issuedMonotonicNs)) qualificationHeld();
    this.issuedNs = BigInt(issued.issuedMonotonicNs);
    this.remaining();
  }
  remaining(cleanup = false): number {
    const end = cleanup ? this.operation.cleanupEndEpochMs : this.operation.workEndEpochMs;
    const elapsed = process.hrtime.bigint() - this.issuedNs;
    if (elapsed < 0n) qualificationHeld();
    const left = Math.floor(Math.min(end - Date.now(), end - this.issued.issuedEpochMs - Number(elapsed / 1000000n)));
    if (left < 1) qualificationHeld(); return left;
  }
  collect<T>(action: () => T, cleanup = false): T {
    const result = withScopedCollectionBudget(this.remaining(cleanup), action); this.remaining(cleanup); return result;
  }
}
type OriginalUnit = Readonly<{ unit: string; invocationId: string; mainBirth: string; executable: string;
  group: string; dev: number; ino: number; fd: number; hostId: string; bootId: string; proxyBirth: string; proxyGroup: string }>;
type TerminalUnit = Readonly<{ original: Omit<OriginalUnit, "fd">; queueBefore: string; queueAfter: string; groupDigest: string;
  unitAbsent: boolean; code: number; signal: null; stdinFinished: true; stdoutEnded: true; stderrEnded: true }>;
/** Actual returned child + original raw stdio. No public completion DTO mints it. */
export class QualificationChild {
  private readonly input: Writable | null;
  private readonly output: Readable | null;
  private readonly errorOutput: Readable | null;
  private readonly chunks: Buffer[][] = [[], []];
  private readonly sizes = [0, 0];
  private closed = false;
  private failed = false;
  private code: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private original?: OriginalUnit;
  private terminal?: TerminalUnit;
  private proxyIdentity?: Readonly<{ birth: string; group: string; executable: string }>;
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(readonly child: ChildProcess, readonly unit: string, private readonly clock: QualificationClock, private readonly record: string) {
    // Capture first. No clock, proc, manager, file read or admission can prevent
    // the actual returned child's original close/raw EOF listeners existing.
    child.once("error", () => { this.failed = true; });
    const [input, output, errorOutput] = child.stdio;
    this.input = input && "write" in input ? input as Writable : null;
    this.output = output && "read" in output ? output as Readable : null;
    this.errorOutput = errorOutput && "read" in errorOutput ? errorOutput as Readable : null;
    if (!this.input || !this.output || !this.errorOutput) this.failed = true;
    for (const stream of [this.input, this.output, this.errorOutput]) stream?.on("error", () => { this.failed = true; });
    for (const [index, stream] of [this.output, this.errorOutput].entries()) stream?.on("data", (data: Buffer) => {
      const bytes = Buffer.from(data); this.sizes[index]! += bytes.length;
      if (this.sizes[index]! > 16384) { this.failed = true; return; } this.chunks[index]!.push(bytes);
    });
    child.once("close", (code, signal) => {
      clearTimeout(this.deadline);
      this.closed = true; this.code = code; this.signal = signal;
      try { qualificationCreate(this.record + ".wait.json", qualificationBytes({ unit, code, signal, failed: this.failed,
        stdinFinished: this.input?.writableFinished ?? false, stdoutEnded: this.output?.readableEnded ?? false, stderrEnded: this.errorOutput?.readableEnded ?? false,
        stdoutBase64: this.stdout().toString("base64"), stderrBase64: this.stderr().toString("base64") })); }
      catch { this.failed = true; }
    });
  }
  admitProxy(): void {
    try {
      this.clock.remaining();
      if (!this.child.pid || this.proxyIdentity || this.closed || this.failed) qualificationHeld();
      this.proxyIdentity = Object.freeze({ birth: collectProcessBirth(String(this.child.pid)), group: collectProcessCgroup(String(this.child.pid)),
        executable: readlinkSync(`/proc/${this.child.pid}/exe`) });
      this.clock.remaining();
      this.deadline = setTimeout(() => { void this.settleFailed().catch(() => { this.failed = true; }); }, this.clock.remaining());
    } catch (error) { this.failed = true; throw error; }
  }
  stdout(): Buffer { return Buffer.concat(this.chunks[0]!); }
  stderr(): Buffer { return Buffer.concat(this.chunks[1]!); }
  endInput(): void { if (!this.input) qualificationHeld(); this.input.end(); }
  private proxy(): void {
    const original = this.proxyIdentity;
    if (!original || !this.child.pid || collectProcessBirth(String(this.child.pid)) !== original.birth ||
        collectProcessCgroup(String(this.child.pid)) !== original.group || readlinkSync(`/proc/${this.child.pid}/exe`) !== original.executable) qualificationHeld();
  }
  async bind(executable: string, argv: readonly string[], proxyExecutable: string): Promise<void> {
    const proxy = this.proxyIdentity;
    if (this.original || !proxy || proxy.executable !== proxyExecutable) qualificationHeld();
    while (!this.closed) {
      this.clock.remaining();
      let pendingFd: number | undefined;
      try {
        const original = this.clock.collect(() => {
          this.proxy(); const before = collectUnitShow(this.unit), invocationId = collectUnitInvocation(this.unit);
          const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${this.unit}`;
          if (before.Id !== this.unit || before.ControlGroup !== group || before.DropInPaths !== "" || !/^[1-9][0-9]*$/.test(before.MainPID ?? "")) qualificationHeld();
          const pid = before.MainPID!, mainBirth = collectProcessBirth(pid);
          if (collectProcessCgroup(pid) !== `0::${group}` || readlinkSync(`/proc/${pid}/exe`) !== executable ||
              !readFileSync(`/proc/${pid}/cmdline`).equals(Buffer.from(argv.join("\0") + "\0"))) qualificationHeld();
          const path = "/sys/fs/cgroup" + group, node = lstatSync(path);
          const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          pendingFd = fd;
          try {
            const opened = fstatSync(fd), after = collectUnitShow(this.unit);
            if (!node.isDirectory() || node.uid !== 0 || opened.dev !== node.dev || opened.ino !== node.ino ||
                collectUnitInvocation(this.unit) !== invocationId || after.MainPID !== pid || after.ControlGroup !== group || collectProcessBirth(pid) !== mainBirth) qualificationHeld();
            return Object.freeze({ unit: this.unit, invocationId, mainBirth, executable, group, dev: node.dev, ino: node.ino, fd,
              hostId: readFileSync("/etc/machine-id", "utf8").trim(), bootId: collectBootId(), proxyBirth: proxy.birth, proxyGroup: proxy.group });
          } catch (error) { pendingFd = undefined; closeSync(fd); throw error; }
        });
        this.original = original;
        pendingFd = undefined;
        const { fd: _fd, ...data } = original;
        qualificationCreate(this.record + ".birth.json", qualificationBytes({ ...data, spawnfile: this.child.spawnfile, spawnargs: this.child.spawnargs }));
        return;
      } catch (error) {
        // Collection's postchecks can reject after its callback returns. Until
        // this.original accepts transfer, this frame still owns the opened FD.
        if (pendingFd !== undefined) { const fd = pendingFd; pendingFd = undefined; closeSync(fd); }
        if (this.original) throw error; await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    qualificationHeld();
  }
  private association(): void {
    const original = this.original; if (!original) qualificationHeld();
    if (readFileSync("/etc/machine-id", "utf8").trim() !== original.hostId || collectBootId() !== original.bootId) qualificationHeld();
    const current = collectUnitShow(this.unit);
    if (current.Id !== this.unit || current.ControlGroup !== original.group || collectUnitInvocation(this.unit) !== original.invocationId) qualificationHeld();
    if (current.MainPID !== "0" && (collectProcessBirth(current.MainPID!) !== original.mainBirth ||
        readlinkSync(`/proc/${current.MainPID}/exe`) !== original.executable || collectProcessCgroup(current.MainPID!) !== `0::${original.group}`)) qualificationHeld();
  }
  /** Failure stops only the freshly revalidated original unit/proxy. Unknown
   * association retains HELD; finite manager RuntimeMaxSec remains in force. */
  async settleFailed(): Promise<void> {
    this.failed = true;
    try { this.clock.collect(() => { this.association(); requestScopedManagerEffect(["stop", "--no-block", "--", this.unit], this.clock.remaining(true)); }, true); }
    catch { try { this.proxy(); this.clock.remaining(true); this.child.kill("SIGTERM"); } catch { /* Unknown/expired original ownership stays retained. */ } }
    await this.wait(true);
  }
  async wait(cleanup = false): Promise<void> {
    while (!this.closed) { this.clock.remaining(cleanup); await new Promise(resolve => setTimeout(resolve, 10)); }
    this.clock.remaining(cleanup);
  }
  closeUnit(): TerminalUnit {
    if (this.terminal || !this.closed || this.failed || this.code !== 0 || this.signal !== null ||
        !this.input?.writableFinished || !this.output?.readableEnded || !this.errorOutput?.readableEnded || !this.original) qualificationHeld();
    const original = this.original;
    const terminal = this.clock.collect(() => {
      const queueBefore = collectJobs(); if (parseScopedManagerJobs(queueBefore).some(job => job.unit === this.unit)) qualificationHeld();
      const node = fstatSync(original.fd); if (node.dev !== original.dev || node.ino !== original.ino) qualificationHeld();
      const unitAbsent = collectUnitNotFound(this.unit); let groupDigest: string;
      if (unitAbsent) {
        // Only retained original zero wait/EOF plus actual queue fencing admits
        // manager unload. An existing/replacement group is never absence.
        if (readFileSync("/etc/machine-id", "utf8").trim() !== original.hostId || collectBootId() !== original.bootId) qualificationHeld();
        try { lstatSync("/sys/fs/cgroup" + original.group); qualificationHeld(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        groupDigest = qualificationSha(qualificationBytes({ absentOriginalGroup: original.group, dev: original.dev, ino: original.ino }));
      } else {
        this.association(); const current = collectUnitShow(this.unit); if (current.MainPID !== "0") qualificationHeld();
        const tree = collectScopedRecursiveEmpty(original.group, this.clock.remaining(true));
        const roots = tree.nodes.filter(node => node.path === original.group);
        if (!tree.empty || roots.length !== 1 || roots[0]!.device !== original.dev || roots[0]!.inode !== original.ino) qualificationHeld();
        groupDigest = tree.digest; this.association();
      }
      const queueAfter = collectJobs(); parseScopedManagerJobs(queueAfter);
      if (queueBefore !== queueAfter || parseScopedManagerJobs(queueAfter).some(job => job.unit === this.unit) || collectUnitNotFound(this.unit) !== unitAbsent) qualificationHeld();
      const { fd: _fd, ...data } = original;
      return Object.freeze({ original: data, queueBefore, queueAfter, groupDigest, unitAbsent, code: 0, signal: null,
        stdinFinished: true, stdoutEnded: true, stderrEnded: true } as const);
    }, true);
    qualificationCreate(this.record + ".terminal.json", qualificationBytes(terminal));
    closeSync(original.fd); this.terminal = terminal; return terminal;
  }
}
type QualifiedCell = Readonly<{ operation: OrdinaryInstallationOperation; candidate: OrdinaryLauncherCandidate;
  fixture: OrdinaryLauncherQualificationFixture; sourceBytes: Buffer; profileBytes: Buffer; evidenceSha256: string; outer: QualificationChild; clock: QualificationClock }>;
const qualified = new WeakMap<QualifiedOrdinaryLauncherPair, QualifiedCell>();
// Keep failed original handles/streams reachable even after the awaited work rejects.
const attempts = new Map<string, QualificationChild>();
/** Finite closed-source manifest: every listed file is digest-bound and every module this role loads must be listed. `read` is the
 * only injected edge; ownership/TOCTOU trust stays in `qualificationRead`. */
export function admitQualificationSourceFiles(parsed: unknown, read: (artifactRelativePath: string) => Buffer): void {
  const manifest = qualificationObject(parsed, "schemaVersion,files");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 7 || manifest.files.length > 512) qualificationHeld();
  const seen = new Set<string>();
  for (const value of manifest.files) {
    const file = qualificationObject(value, "path,sha256");
    if (typeof file.path !== "string" || !/^(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(file.path) ||
        file.path.split("/").some(p => p === "." || p === "..") || typeof file.sha256 !== "string" || !digest.test(file.sha256) || seen.has(file.path)) qualificationHeld();
    seen.add(file.path);
    if (qualificationSha(read(file.path)) !== file.sha256) qualificationHeld();
  }
  for (const required of qualificationRequiredArtifacts) if (!seen.has(required)) qualificationHeld();
}
// Current-main integration: the retention checkpoint adds history.js and host-installation-successor.js; current main's own
// hosted-blocking-output.js and managed-provider-scratch-environment.js stay required.
export const qualificationRequiredArtifacts: readonly string[] = Object.freeze(["dist/worker-codex/hosted-ordinary-installation-qualification.js", "dist/worker-codex/hosted-ordinary-installation-qualification-guest.js",
  "dist/worker-codex/hosted-installation-activation.js", "dist/worker-codex/hosted-ordinary-installation-census.js", "dist/worker-codex/hosted-ordinary-installation-history.js",
  "dist/core/host-infrastructure/host-inventory.js", "dist/core/host-infrastructure/host-installation-successor.js", "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js",
  ...["hosted-fd-launch", "hosted-fd-child", "hosted-fd-observation", "hosted-fd-prelude", "hosted-process-activation", "hosted-process-descriptors",
    "hosted-dependency-tool-plan", "hosted-blocking-output", "managed-provider-scratch-environment",
    "system-bus-infrastructure", "systemd-service-arrays"].map(name => "dist/provider-codex/app-server/adapters/" + name + ".js"),
  ...fixedCopiedCohort.map(path => "host-integration/" + path)]);
export function qualificationCandidate(candidate: OrdinaryLauncherCandidate, prefix = ""): Buffer {
  if (!/^[a-f0-9]{40}$/.test(candidate.runtimeSha) || [candidate.runtimeManifestSha256, candidate.launcherSha256,
    candidate.codecSha256, candidate.profileSha256, candidate.sourceScopeSha256].some(d => !digest.test(d))) qualificationHeld();
  canonical(prefix + candidate.candidateArtifactPath);
  const source = qualificationRead(prefix + candidate.candidateArtifactPath + "/ordinary-qualification-source.json");
  if (qualificationSha(source) !== candidate.sourceScopeSha256) qualificationHeld();
  admitQualificationSourceFiles(qualificationJson(source), (path) => qualificationRead(prefix + join(candidate.candidateArtifactPath, path), 32 * 1024 * 1024));
  for (const [name, sha] of [["launch.mjs", candidate.launcherSha256], ["host-inventory-codec.cjs", candidate.codecSha256]]) {
    if (qualificationSha(qualificationRead(prefix + join(candidate.candidateArtifactPath, "host-integration/managed-launcher", name!))) !== sha) qualificationHeld();
  }
  return source;
}
function assertCopiedHostPolicy(candidate: OrdinaryLauncherCandidate, profileBytes: Buffer, prefix = ""): void {
  const path = "/opt/subscription-runtime/managed-launcher/hosted-host-policy.mjs";
  const bytes = qualificationRead(prefix + join(candidate.candidateArtifactPath, "host-integration/managed-launcher/hosted-host-policy.mjs"));
  const profile = parseFdCollectorProfile(qualificationJson(profileBytes));
  const pins = profile.bootstraps.filter(pin => pin.path === path);
  if (pins.length !== 1 || pins[0]!.sha256 !== qualificationSha(bytes) ||
      !qualificationRead(prefix + path).equals(bytes)) qualificationHeld();
}
export function qualificationCopiedCohort(candidate: OrdinaryLauncherCandidate, prefix = ""): void {
  assertCopiedHostPolicy(candidate, qualificationRead(prefix + qualificationProfile, 65536, true), prefix);
  for (const path of fixedCopiedCohort) {
    const candidateBytes = qualificationRead(prefix + join(candidate.candidateArtifactPath, "host-integration", path));
    if (!qualificationRead(prefix + "/opt/subscription-runtime/" + path).equals(candidateBytes)) qualificationHeld();
  }
}
/** Cold read-only input admission. This does not fund, launch or mint a pair. */
export function validatePreparedOrdinaryLauncherQualification(candidate: OrdinaryLauncherCandidate, fixture: OrdinaryLauncherQualificationFixture,
  operation: Pick<OrdinaryInstallationOperation, "operationId" | "workEndEpochMs" | "cleanupEndEpochMs">): void {
  if (Date.now() >= operation.workEndEpochMs) qualificationHeld();
  if (!uuid.test(fixture.testId) || !/^[a-f0-9]{32}$/.test(fixture.guestMachineId) || fixture.guestHostname !== "ordinary-test-" + fixture.testId ||
      !fixture.rootfsPath.startsWith("/srv/workers/") || [fixture.inputSha256, fixture.guestEntrySha256, fixture.rootfsReceiptSha256].some(d => !digest.test(d))) qualificationHeld();
  canonical(fixture.rootfsPath); const directory = lstatSync(fixture.rootfsPath);
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o077) || directory.dev === lstatSync("/").dev ||
      directory.dev !== lstatSync("/srv/workers").dev) qualificationHeld();
  const receiptBytes = qualificationRead(fixture.rootfsPath + ".receipt.json", 65536, true);
  if (qualificationSha(receiptBytes) !== fixture.rootfsReceiptSha256) qualificationHeld();
  const receipt = qualificationObject(qualificationJson(receiptBytes), "schemaVersion,rootfsPath,dev,ino,testId,guestMachineId,guestHostname,inputSha256,guestEntrySha256,sourceScopeSha256,tools");
  if (receipt.schemaVersion !== 1 || receipt.rootfsPath !== fixture.rootfsPath || receipt.dev !== directory.dev || receipt.ino !== directory.ino ||
      ["testId", "guestMachineId", "guestHostname", "inputSha256", "guestEntrySha256"].some(key => receipt[key] !== fixture[key as keyof OrdinaryLauncherQualificationFixture]) ||
      receipt.sourceScopeSha256 !== candidate.sourceScopeSha256) qualificationHeld();
  const tools = qualificationObject(receipt.tools, "systemdRunSha256,systemdNspawnSha256");
  for (const [path, key] of [[trustedCustodySystemdRunExecutable, "systemdRunSha256"], ["/usr/bin/systemd-nspawn", "systemdNspawnSha256"]])
    if (qualificationSha(qualificationRead(path!, 32 * 1024 * 1024)) !== tools[key!]) qualificationHeld();
  const inputBytes = qualificationRead(fixture.rootfsPath + qualificationRoot + "/input.json", 65536, true);
  if (qualificationSha(inputBytes) !== fixture.inputSha256) qualificationHeld();
  const input = qualificationObject(qualificationJson(inputBytes), "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure");
  const clocks = qualificationObject(input.operation, "operationId,workEndEpochMs,cleanupEndEpochMs");
  if (input.schemaVersion !== 1 || Object.keys(clocks).some(key => clocks[key] !== operation[key as keyof typeof operation]) ||
      JSON.stringify(input.candidate) !== JSON.stringify(candidate)) qualificationHeld();
  const guestFixture = qualificationObject(input.fixture, "testId,guestMachineId,guestHostname,guestEntrySha256");
  if (Object.keys(guestFixture).some(key => guestFixture[key] !== fixture[key as keyof OrdinaryLauncherQualificationFixture])) qualificationHeld();
  if (typeof input.workerId !== "string" || typeof input.providerId !== "string" || !uuid.test(input.workerId) || !uuid.test(input.providerId) || new Set([fixture.testId, input.workerId, input.providerId]).size !== 3) qualificationHeld();
  qualificationCandidate(candidate, fixture.rootfsPath);
  qualificationCopiedCohort(candidate, fixture.rootfsPath);
  for (const [path, sha] of [[qualificationLauncher, candidate.launcherSha256], [qualificationCodec, candidate.codecSha256], [qualificationProfile, candidate.profileSha256]])
    if (qualificationSha(qualificationRead(fixture.rootfsPath + path!, 65536, path === qualificationProfile)) !== sha) qualificationHeld();
  if (qualificationSha(qualificationRead(fixture.rootfsPath + candidate.candidateArtifactPath + "/dist/worker-codex/hosted-ordinary-installation-qualification-guest.js")) !== fixture.guestEntrySha256 ||
      qualificationRead(fixture.rootfsPath + "/etc/machine-id").toString("utf8").trim() !== fixture.guestMachineId ||
      qualificationRead(fixture.rootfsPath + "/etc/hostname").toString("utf8").trim() !== fixture.guestHostname) qualificationHeld();
  const profile = parseFdCollectorProfile(qualificationJson(qualificationRead(fixture.rootfsPath + qualificationProfile, 65536, true)));
  const guestEntry = candidate.candidateArtifactPath + "/dist/worker-codex/hosted-ordinary-installation-qualification-guest.js";
  if (!qualificationRead(fixture.rootfsPath + "/etc/systemd/system/" + qualificationBootUnit).equals(qualificationBootRecipe(profile.node.path, guestEntry))) qualificationHeld();
  const link = fixture.rootfsPath + "/etc/systemd/system/multi-user.target.wants/" + qualificationBootUnit;
  const enabled = lstatSync(link);
  if (!enabled.isSymbolicLink() || enabled.uid !== 0 || readlinkSync(link) !== "/etc/systemd/system/" + qualificationBootUnit) qualificationHeld();
  try { lstatSync("/run/systemd/machines/" + fixture.guestHostname); qualificationHeld(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // register=no images cannot be detected solely through the machine registry.
  // Refuse any existing process whose actual root is this same prepared image.
  const processes = readdirSync("/proc").filter(name => /^[1-9][0-9]*$/.test(name));
  if (processes.length > 65536) qualificationHeld();
  for (const pid of processes) {
    if (Date.now() >= operation.workEndEpochMs) qualificationHeld();
    try { const root = statSync(`/proc/${pid}/root`); if (root.dev === directory.dev && root.ino === directory.ino) qualificationHeld(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}
export async function runOrdinaryLauncherPairQualification(operation: OrdinaryInstallationOperation, candidateInput: OrdinaryLauncherCandidate,
  fixtureInput: OrdinaryLauncherQualificationFixture): Promise<QualifiedOrdinaryLauncherPair> {
  assertHostedActivationOperator(); assertOriginalOrdinaryInstallationOperation(operation, true);
  const root = `/var/lib/subscription-runtime-host-policy/ordinary-installations/${operation.operationId}`;
  const fundedBytes = qualificationRead(root + "/operation.json", 65536, true);
  if (qualificationSha(fundedBytes) !== operation.operationSha256) qualificationHeld();
  const funded = qualificationJson(fundedBytes) as Record<string, unknown>;
  const clock = new QualificationClock(operation, { issuedEpochMs: funded.issuedEpochMs as number, issuedMonotonicNs: funded.issuedMonotonicNs as string });
  const candidate = Object.freeze({ ...candidateInput }), fixture = Object.freeze({ ...fixtureInput });
  const sourceBytes = qualificationCandidate(candidate);
  const profileBytes = qualificationRead(`/var/lib/subscription-runtime-host-policy/ordinary-installations/${operation.operationId}.profile.json`, 65536, true);
  if (qualificationSha(profileBytes) !== candidate.profileSha256) qualificationHeld(); parseFdCollectorProfile(qualificationJson(profileBytes));
  assertCopiedHostPolicy(candidate, profileBytes);
  validatePreparedOrdinaryLauncherQualification(candidate, fixture, operation); clock.remaining();
  if (readdirSync(fixture.rootfsPath + qualificationRoot + "/output").length) qualificationHeld();
  qualificationCreate(root + "/qualification-intent.json", qualificationBytes({ operationSha256: operation.operationSha256, candidate, fixture }));
  // The immutable prepared input omits the eventual funded SHA, avoiding a hash
  // cycle. Only this actual issuer copies its original once-funded bytes here.
  assertOriginalOrdinaryInstallationOperation(operation, true); clock.remaining();
  assertCopiedHostPolicy(candidate, profileBytes);
  qualificationCreate(fixture.rootfsPath + qualificationRoot + "/funded-operation.json", fundedBytes);
  const unit = `subscription-runtime-ordinary-${fixture.testId}.service`;
  assertOriginalOrdinaryInstallationOperation(operation, true); clock.remaining();
  clock.collect(() => { if (!collectUnitNotFound(unit) || parseScopedManagerJobs(collectJobs()).some(job => job.unit === unit)) qualificationHeld(); });
  let outer: QualificationChild | undefined;
  try {
    const launch = trustedOrdinaryQualificationOuterLaunch(fixture.testId, fixture.rootfsPath, clock.remaining(),
      Math.min(30_000, clock.operation.cleanupEndEpochMs - clock.operation.workEndEpochMs)); clock.remaining();
    const payload = launch.args.slice(launch.args.indexOf("--") + 1);
    assertCopiedHostPolicy(candidate, profileBytes); clock.remaining();
    const child = spawn(launch.command, launch.args,
      { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    outer = new QualificationChild(child, unit, clock, root + "/qualification-outer"); attempts.set(operation.operationId, outer);
    outer.admitProxy(); outer.endInput();
    await outer.bind(payload[0]!, payload, trustedCustodySystemdRunExecutable); await outer.wait(); const terminal = outer.closeUnit();
    clock.remaining(); assertOriginalOrdinaryInstallationOperation(operation, true); validatePreparedOrdinaryLauncherQualification(candidate, fixture, operation);
    assertCopiedHostPolicy(candidate, profileBytes);
    const sourceAfter = qualificationCandidate(candidate);
    if (!sourceAfter.equals(sourceBytes) || !qualificationRead(`/var/lib/subscription-runtime-host-policy/ordinary-installations/${operation.operationId}.profile.json`, 65536, true).equals(profileBytes)) qualificationHeld();
    const receiptBytes = qualificationRead(fixture.rootfsPath + qualificationRoot + "/output/coordinator.json", 65536, true);
    const receipt = qualificationObject(qualificationJson(receiptBytes), "schemaVersion,operationSha256,inputSha256,sourceScopeSha256,launcherSha256,codecSha256,profileSha256,worker,providerReceiptSha256");
    if (receipt.schemaVersion !== 1 || receipt.operationSha256 !== operation.operationSha256 || receipt.inputSha256 !== fixture.inputSha256 ||
        ["sourceScopeSha256", "launcherSha256", "codecSha256", "profileSha256"].some(key => receipt[key] !== candidate[key as keyof OrdinaryLauncherCandidate]) ||
        !receipt.worker || typeof receipt.providerReceiptSha256 !== "string" || !digest.test(receipt.providerReceiptSha256)) qualificationHeld();
    const providerBytes = qualificationRead(fixture.rootfsPath + qualificationRoot + "/output/provider.json", 65536, true);
    if (qualificationSha(providerBytes) !== receipt.providerReceiptSha256) qualificationHeld();
    const evidence = qualificationBytes({ operationSha256: operation.operationSha256, candidate, fixture, terminal,
      coordinatorSha256: qualificationSha(receiptBytes), providerSha256: qualificationSha(providerBytes) });
    qualificationCreate(root + "/qualification.json", evidence); clock.remaining(); clock.remaining(true);
    const pair = Object.freeze({ kind: "ordinary_launcher_pair" } as const);
    qualified.set(pair, Object.freeze({ operation, candidate, fixture, sourceBytes, profileBytes, evidenceSha256: qualificationSha(evidence), outer, clock }));
    return pair;
  } catch (error) {
    try { qualificationCreate(root + "/qualification-held.json", qualificationBytes({ operationSha256: operation.operationSha256, reason: "UNKNOWN_OR_FAILED_ORIGINAL_TEST" })); } catch { /* Preserve original create-only evidence. */ }
    try { await outer?.settleFailed(); } catch { /* Retained original wait can still finish; no replacement birth. */ }
    throw error;
  }
}
export function assertQualifiedPairForPublication(pair: QualifiedOrdinaryLauncherPair, operation: OrdinaryInstallationOperation): Readonly<{
  candidateArtifactPath: string; launcherSha256: string; codecSha256: string; profileSha256: string; sourceScopeSha256: string; evidenceSha256: string }> {
  assertOriginalOrdinaryInstallationOperation(operation, true);
  const cell = qualified.get(pair); if (!cell || cell.operation !== operation) qualificationHeld();
  cell.clock.remaining();
  if (!qualificationCandidate(cell.candidate).equals(cell.sourceBytes) ||
      !qualificationRead(`/var/lib/subscription-runtime-host-policy/ordinary-installations/${operation.operationId}.profile.json`, 65536, true).equals(cell.profileBytes)) qualificationHeld();
  assertCopiedHostPolicy(cell.candidate, cell.profileBytes);
  cell.clock.remaining(); assertOriginalOrdinaryInstallationOperation(operation, true);
  const { candidateArtifactPath, launcherSha256, codecSha256, profileSha256, sourceScopeSha256 } = cell.candidate;
  return Object.freeze({ candidateArtifactPath, launcherSha256, codecSha256, profileSha256, sourceScopeSha256, evidenceSha256: cell.evidenceSha256 });
}
