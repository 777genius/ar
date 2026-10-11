import { verifyOriginalOrdinarySeedPublication } from "./hosted-ordinary-seed-publication";
import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { trustedOrdinaryGuestSeedReaderLaunch, trustedOrdinaryGuestNetworkLaunch, trustedOrdinaryQualificationOuterLaunch, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { constants, closeSync, fstatSync, lstatSync, readdirSync, openSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { materializeCodexEffectiveSeed } from "./codex-effective-seed";
import { assertOriginalOrdinaryInstallationOperation, type OrdinaryInstallationOperation } from "./hosted-ordinary-installation-owned";
import { collectProcessBirth, collectProcessCgroup, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import { qualificationBytes, qualificationCreate, qualificationHeld, qualificationJson, qualificationObject, qualificationRead, qualificationRoot, qualificationSha, QualificationChild, QualificationClock, qualificationCandidate, qualificationCopiedCohort, qualificationBootRecipe, qualificationProfile, type OrdinaryLauncherCandidate, type OrdinaryLauncherQualificationFixture } from "./hosted-ordinary-installation-qualification";

type OriginalOrdinaryGuestBroker = Readonly<{ operationId: string }>;
type SeedHome = Awaited<ReturnType<typeof materializeCodexEffectiveSeed>>;
type Pin = Readonly<{ dev: number; ino: number; mode: number; uid: number; gid: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number }>;
type Namespace = Readonly<{ name: "user" | "mnt" | "pid" | "net"; fd: number; dev: number; ino: number }>;
type Guest = Readonly<{ unit: string; invocationId: string; nspawnPid: string; nspawnBirth: string; leaderPid: string; leaderBirth: string; group: string; root: Pin; rootFd: number; bootId: string; namespaces: readonly Namespace[] }>;
enum BrokerState { Materializing = "materializing", Bound = "bound", Captured = "captured", Published = "published", Closed = "closed", Held = "held" }
type Cell = { operation: OrdinaryInstallationOperation; inputPath: string; inputBytes: Buffer; sourcePath: string; sourcePin: Pin;
  rootfsPath: string; rootPin: Pin; seed?: SeedHome; guest?: Guest; next?: string; outer?: QualificationChild; reader?: PrivateChild; network?: PrivateChild; state: BrokerState };
// Neither a protected reference nor a copied seed/FD/guest DTO enters this map.
const uses = new WeakMap<OriginalOrdinaryGuestBroker, Cell>();
const byOperation = new Map<OrdinaryInstallationOperation, OriginalOrdinaryGuestBroker>();
const guestSeed = qualificationRoot + "/broker/account-test/auth.json";
function same(a: Pin, b: Pin): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function privateSource(path: string): Pin {
  if (path.length > 4096 || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*auth\.json$/.test(path) || realpathSync(path) !== path) qualificationHeld();
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const node = lstatSync(parent);
    if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== 0 || node.mode & 0o022) qualificationHeld();
    if (parent === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const node = fstatSync(fd), named = lstatSync(path);
    if (!node.isFile() || node.uid !== 0 || node.gid !== 0 || node.nlink !== 1 || node.mode & 0o077 || node.size < 1 || node.size > 1024 * 1024 || !same(node, named)) qualificationHeld();
    return Object.freeze({ dev: node.dev, ino: node.ino, mode: node.mode, uid: node.uid, gid: node.gid, nlink: node.nlink,
      size: node.size, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs });
  } finally { closeSync(fd); }
}
function cellOf(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation, work: boolean): Cell {
  const cell = uses.get(use);
  if (!cell || cell.operation !== operation || byOperation.get(operation) !== use || cell.state === BrokerState.Closed || cell.state === BrokerState.Held) qualificationHeld();
  assertHostedActivationOperator(); assertOriginalOrdinaryInstallationOperation(operation, work);
  if (!qualificationRead(cell.inputPath, 65536, true).equals(cell.inputBytes) || !same(cell.sourcePin, privateSource(cell.sourcePath))) qualificationHeld();
  const root = lstatSync(cell.rootfsPath);
  // Directory content/mtime changes are expected from the genuine guest; its
  // actual root identity, ownership and private mode must remain the original.
  if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== cell.rootPin.dev || root.ino !== cell.rootPin.ino || root.uid !== cell.rootPin.uid || root.gid !== cell.rootPin.gid || root.mode !== cell.rootPin.mode) qualificationHeld();
  return cell;
}
/** Fixed original qualification owner only. Selection is read from its exact
 * protected input, never accepted as seed/home/namespace/callback arguments. */
async function openOriginalOrdinaryGuestBroker(operation: OrdinaryInstallationOperation, rootfsPath: string, inputSha256: string): Promise<OriginalOrdinaryGuestBroker> {
  assertHostedActivationOperator(); assertOriginalOrdinaryInstallationOperation(operation, true);
  if (byOperation.has(operation)) qualificationHeld();
  const inputPath = join("/var/lib/subscription-runtime-host-policy/ordinary-installations", operation.operationId + ".usable-broker.json");
  const bytes = qualificationRead(inputPath, 65536, true);
  const input = qualificationObject(qualificationJson(bytes), "schemaVersion,operationSha256,rootfsPath,guestInputSha256,seedSourcePath,scratchPath");
  if (input.schemaVersion !== 1 || input.operationSha256 !== operation.operationSha256 || input.rootfsPath !== rootfsPath || input.guestInputSha256 !== inputSha256 ||
      typeof input.seedSourcePath !== "string" || typeof input.scratchPath !== "string" || input.scratchPath !== process.env.TMPDIR ||
      !input.scratchPath.startsWith("/srv/workers/") || realpathSync(input.scratchPath) !== input.scratchPath || realpathSync(rootfsPath) !== rootfsPath) qualificationHeld();
  const scratch = lstatSync(input.scratchPath), root = lstatSync(rootfsPath);
  if (!scratch.isDirectory() || scratch.isSymbolicLink() || scratch.uid !== 0 || scratch.mode & 0o077 ||
      !root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.mode & 0o077 || root.dev !== scratch.dev || root.dev !== lstatSync("/srv/workers").dev) qualificationHeld();
  const sourcePin = privateSource(input.seedSourcePath), use = Object.freeze({ operationId: operation.operationId });
  const cell: Cell = { operation, inputPath, inputBytes: Buffer.from(bytes), sourcePath: input.seedSourcePath, sourcePin, rootfsPath, rootPin: root, state: BrokerState.Materializing };
  uses.set(use, cell); byOperation.set(operation, use); // Once-only ownership precedes the first fallible await.
  try {
    cell.seed = await materializeCodexEffectiveSeed(cell.sourcePath);
    cellOf(use, operation, true);
    if (dirname(cell.seed.home) !== input.scratchPath || realpathSync(cell.seed.home) !== cell.seed.home) qualificationHeld();
    privateSource(cell.seed.authJsonPath);
    return use;
  } catch (error) { cell.state = BrokerState.Held; throw error; } // Exact original home/handle remains reachable.
}
/** Fixed nspawn recipe data. It is not a guest or runtime capability. The
 * genuine owner retains the handle and validates it again after OS submission. */
function originalOrdinaryGuestSeedBind(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): string {
  const cell = cellOf(use, operation, true);
  if (cell.state !== BrokerState.Materializing || !cell.seed) qualificationHeld();
  privateSource(cell.seed.authJsonPath);
  const parent = lstatSync(cell.rootfsPath + dirname(guestSeed)), leaf = lstatSync(cell.rootfsPath + guestSeed);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o077 ||
      !leaf.isFile() || leaf.isSymbolicLink() || leaf.uid !== 0 || leaf.nlink !== 1 || leaf.mode & 0o077 || leaf.size !== 0) qualificationHeld();
  return "--bind-ro=" + cell.seed.authJsonPath + ":" + guestSeed;
}
/** Called only after original QualificationChild.bind, using its exact owned
 * service name. Kernel leader/root/namespace are retained before readiness. */
function bindOriginalOrdinaryGuestBroker(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): void {
  const cell = cellOf(use, operation, true);
  if (cell.state !== BrokerState.Materializing || cell.guest || !cell.seed || !cell.outer) qualificationHeld();
  cell.outer.assertLiveOriginal();
  const unit = cell.outer.unit;
  const input = qualificationJson(qualificationRead(cell.rootfsPath + qualificationRoot + "/usable-input.json", 65536, true)) as { fixture?: { testId?: unknown } };
  if (typeof input.fixture?.testId !== "string" || unit !== "subscription-runtime-ordinary-" + input.fixture.testId + ".service") qualificationHeld();
  const before = collectUnitShow(unit), invocationId = collectUnitInvocation(unit), pid = before.MainPID;
  const group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit;
  if (before.Id !== unit || before.ControlGroup !== group || before.DropInPaths !== "" || !pid || !/^[1-9][0-9]*$/.test(pid) ||
      readlinkSync(`/proc/${pid}/exe`) !== "/usr/bin/systemd-nspawn" || collectProcessCgroup(pid) !== "0::" + group) qualificationHeld();
  const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
  if (!argv.includes("--directory=" + cell.rootfsPath) || !argv.includes("--private-network") || !argv.includes("--settings=no") || !argv.includes(originalOrdinaryGuestSeedBind(use, operation))) qualificationHeld();
  const nspawnBirth = collectProcessBirth(pid), children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
  if (children.length > 128) qualificationHeld();
  const leaders = children.filter(child => {
    const root = statSync(`/proc/${child}/root`), status = readFileSync(`/proc/${child}/status`, "utf8");
    return root.dev === cell.rootPin.dev && root.ino === cell.rootPin.ino && /^NSpid:\s+.*\s1$/m.test(status) && readlinkSync(`/proc/${child}/exe`) === "/usr/lib/systemd/systemd";
  });
  if (leaders.length !== 1) qualificationHeld();
  const leaderPid = leaders[0]!, leaderBirth = collectProcessBirth(leaderPid), namespaces: Namespace[] = [];
  let rootFd: number | undefined;
  try {
    for (const name of ["user", "mnt", "pid", "net"] as const) {
      const fd = openSync(`/proc/${leaderPid}/ns/${name}`, constants.O_RDONLY), node = fstatSync(fd);
      namespaces.push(Object.freeze({ name, fd, dev: node.dev, ino: node.ino }));
      const initial = statSync(`/proc/1/ns/${name}`);
      if (name === "user" ? node.dev !== initial.dev || node.ino !== initial.ino : node.dev === initial.dev && node.ino === initial.ino) qualificationHeld();
    }
    if (collectUnitInvocation(unit) !== invocationId || collectProcessBirth(pid) !== nspawnBirth || collectProcessBirth(leaderPid) !== leaderBirth) qualificationHeld();
    rootFd = openSync(`/proc/${leaderPid}/root`, constants.O_RDONLY | constants.O_DIRECTORY);
    const bootId = readFileSync(`/proc/self/fd/${rootFd}/proc/sys/kernel/random/boot_id`, "utf8").trim();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) qualificationHeld();
    cell.guest = Object.freeze({ unit, invocationId, nspawnPid: pid, nspawnBirth, leaderPid, leaderBirth, group, root: cell.rootPin, rootFd, bootId, namespaces: Object.freeze(namespaces) });
    cell.state = BrokerState.Bound;
    assertLiveOriginalOrdinaryGuestBroker(use, operation);
  } catch (error) {
    if (!cell.guest) {
      if (rootFd !== undefined) closeSync(rootFd);
      for (const node of namespaces) closeSync(node.fd);
    }
    cell.state = BrokerState.Held; throw error;
  }
}
function assertLiveOriginalOrdinaryGuestBroker(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): void {
  const cell = cellOf(use, operation, true), guest = cell.guest;
  cell.outer?.assertLiveOriginal();
  if (!guest || ![BrokerState.Bound, BrokerState.Captured].includes(cell.state)) qualificationHeld();
  const current = collectUnitShow(guest.unit), root = statSync(`/proc/${guest.leaderPid}/root`), retainedRoot = fstatSync(guest.rootFd);
  if (retainedRoot.dev !== guest.root.dev || retainedRoot.ino !== guest.root.ino ||
      readFileSync(`/proc/self/fd/${guest.rootFd}/proc/sys/kernel/random/boot_id`, "utf8").trim() !== guest.bootId) qualificationHeld();
  if (collectUnitInvocation(guest.unit) !== guest.invocationId || current.MainPID !== guest.nspawnPid || current.ControlGroup !== guest.group ||
      collectProcessBirth(guest.nspawnPid) !== guest.nspawnBirth || collectProcessBirth(guest.leaderPid) !== guest.leaderBirth || root.dev !== guest.root.dev || root.ino !== guest.root.ino ||
      !collectProcessCgroup(guest.leaderPid).startsWith("0::" + guest.group + "/") && collectProcessCgroup(guest.leaderPid) !== "0::" + guest.group) qualificationHeld();
  for (const node of guest.namespaces) {
    const held = fstatSync(node.fd), actual = statSync(`/proc/${guest.leaderPid}/ns/${node.name}`);
    if (held.dev !== node.dev || held.ino !== node.ino || actual.dev !== node.dev || actual.ino !== node.ino) qualificationHeld();
  }
}
/** Public gate correlation is emitted only by this same live original owner;
 * the guest must still issue its own creator/reservation, never import ours. */
function publishOriginalOrdinaryGuestReady(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): void {
  assertLiveOriginalOrdinaryGuestBroker(use, operation);
  const cell = cellOf(use, operation, true), guest = cell.guest!;
  qualificationCreate(cell.rootfsPath + qualificationRoot + "/usable-ready.json", qualificationBytes({ schemaVersion: 1,
    operationSha256: operation.operationSha256, guestInputSha256: qualificationSha(qualificationRead(cell.rootfsPath + qualificationRoot + "/usable-input.json", 65536, true)),
    unit: guest.unit, invocationId: guest.invocationId, namespaces: guest.namespaces.map(({ name, dev, ino }) => ({ name, dev, ino })), bootId: guest.bootId }));
  assertLiveOriginalOrdinaryGuestBroker(use, operation);
}
/** Official journal reader only. Raw credential or journal files are never
 * inspected by this adapter; payload stays solely in this original private use. */
async function captureOriginalOrdinaryGuestRefresh(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): Promise<void> {
  assertLiveOriginalOrdinaryGuestBroker(use, operation);
  const cell = cellOf(use, operation, true);
  if (cell.state !== BrokerState.Bound || !cell.seed || cell.reader) qualificationHeld();
  const guest = cell.guest!;
  const input = qualificationJson(qualificationRead(cell.rootfsPath + qualificationRoot + "/usable-input.json", 65536, true)) as
    { candidate: { candidateArtifactPath: string } };
  const launch = trustedOrdinaryGuestSeedReaderLaunch(process.execPath, input.candidate.candidateArtifactPath);
  const namespace = (name: Namespace["name"]) => guest.namespaces.find(row => row.name === name)!.fd;
  // Capture this exact returned child before any fallible admission/await.
  cell.reader = new PrivateChild(spawn(launch.command, launch.args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "ignore", "pipe", guest.rootFd, namespace("mnt"), namespace("pid"), namespace("net")] }), operation, true);
  try {
    cell.reader.admit(launch.command);
    await cell.reader.wait(false);
    assertLiveOriginalOrdinaryGuestBroker(use, operation);
    const bytes = cell.reader.takeSecret();
    try {
      const result = qualificationObject(qualificationJson(bytes), "source,bytes");
      if (typeof result.source !== "string" || typeof result.bytes !== "string" || result.source !== cell.seed.seed.bytes ||
          result.bytes.length < 1 || Buffer.byteLength(result.bytes) > 1024 * 1024) qualificationHeld();
      cell.next = result.bytes; cell.state = BrokerState.Captured;
    } finally { bytes.fill(0); }
  } catch (error) { cell.state = BrokerState.Held; throw error; }
}
/** Fixed producer calls only after ORIGINAL wait/both EOF, namespace/egress
 * children, queue, cgroup and descriptor drain. Closed state is not imported. */
async function finishOriginalOrdinaryGuestBroker(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): Promise<void> {
  const cell = cellOf(use, operation, false);
  if (cell.state !== BrokerState.Captured || !cell.seed || cell.next === undefined || !cell.guest || !cell.outer || !cell.network || !cell.reader) qualificationHeld();
  try {
    // Original close/raw EOF comes before all manager/namespace absence checks.
    await cell.outer.wait(true); cell.outer.closeUnit();
    await cell.network.stopNetwork();
    cell.reader.assertClosed();
    cellOf(use, operation, false);
    // A remaining leader, nspawn, manager job or cgroup forbids publication.
    const { collectUnitNotFound, collectJobs } = await import("./hosted-readonly-linux-collector");
    cellOf(use, operation, false);
    if (!collectUnitNotFound(cell.guest.unit) && collectUnitShow(cell.guest.unit).MainPID !== "0" || collectJobs().includes(cell.guest.unit)) qualificationHeld();
    for (const pid of [cell.guest.nspawnPid, cell.guest.leaderPid]) {
      try { lstatSync(`/proc/${pid}`); qualificationHeld(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { lstatSync("/sys/fs/cgroup" + cell.guest.group); qualificationHeld(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await verifyOriginalOrdinarySeedPublication(cell.seed.seed, cell.next);
    cellOf(use, operation, false);
    cell.state = BrokerState.Published;
    await cell.seed.finish(false); // Generic finish(true) ignores CAS false; never use it here.
    cellOf(use, operation, false);
    closeSync(cell.guest.rootFd);
    for (const node of cell.guest.namespaces) closeSync(node.fd);
    delete cell.next; delete cell.seed; cell.state = BrokerState.Closed;
  } catch (error) { cell.state = BrokerState.Held; throw error; }
}

/** Private captured process lifetime. It never publishes secret IPC bytes or
 * raw process output. Failed/unknown children remain in the original Cell. */
class PrivateChild {
  private readonly output: Duplex;
  private readonly exit: Duplex | undefined;
  private readonly chunks: Buffer[] = [];
  private readonly completion: Promise<void>;
  private failed = false;
  private closed = false;
  private ended = false;
  private size = 0;
  private code: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private birth: string | undefined;
  private group: string | undefined;
  private executable: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private consumed = false;
  private stopping = false;
  constructor(private readonly child: ChildProcess, private readonly operation: OrdinaryInstallationOperation, private readonly secret: boolean) {
    const stream = child.stdio[3];
    this.output = stream as Duplex;
    this.exit = secret ? undefined : child.stdio[4] as Duplex;
    child.once("error", () => { this.failed = true; });
    if (!stream || !("read" in stream)) this.failed = true;
    this.output?.on("error", () => { this.failed = true; });
    this.exit?.on("error", () => { this.failed = true; });
    this.output?.on("data", (chunk: Buffer) => {
      this.size += chunk.length;
      if (this.size > (secret ? 2 * 1024 * 1024 : 1)) { this.failed = true; chunk.fill(0); return; }
      this.chunks.push(Buffer.from(chunk));
    });
    this.output?.once("end", () => { this.ended = true; });
    this.completion = new Promise(resolve => child.once("close", (code, signal) => {
      clearTimeout(this.timer); this.closed = true; this.code = code; this.signal = signal; resolve();
    }));
  }
  admit(executable: string): void {
    assertOriginalOrdinaryInstallationOperation(this.operation, true);
    if (!this.child.pid || this.birth || this.closed || this.failed) qualificationHeld();
    const pid = String(this.child.pid), parent = collectProcessBirth(String(process.pid));
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[1] !== String(process.pid) ||
        readlinkSync(`/proc/${pid}/exe`) !== executable || collectProcessBirth(String(process.pid)) !== parent) qualificationHeld();
    this.birth = collectProcessBirth(pid); this.group = collectProcessCgroup(pid); this.executable = executable;
    if (this.group !== collectProcessCgroup(String(process.pid))) qualificationHeld();
    this.timer = setTimeout(() => {
      this.failed = true;
      try { assertOriginalOrdinaryInstallationOperation(this.operation, false); this.original();
        if (this.exit) this.exit.end("1"); else this.child.kill("SIGTERM");
      } catch { /* No current original identity means no cancellation effect. */ }
    }, Math.max(1, this.operation.workEndEpochMs - Date.now()));
  }
  private original(): void {
    if (!this.child.pid || !this.birth || !this.group || !this.executable || collectProcessBirth(String(this.child.pid)) !== this.birth ||
        collectProcessCgroup(String(this.child.pid)) !== this.group || readlinkSync(`/proc/${this.child.pid}/exe`) !== this.executable) qualificationHeld();
  }
  async wait(cleanup: boolean): Promise<void> {
    const left = Math.min((cleanup ? this.operation.cleanupEndEpochMs : this.operation.workEndEpochMs) - Date.now(), 30_000);
    if (left < 1) qualificationHeld();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ordinary_launcher_qualification_held")), left); })]);
      assertOriginalOrdinaryInstallationOperation(this.operation, !cleanup); this.assertClosed();
    } finally { clearTimeout(timer); }
  }
  assertClosed(): void {
    if (!this.closed || this.failed || !this.ended || this.code !== 0 || this.signal !== null || this.exit && !this.exit.writableFinished) qualificationHeld();
  }
  takeSecret(): Buffer {
    this.assertClosed();
    if (!this.secret || this.consumed) qualificationHeld(); this.consumed = true;
    const bytes = Buffer.concat(this.chunks); for (const chunk of this.chunks) chunk.fill(0); this.chunks.length = 0; return bytes;
  }
  async ready(): Promise<void> {
    if (this.secret) qualificationHeld();
    while (!this.ended) {
      assertOriginalOrdinaryInstallationOperation(this.operation, true); this.original();
      if (this.failed || this.closed || this.size > 1) qualificationHeld();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.original();
    if (this.failed || this.size !== 1 || this.chunks.length !== 1 || !this.chunks[0]!.equals(Buffer.from("1"))) qualificationHeld();
  }
  async stopNetwork(): Promise<void> {
    if (this.secret || this.stopping || !this.exit) qualificationHeld(); this.original(); this.stopping = true;
    this.exit.end("1"); await this.wait(true);
  }
}
async function attachOriginalOrdinaryGuestNetwork(use: OriginalOrdinaryGuestBroker, operation: OrdinaryInstallationOperation): Promise<void> {
  assertLiveOriginalOrdinaryGuestBroker(use, operation);
  const cell = cellOf(use, operation, true);
  if (cell.network) qualificationHeld();
  const net = cell.guest!.namespaces.find(row => row.name === "net")!, launch = trustedOrdinaryGuestNetworkLaunch();
  cell.network = new PrivateChild(spawn(launch.command, launch.args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", net.fd] }), operation, false);
  try { cell.network.admit(launch.command); await cell.network.ready(); assertLiveOriginalOrdinaryGuestBroker(use, operation); }
  catch (error) { cell.state = BrokerState.Held; throw error; }
}

/** Sole fixed original-owner entry. The protected selection supplies data;
 * actual operation membership, original spawn/wait and kernel FDs supply the
 * retained authority. Nothing accepts a seed handle, child, namespace or FD. */
export async function runOriginalUsableGuestQualification(operation: OrdinaryInstallationOperation): Promise<void> {
  assertHostedActivationOperator(); assertOriginalOrdinaryInstallationOperation(operation, true);
  const root = join("/var/lib/subscription-runtime-host-policy/ordinary-installations", operation.operationId);
  const selectionBytes = qualificationRead(root + ".usable-fixture.json", 65536, true);
  const selection = qualificationObject(qualificationJson(selectionBytes), "schemaVersion,candidate,fixture");
  if (selection.schemaVersion !== 1) qualificationHeld();
  const candidate = qualificationObject(selection.candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256") as unknown as OrdinaryLauncherCandidate;
  const fixture = qualificationObject(selection.fixture, "rootfsPath,rootfsReceiptSha256,guestMachineId,guestHostname,guestEntrySha256,inputSha256,testId") as unknown as OrdinaryLauncherQualificationFixture;
  const fundedBytes = qualificationRead(root + "/operation.json", 65536, true);
  if (qualificationSha(fundedBytes) !== operation.operationSha256) qualificationHeld();
  const funded = qualificationJson(fundedBytes) as { issuedEpochMs: number; issuedMonotonicNs: string; runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string };
  if (candidate.candidateArtifactPath !== funded.runtimeDirectory || candidate.runtimeSha !== funded.runtimeSha || candidate.runtimeManifestSha256 !== funded.runtimeManifestSha256) qualificationHeld();
  const clock = new QualificationClock(operation, funded);
  const sourceBytes = qualificationCandidate(candidate);
  const source = qualificationJson(sourceBytes) as { files: { path: string; sha256: string }[] };
  for (const name of ["hosted-ordinary-installation-broker-use", "hosted-ordinary-installation-seed-reader", "hosted-ordinary-installation-usable-guest",
    "hosted-ordinary-usable-guest-funding", "hosted-ordinary-seed-publication", "trusted-custody-systemd-launch", "hosted-ordinary-installation-owned",
    "hosted-ordinary-installation-bootstrap", "hosted-readonly-foreground", "hosted-installation-activation", "codex-effective-seed",
    "file-backend-codex-seed-writeback", "codex-seed-refresh-journal"]) if (source.files.filter(pin => pin.path ===
    "dist/worker-codex/" + name + ".js").length !== 1) qualificationHeld();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(fixture.testId) || !/^[a-f0-9]{32}$/.test(fixture.guestMachineId) ||
      fixture.guestHostname !== "ordinary-test-" + fixture.testId || !fixture.rootfsPath.startsWith("/srv/workers/") || realpathSync(fixture.rootfsPath) !== fixture.rootfsPath ||
      [fixture.rootfsReceiptSha256,fixture.inputSha256,fixture.guestEntrySha256].some(sha => !/^[a-f0-9]{64}$/.test(sha))) qualificationHeld();
  const directory = lstatSync(fixture.rootfsPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || directory.mode & 0o077 ||
      directory.dev !== lstatSync("/srv/workers").dev || directory.dev === lstatSync("/").dev) qualificationHeld();
  const receiptBytes = qualificationRead(fixture.rootfsPath + ".receipt.json", 65536, true);
  if (qualificationSha(receiptBytes) !== fixture.rootfsReceiptSha256) qualificationHeld();
  const receipt = qualificationObject(qualificationJson(receiptBytes), "schemaVersion,rootfsPath,dev,ino,testId,guestMachineId,guestHostname,inputSha256,guestEntrySha256,sourceScopeSha256,tools");
  if (receipt.schemaVersion !== 1 || receipt.dev !== directory.dev || receipt.ino !== directory.ino || receipt.sourceScopeSha256 !== candidate.sourceScopeSha256 ||
      ["rootfsPath","testId","guestMachineId","guestHostname","inputSha256","guestEntrySha256"].some(key => receipt[key] !== fixture[key as keyof typeof fixture])) qualificationHeld();
  const tools = qualificationObject(receipt.tools, "systemdRunSha256,systemdNspawnSha256,nsenterSha256,slirp4netnsSha256");
  const toolPins = [[trustedCustodySystemdRunExecutable,"systemdRunSha256"],["/usr/bin/systemd-nspawn","systemdNspawnSha256"],
    [trustedOrdinaryGuestSeedReaderLaunch(process.execPath,candidate.candidateArtifactPath).command,"nsenterSha256"],[trustedOrdinaryGuestNetworkLaunch().command,"slirp4netnsSha256"]] as const;
  const inputPath = fixture.rootfsPath + qualificationRoot + "/usable-input.json", inputBytes = qualificationRead(inputPath,65536,true);
  const input = qualificationObject(qualificationJson(inputBytes), "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure,creator,tools");
  const clocks = qualificationObject(input.operation,"operationId,workEndEpochMs,cleanupEndEpochMs"), inputFixture = qualificationObject(input.fixture,"testId,guestMachineId,guestHostname,guestEntrySha256");
  if (input.schemaVersion !== 1 || qualificationSha(inputBytes) !== fixture.inputSha256 || Object.keys(clocks).some(key => clocks[key] !== operation[key as keyof typeof operation]) ||
      JSON.stringify(input.candidate) !== JSON.stringify(candidate) || Object.keys(inputFixture).some(key => inputFixture[key] !== fixture[key as keyof typeof fixture]) ||
      typeof input.workerId !== "string" || typeof input.providerId !== "string" || !/^[a-f0-9-]{36}$/.test(input.workerId) || !/^[a-f0-9-]{36}$/.test(input.providerId) ||
      new Set([fixture.testId,input.workerId,input.providerId]).size !== 3) qualificationHeld();
  const guestEntry = candidate.candidateArtifactPath + "/dist/worker-codex/hosted-ordinary-installation-usable-guest.js";
  const profile = qualificationJson(qualificationRead(fixture.rootfsPath + qualificationProfile,65536,true)) as { node: { path: string; sha256: string } };
  const rejoin = () => {
    clock.remaining(); assertOriginalOrdinaryInstallationOperation(operation,true);
    if (!qualificationRead(root + ".usable-fixture.json",65536,true).equals(selectionBytes) || !qualificationRead(inputPath,65536,true).equals(inputBytes) ||
        !qualificationCandidate(candidate).equals(sourceBytes)) qualificationHeld();
    qualificationCandidate(candidate,fixture.rootfsPath); qualificationCopiedCohort(candidate,fixture.rootfsPath);
    for (const [path,key] of toolPins) if (qualificationSha(qualificationRead(path,32*1024*1024)) !== tools[key]) qualificationHeld();
    if (qualificationSha(qualificationRead(fixture.rootfsPath + qualificationProfile,65536,true)) !== candidate.profileSha256 ||
        qualificationSha(qualificationRead(fixture.rootfsPath+guestEntry)) !== fixture.guestEntrySha256 ||
        profile.node.path !== process.execPath || qualificationSha(qualificationRead(profile.node.path,256*1024*1024)) !== profile.node.sha256 ||
        qualificationRead(fixture.rootfsPath+"/etc/machine-id").toString("utf8").trim() !== fixture.guestMachineId ||
        qualificationRead(fixture.rootfsPath+"/etc/hostname").toString("utf8").trim() !== fixture.guestHostname ||
        !qualificationRead(fixture.rootfsPath+"/etc/systemd/system/ordinary-qualification.service").equals(qualificationBootRecipe(profile.node.path,guestEntry))) qualificationHeld();
    const link = lstatSync(fixture.rootfsPath+"/etc/systemd/system/multi-user.target.wants/ordinary-qualification.service");
    if (!link.isSymbolicLink() || link.uid !== 0 || readlinkSync(fixture.rootfsPath+"/etc/systemd/system/multi-user.target.wants/ordinary-qualification.service") !== "/etc/systemd/system/ordinary-qualification.service") qualificationHeld();
  };
  rejoin();
  // The original image must not already have a process/old run, even register=no.
  const pids = readdirSync("/proc").filter(pid => /^[1-9][0-9]*$/.test(pid)); if (pids.length>65536) qualificationHeld();
  for (const pid of pids) { clock.remaining(); try { const actual=statSync(`/proc/${pid}/root`); if (actual.dev===directory.dev && actual.ino===directory.ino) qualificationHeld(); }
    catch(error) { if (!["ENOENT","ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } }
  if (readdirSync(fixture.rootfsPath+qualificationRoot+"/output").length) qualificationHeld();
  const { collectUnitNotFound,collectJobs } = await import("./hosted-readonly-linux-collector"); rejoin();
  const unit="subscription-runtime-ordinary-"+fixture.testId+".service";
  if (!collectUnitNotFound(unit) || collectJobs().includes(unit)) qualificationHeld();
  qualificationCreate(fixture.rootfsPath+qualificationRoot+"/funded-operation.json",fundedBytes);
  const use=await openOriginalOrdinaryGuestBroker(operation,fixture.rootfsPath,fixture.inputSha256), cell=cellOf(use,operation,true);
  try {
    rejoin();
    const launch=trustedOrdinaryQualificationOuterLaunch(fixture.testId,fixture.rootfsPath,clock.remaining(),Math.min(30000,operation.cleanupEndEpochMs-operation.workEndEpochMs));
    launch.args.push(originalOrdinaryGuestSeedBind(use,operation));
    const payload=launch.args.slice(launch.args.indexOf("--")+1);
    cell.outer=new QualificationChild(spawn(launch.command,launch.args,{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"},stdio:["pipe","pipe","pipe"]}),unit,clock,root+"/usable-outer");
    cell.outer.admitProxy();cell.outer.endInput(); await cell.outer.bind(payload[0]!,payload,trustedCustodySystemdRunExecutable);rejoin();
    while (!cell.guest) { clock.remaining();
      try { bindOriginalOrdinaryGuestBroker(use,operation); } catch(error) { if (cell.state===BrokerState.Held) throw error; await new Promise(resolve=>setTimeout(resolve,10)); } }
    await attachOriginalOrdinaryGuestNetwork(use,operation);rejoin();publishOriginalOrdinaryGuestReady(use,operation);
    // Completion DATA only triggers the original owner's fresh physical checks.
    const providerPath=fixture.rootfsPath+qualificationRoot+"/output/usable-provider.json";
    while (true) { clock.remaining();assertLiveOriginalOrdinaryGuestBroker(use,operation); try { lstatSync(providerPath);break; }
      catch(error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; await new Promise(resolve=>setTimeout(resolve,20)); } }
    const providerBytes=qualificationRead(providerPath,65536,true),provider=qualificationObject(qualificationJson(providerBytes),"schemaVersion,operationSha256,inputSha256,creatorId,sourceExitCode,activationGeneration,providerDrained");
    const creator=qualificationObject(input.creator,"creatorId,jobId,jobRootDir,workspacePath,launch");
    if (provider.schemaVersion!==1 || provider.operationSha256!==operation.operationSha256 || provider.inputSha256!==fixture.inputSha256 ||
        provider.creatorId!==creator.creatorId || provider.sourceExitCode!==0 || provider.providerDrained!==true || !Number.isSafeInteger(provider.activationGeneration)) qualificationHeld();
    const drainedPath=fixture.rootfsPath+qualificationRoot+"/output/usable-worker-drained.json";
    while(true){clock.remaining();assertLiveOriginalOrdinaryGuestBroker(use,operation);try{lstatSync(drainedPath);break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
    const drained=qualificationObject(qualificationJson(qualificationRead(drainedPath,65536,true)),"schemaVersion,operationSha256,inputSha256,providerSha256,workerDrained");
    if(drained.schemaVersion!==1||drained.operationSha256!==operation.operationSha256||drained.inputSha256!==fixture.inputSha256||drained.providerSha256!==qualificationSha(providerBytes)||drained.workerDrained!==true)qualificationHeld();
    await captureOriginalOrdinaryGuestRefresh(use,operation);rejoin();
    qualificationCreate(fixture.rootfsPath+qualificationRoot+"/usable-captured.json",qualificationBytes({schemaVersion:1,operationSha256:operation.operationSha256,inputSha256:fixture.inputSha256,providerSha256:qualificationSha(providerBytes)}));
    await finishOriginalOrdinaryGuestBroker(use,operation);
    qualificationCreate(root+"/usable-qualification.json",qualificationBytes({schemaVersion:1,operationSha256:operation.operationSha256,inputSha256:fixture.inputSha256,providerSha256:qualificationSha(providerBytes),sourceScopeSha256:candidate.sourceScopeSha256,originalDrained:true,refreshCommitted:true}));
  } catch(error) { cell.state=BrokerState.Held; try { await cell.outer?.settleFailed(); } catch { /* Original retained resources remain uncertain. */ } throw error; }
}
