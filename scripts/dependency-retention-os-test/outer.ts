/** The runner only operates one newly registered service/root. Guest creation
 * is not authority: all positive gates execute inside its actual kernel view. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assemble } from "./assemble.ts";
import { cleanEnv, command as runCommand, directory, directoryIdentity, fileDigest, json, node, OwnedOsScenario, readonlyStorage, runtime, setupDiagnostic } from "./common.ts";

// This starts after workflow checkout/build/typecheck, not at workflow start.
// The unchanged 40-minute job timeout is the independent platform backstop.
const outerStarted = process.hrtime.bigint();
const milliseconds = (value: number): bigint => BigInt(value) * 1000000n;
const workDeadline = outerStarted + milliseconds(27 * 60 * 1000);
const outerDeadline = outerStarted + milliseconds(30 * 60 * 1000);
const earlier = (left: bigint, right: bigint): bigint => left < right ? left : right;
function remaining(deadline: bigint, failure = "owned TEST shared monotonic work budget exhausted"): number {
  const value = Number((deadline - process.hrtime.bigint()) / 1000000n);
  assert(value > 0, failure); return value;
}
function boundedCommand(file: string, args: readonly string[], deadline: bigint, timeout = 30000): string {
  const output = runCommand(file, args, Math.min(timeout, remaining(deadline)));
  remaining(deadline); return output;
}

assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0); assert.equal(process.arch, "x64");
assert.equal(process.env.GITHUB_ACTIONS, "true", "owned OS fixture requires a disposable GitHub VM");
assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
assert.equal(boundedCommand("/usr/bin/lsb_release", ["--codename", "--short"], workDeadline).trim(), "noble");
const source = resolve(process.argv[2] ?? ""), toolchain = resolve(process.argv[3] ?? "");
assert(source.startsWith("/home/runner/work/")); assert(toolchain.startsWith("/opt/hostedtoolcache/node/"));
assert(existsSync(source + "/dist/worker-codex/codex-goal-cli.js"));
assert.equal(dirname(dirname(process.execPath)), toolchain);
const base = "/var/lib/subscription-runtime-os-TEST";
assert(!existsSync(base), "refuse any existing fixture namespace"); directory(base);
const defaultEvidence = await runOwnedOs(OwnedOsScenario.Dependency);
// Incompatible authenticated inventories never share an installation. A second
// fresh OS gets the same exact reviewed runtime/FDA source and its own data FS.
if (defaultEvidence.status === "partial_pass") {
  defaultEvidence.readonlyFixture = process.hrtime.bigint() + milliseconds(1) < workDeadline
    ? await runOwnedOs(OwnedOsScenario.Readonly)
    : { status: "failed", scenario: OwnedOsScenario.Readonly, notLaunched: true,
      failure: "owned TEST shared monotonic budget exhausted before readonly preparation" };
}
if ((defaultEvidence.readonlyFixture as Record<string, unknown> | undefined)?.status !== "partial_pass") {
  defaultEvidence.status = "failed"; process.exitCode = 1;
}
defaultEvidence.outerBudget = { clock: "process.hrtime.bigint", workMs: 27 * 60 * 1000,
  cleanupEvidenceReserveMs: 3 * 60 * 1000, totalMs: 30 * 60 * 1000,
  elapsedMs: Number((process.hrtime.bigint() - outerStarted) / 1000000n),
  startsAfter: "workflow checkout/build/typecheck", workflowTimeoutMinutes: 40 };
assert(Buffer.byteLength(JSON.stringify(defaultEvidence)) <= 512 * 1024);
json(source + "/dependency-retention-os-evidence.json", defaultEvidence, 0o644);

async function runOwnedOs(scenario: OwnedOsScenario): Promise<Record<string, unknown>> {
const id = randomUUID(), owned = base + "/" + id; directory(owned);
const root = owned + "/root", unit = `TEST-retention-os-${id}.service`;
const machineId = randomUUID().replaceAll("-", ""), outerMachineId = readFileSync("/etc/machine-id", "utf8").trim();
const evidence: Record<string, unknown> = { schemaVersion: 1, qualification: "owned_native_os_synthetic_provider",
  sourceSha: process.env.TEST_SOURCE_SHA, scenario, unit, machineId, outerMachineId, status: "failed", results: [],
  unsupported: ["committed_absent_eviction_and_cold_restore", "live_account_provider_acceptance", "complete_stdio_fd_peer_provenance"] };
let registered: ReturnType<typeof directoryIdentity> | undefined;
let invocationId: string | undefined;
let fragmentSha256: string | undefined;
const scenarioStarted = process.hrtime.bigint();
let deadline = earlier(workDeadline, scenarioStarted + milliseconds(22 * 60 * 1000));
const command = (file: string, args: readonly string[], timeout = 30000): string => boundedCommand(file, args, deadline, timeout);
try {
  remaining(deadline);
  assemble(root, owned + "/apt", source, toolchain, process.env.TEST_SOURCE_SHA!, machineId, scenario, () => remaining(deadline));
  remaining(deadline);
  let dataImage: string | undefined;
  if (scenario === OwnedOsScenario.Readonly) {
    // Reserve real backing bytes before formatting, never a sparse capacity
    // claim. systemd owns the loop/mount solely in this exact service namespace.
    const bytes = 6n * 1024n * 1024n * 1024n, free = statfsSync(owned, { bigint: true });
    assert(free.bavail * free.bsize >= bytes && free.ffree >= 100000n, "TEST readonly scratch capacity unavailable");
    dataImage = owned + "/readonly-data.ext4";
    const fd = openSync(dataImage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let inode: ReturnType<typeof fstatSync>;
    try { inode = fstatSync(fd); assert(inode.isFile() && inode.uid === 0 && inode.nlink === 1); }
    finally { closeSync(fd); }
    command("/usr/bin/fallocate", ["--length", String(bytes), dataImage], 60000);
    command("/usr/sbin/mkfs.ext4", ["-F", "-m", "0", "-N", "100000", dataImage], 60000);
    const current = lstatSync(dataImage); assert(current.dev === inode.dev && current.ino === inode.ino &&
      current.uid === 0 && current.nlink === 1 && (current.mode & 0o777) === 0o600 && BigInt(current.size) === bytes);
    evidence.readonlyImage = { path: dataImage, dev: String(current.dev), ino: String(current.ino), bytes: String(bytes),
      scratchAvailableBytes: String(free.bavail * free.bsize), scratchAvailableInodes: String(free.ffree),
      attachment: "owned service MountImages only; no runner mount operation" };
  }
  registered = directoryIdentity(root);
  const packagePath = root + runtime + "/os-packages.json";
  const packageStat = lstatSync(packagePath); assert(packageStat.isFile() && packageStat.uid === 0 && packageStat.size < 65536);
  evidence.osPackageFacts = JSON.parse(readFileSync(packagePath, "utf8"));
  assert.equal(fileDigest(root + node), fileDigest(process.execPath));
  // This trusted startup probe runs only in the newly extracted CI guest root,
  // before jobs, auth fixtures or systemd units. It cannot mount host libraries.
  const startup = spawnSync("/usr/sbin/chroot", [root, node, "--version"], { env: cleanEnv, cwd: "/",
    encoding: "utf8", timeout: Math.min(10000, remaining(deadline)), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
  const versionOutput = startup.stdout?.trim() ?? "";
  evidence.nodePreboot = { status: startup.status, signal: startup.signal,
    errorCode: startup.error && "code" in startup.error && ["ENOENT", "EACCES", "ETIMEDOUT"].includes(String(startup.error.code))
      ? startup.error.code : startup.error ? "other" : null,
    version: /^v\d+\.\d+\.\d+$/.test(versionOutput) ? versionOutput : null,
    diagnostic: setupDiagnostic(startup.stderr ?? "") };
  assert(!startup.error && startup.status === 0 && startup.signal === null && versionOutput === process.version,
    "owned TEST pinned Node preboot failed");
  remaining(deadline);
  const nspawn = root + "/usr/bin/systemd-nspawn";
  const version = command(nspawn, ["--version"]).split("\n")[0]!;
  assert.match(version, /^systemd 255(?:\.|\s)/);
  const launch = { schemaVersion: 1, purpose: "dependency-retention-owned-OS-TEST", unit, root: registered,
    machineId, outerMachineId, sourceSha: process.env.TEST_SOURCE_SHA, nspawnVersion: version, nspawnSha256: fileDigest(nspawn) };
  json(owned + "/registration.json", launch);
  evidence.launchRegistration = launch;
  const runtimeSeconds = Math.ceil(remaining(deadline) / 1000) + 90;
  const fragment = `[Unit]\nDescription=Owned disposable dependency TEST OS ${id}\n[Service]\nType=exec\nDelegate=yes\nKillMode=control-group\nRestart=no\nRuntimeMaxSec=${runtimeSeconds}s\nTimeoutStopSec=30s\n${dataImage ? `MountImages=${dataImage}:${readonlyStorage}\n` : ""}Environment=SYSTEMD_NSPAWN_USE_CGNS=1\nExecStart=${nspawn} --directory=${root} --machine=TEST-retention-${id} --register=no --keep-unit --private-users=no --boot --console=pipe --resolv-conf=off --capability=CAP_SYS_ADMIN,CAP_MKNOD,CAP_SETPCAP,CAP_SETFCAP,CAP_SYS_PTRACE ${dataImage ? `--bind=${readonlyStorage} ` : ""}--setenv=SYSTEMD_UNIT_PATH=/etc/systemd/test-units:/run/systemd/system -- --unit=TEST-retention.target --log-target=console\n`;
  const unitPath = "/run/systemd/system/" + unit;
  assert(!existsSync(unitPath)); writeFileSync(unitPath, fragment, { flag: "wx", mode: 0o644 });
  fragmentSha256 = fileDigest(unitPath);
  json(owned + "/unit-registration.json", { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
  evidence.fragmentSha256 = fragmentSha256;
  command("/usr/bin/systemctl", ["daemon-reload"]);
  command("/usr/bin/systemctl", ["start", "--no-block", unit]);
  invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
  // A queued start may not yet have its invocation. Poll only this registered unit.
  const bootStarted = process.hrtime.bigint();
  const bootDeadline = earlier(deadline, bootStarted + milliseconds(90000));
  const path = root + runtime + "/guest-evidence.json";
  while (!existsSync(path)) {
    remaining(deadline);
    const childFailure = root + runtime + "/guest-child-exit.json";
    if (existsSync(childFailure)) {
      const stat = lstatSync(childFailure); assert(stat.isFile() && stat.uid === 0 && stat.size < 4096);
      const failure = JSON.parse(readFileSync(childFailure, "utf8")) as Record<string, unknown>;
      assert.equal(failure.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(failure.purpose, "TEST_child_failure_observation_only");
      evidence.guestChildFailure = failure;
      throw new Error("owned TEST qualification child exited before evidence");
    }
    const started = root + runtime + "/guest-started.json";
    evidence.bootObservation = { purpose: "TEST_readiness_observation_only", phase: evidence.guestBootstrap ? "qualification" : "supervisor_start",
      supervisorMarkerPresent: existsSync(started), readinessLimitMs: 90000,
      readinessElapsedMs: Number((process.hrtime.bigint() - bootStarted) / 1000000n),
      scenarioRemainingMs: remaining(deadline), workRemainingMs: remaining(workDeadline) };
    if (!existsSync(started)) remaining(bootDeadline, "owned TEST guest supervisor readiness deadline exhausted");
    else if (!evidence.guestBootstrap) {
      const stat = lstatSync(started); assert(stat.isFile() && stat.uid === 0 && stat.size < 4096);
      const bootstrap = JSON.parse(readFileSync(started, "utf8")) as Record<string, unknown>;
      assert.equal(bootstrap.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(bootstrap.machineId, machineId);
      assert.equal(bootstrap.purpose, "TEST_bootstrap_observation_only"); evidence.guestBootstrap = bootstrap;
    }
    const state = command("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"]).trim();
    assert(["active", "activating"].includes(state), "owned TEST guest exited before evidence");
    if (!invocationId) invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining(deadline))));
  }
  assert.match(invocationId ?? "", /^[a-f0-9]{32}$/);
  evidence.invocationId = invocationId;
  const stat = lstatSync(path); assert(stat.isFile() && stat.uid === 0 && stat.size < 65536);
  const guest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(guest.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(guest.machineId, machineId);
  assert.equal(guest.qualification, scenario === OwnedOsScenario.Dependency ? "native_fresh_hot_synthetic_provider" : "native_readonly_custody_synthetic_provider");
  evidence.guest = guest; evidence.status = guest.status;
  const outputPath = root + runtime + "/guest-output-observation.json";
  const outputDeadline = earlier(deadline, process.hrtime.bigint() + milliseconds(2000));
  while (!existsSync(outputPath)) {
    const allowance = Number((outputDeadline - process.hrtime.bigint()) / 1000000n);
    if (allowance <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, allowance)));
  }
  if (existsSync(outputPath)) {
    const outputStat = lstatSync(outputPath); assert(outputStat.isFile() && outputStat.uid === 0 && outputStat.nlink === 1 && outputStat.size < 16384);
    const output = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(output.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(output.purpose, "TEST_output_classification_only");
    evidence.guestOutputObservation = output;
  } else evidence.guestOutputObservationUnavailable = true;
  assert.equal(guest.status, "partial_pass", "actual unchanged guest gate did not qualify");
  remaining(deadline);
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message.slice(0, 512) : "owned TEST fixture failure";
  process.exitCode = 1;
} finally {
  // Cleanup uses the separately reserved shared allowance, never another full
  // guest budget. Uncertain ownership/deadline failure remains failed/held.
  deadline = earlier(outerDeadline, process.hrtime.bigint() + milliseconds(90000));
  if (registered && existsSync("/run/systemd/system/" + unit)) {
    try {
      assert.deepEqual(directoryIdentity(root), registered);
      assert.equal(readFileSync("/etc/machine-id", "utf8").trim(), outerMachineId);
      const retained = JSON.parse(readFileSync(owned + "/unit-registration.json", "utf8")) as Record<string, unknown>;
      assert.deepEqual(retained, { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
      assert.equal(fileDigest("/run/systemd/system/" + unit), retained.fragmentSha256);
      const current = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 5000).trim();
      assert(invocationId && current === invocationId, "uncertain owned unit: leave held for VM disposal");
      if (evidence.status !== "partial_pass") {
        try {
        const shown = command("/usr/bin/systemctl", ["show", unit,
          "--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"], 5000);
        const properties: Record<string, string> = {};
        for (const line of shown.trim().split("\n")) {
          const [key, value, ...extra] = line.split("=");
          assert(key && value !== undefined && extra.length === 0 && /^[A-Za-z0-9_-]{0,80}$/.test(value));
          assert(["ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus"].includes(key)); properties[key] = value;
        }
        const journal = spawnSync("/usr/bin/journalctl", ["--unit", unit, "--no-pager", "--output=cat", "--lines=80"],
          { env: cleanEnv, encoding: "utf8", timeout: Math.min(5000, remaining(deadline)), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
        evidence.ownedUnitFailure = { properties, journalDiagnostic: setupDiagnostic(journal.stdout ?? ""), journalStatus: journal.status };
        } catch { evidence.ownedUnitDiagnosticUnavailable = true; }
        try {
          // Observation starts only after failure and exact outer ownership
          // checks. Its own allowance cannot consume the stop reservation.
          const observationDeadline = earlier(deadline - milliseconds(60000), process.hrtime.bigint() + milliseconds(15000));
          evidence.guestBootFailure = observeGuestBoot(root, registered, unit, invocationId, observationDeadline);
          assert.equal(command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 2000).trim(), invocationId);
        } catch { delete evidence.guestBootFailure; evidence.guestBootDiagnosticUnavailable = true; }
      }
      command("/usr/bin/systemctl", ["stop", unit], 45000);
      evidence.ownedOsStopped = true;
    } catch { evidence.status = "failed"; evidence.ownedOsStopped = false; process.exitCode = 1; }
  }
  // No guest registry/root is deleted. VM disposal retains uncertain state until
  // the platform ends the owned job; export bounded sanitized facts only.
  if (process.hrtime.bigint() >= outerDeadline) {
    evidence.status = "failed"; evidence.budgetExhaustedDuringCleanup = true; process.exitCode = 1;
  }
  evidence.scenarioElapsedMs = Number((process.hrtime.bigint() - scenarioStarted) / 1000000n);
  assert(Buffer.byteLength(JSON.stringify(evidence)) <= 256 * 1024);
  json(owned + "/owned-evidence.json", evidence, 0o644);
}
return evidence;
}

// No result here can authorize a launch. Every query addresses only the
// already-failed owned guest's PID1 private socket, never a system-bus fallback.
function observeGuestBoot(root: string, registered: ReturnType<typeof directoryIdentity>, unit: string,
  invocationId: string, deadline: bigint): Record<string, unknown> {
  function proc(path: string, bound: number): string {
    remaining(deadline, "owned TEST boot diagnostic allowance exhausted");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const bytes = Buffer.alloc(bound + 1); let size = 0, count = 0;
      while ((count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += count; assert(size <= bound); }
      return bytes.subarray(0, size).toString("utf8");
    } finally { closeSync(fd); }
  }
  const pinsPath = root + runtime + "/os-signed-elf-pins.json";
  const pinsStat = lstatSync(pinsPath); assert(pinsStat.isFile() && pinsStat.uid === 0 && pinsStat.nlink === 1 &&
    (pinsStat.mode & 0o777) === 0o600 && pinsStat.size <= 128 * 1024);
  const signed = JSON.parse(proc(pinsPath, 128 * 1024)) as { schemaVersion: unknown; pins: unknown };
  assert(signed.schemaVersion === 1 && Array.isArray(signed.pins) && signed.pins.length <= 20000);
  const busPins = signed.pins.filter((pin: unknown): pin is { path: string; sha256: string } => {
    if (!pin || typeof pin !== "object" || !("path" in pin) || !("sha256" in pin)) return false;
    return pin.path === "/usr/bin/systemctl" && typeof pin.sha256 === "string" && /^[a-f0-9]{64}$/.test(pin.sha256);
  });
  assert.equal(busPins.length, 1);
  const systemctl = root + "/usr/bin/systemctl", binary = lstatSync(systemctl, { bigint: true });
  assert(binary.isFile() && binary.uid === 0n && binary.nlink === 1n && (binary.mode & 0o6022n) === 0n &&
    binary.size > 0n && binary.size <= 32n * 1024n * 1024n);
  assert.equal(fileDigest(systemctl), busPins[0]!.sha256);
  const binaryIdentity = { dev: String(binary.dev), ino: String(binary.ino), bytes: String(binary.size), sha256: busPins[0]!.sha256 };
  const group = "/system.slice/" + unit;
  assert.equal(boundedCommand("/usr/bin/systemctl", ["show", unit, "--property=ControlGroup", "--value"], deadline, 2000).trim(), group);
  const pids = new Set<number>(); let groups = 0;
  function scan(path: string, depth: number): void {
    assert(++groups <= 128 && depth <= 8); remaining(deadline);
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
    for (const row of proc(path + "/cgroup.procs", 32768).trim().split("\n").filter(Boolean)) {
      assert(/^[1-9][0-9]*$/.test(row)); pids.add(Number(row)); assert(pids.size <= 256);
    }
    const names = readdirSync(path); assert(names.length <= 512);
    for (const name of names) { assert(/^[A-Za-z0-9_.:@-]+$/.test(name));
      const child = lstatSync(path + "/" + name); if (child.isDirectory()) scan(path + "/" + name, depth + 1); }
  }
  scan("/sys/fs/cgroup" + group, 0);
  const candidates = [...pids].filter(pid => {
    try { const ids = /^NSpid:\s+([0-9 \t]+)$/m.exec(proc(`/proc/${pid}/status`, 16384))?.[1]?.trim().split(/\s+/).map(Number);
      return ids && ids.length >= 2 && ids[0] === pid && ids.at(-1) === 1;
    } catch { return false; }
  });
  assert.equal(candidates.length, 1); const pid = candidates[0]!;
  function identity() {
    const currentBinary = lstatSync(systemctl, { bigint: true });
    assert(currentBinary.isFile() && currentBinary.uid === 0n && currentBinary.nlink === 1n && (currentBinary.mode & 0o6022n) === 0n &&
      currentBinary.dev === binary.dev && currentBinary.ino === binary.ino && currentBinary.size === binary.size);
    assert.equal(fileDigest(systemctl), binaryIdentity.sha256);
    const status = proc(`/proc/${pid}/status`, 16384); assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/m);
    const ids = /^NSpid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
    assert(ids && ids.length >= 2 && ids[0] === pid && ids.at(-1) === 1);
    const cg = proc(`/proc/${pid}/cgroup`, 4096).trim(); assert(cg === "0::" + group || cg.startsWith("0::" + group + "/"));
    const stat = proc(`/proc/${pid}/stat`, 4096), fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    assert.match(fields[19] ?? "", /^[1-9][0-9]*$/);
    const currentRoot = statSync(`/proc/${pid}/root`, { bigint: true });
    assert(currentRoot.isDirectory() && String(currentRoot.dev) === registered.dev && String(currentRoot.ino) === registered.ino);
    assert.deepEqual(directoryIdentity(root), registered);
    const exe = statSync(`/proc/${pid}/exe`, { bigint: true }), expected = lstatSync(root + "/usr/lib/systemd/systemd", { bigint: true });
    assert(expected.isFile() && expected.uid === 0n && expected.nlink === 1n && (expected.mode & 0o022n) === 0n);
    assert(exe.dev === expected.dev && exe.ino === expected.ino);
    const mnt = readlinkSync(`/proc/${pid}/ns/mnt`), pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
    assert(mnt !== readlinkSync("/proc/self/ns/mnt") && pidNamespace !== readlinkSync("/proc/self/ns/pid"));
    // /run is the guest's runtime tmpfs, visible through the authenticated
    // process-root magic link, not the underlying extracted host directory.
    const socket = lstatSync(`/proc/${pid}/root/run/systemd/private`, { bigint: true }); assert(socket.isSocket() && socket.uid === 0n);
    const descriptors = readdirSync(`/proc/${pid}/fd`); assert(descriptors.length <= 4096); const held = new Set<string>();
    for (const fd of descriptors) { assert(/^[0-9]+$/.test(fd));
      try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (match) held.add(match[1]!); }
      catch { /* A concurrently closed FD supplies no listener identity. */ }
    }
    const rows = proc(`/proc/${pid}/net/unix`, 2 * 1024 * 1024).trim().split("\n").slice(1); assert(rows.length <= 65536);
    const listeners = rows.map(row => row.trim().split(/\s+/)).filter(row => row.length === 8 && row[7] === "/run/systemd/private" &&
      row[4] === "0001" && (Number.parseInt(row[3]!, 16) & 0x10000) !== 0 && held.has(row[6]!));
    assert.equal(listeners.length, 1);
    return { pid, birth: fields[19]!, group: cg, rootDev: registered.dev, rootIno: registered.ino,
      mnt, pidNamespace, listenerInode: listeners[0]![6]!, socketDev: String(socket.dev), socketIno: String(socket.ino) };
  }
  const before = identity(); const observations: unknown[] = [], retained: number[] = [];
  try {
  // Retained namespace/root handles prevent a target PID reuse between the
  // checks and nsenter from redirecting even a read-only query outside TEST.
  for (const suffix of ["ns/mnt", "ns/pid", "root"] as const)
    retained.push(openSync(`/proc/${pid}/${suffix}`, constants.O_RDONLY));
  assert.equal(String(fstatSync(retained[0]!, { bigint: true }).ino), /^mnt:\[([0-9]+)\]$/.exec(before.mnt)?.[1]);
  assert.equal(String(fstatSync(retained[1]!, { bigint: true }).ino), /^pid:\[([0-9]+)\]$/.exec(before.pidNamespace)?.[1]);
  const retainedRoot = fstatSync(retained[2]!, { bigint: true }); assert(retainedRoot.isDirectory() &&
    String(retainedRoot.dev) === registered.dev && String(retainedRoot.ino) === registered.ino);
  assert.deepEqual(identity(), before);
  for (const name of ["dbus.socket", "dbus.service", "TEST-retention-supervisor.service", "TEST-retention.target"] as const) {
      assert.deepEqual(identity(), before);
      const keys = ["Id", "LoadState", "ActiveState", "SubState", "Job", "Result", "MainPID", "ExecMainCode", "ExecMainStatus", "TimeoutStartUSec"];
      const result = spawnSync("/usr/bin/nsenter", ["--mount=/proc/self/fd/3", "--pid=/proc/self/fd/4", "--root=/proc/self/fd/5", "--wdns=/", "--",
        "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show", "--property=" + keys.join(","), "--", name],
        { env: { ...cleanEnv, DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/systemd/private" }, encoding: "utf8",
          timeout: Math.min(2000, remaining(deadline)), maxBuffer: 8192,
          stdio: ["ignore", "pipe", "pipe", retained[0]!, retained[1]!, retained[2]!] });
      assert.deepEqual(identity(), before);
      const rows = result.status === 0 && !result.error && result.signal === null ? result.stdout.trim().split("\n") : [];
      assert(rows.length <= keys.length); const properties: Record<string, string> = {};
      for (const row of rows) {
        const [key, value, ...extra] = row.split("=");
        assert(key && keys.includes(key) && value !== undefined && extra.length === 0 && !(key in properties));
        // Only fixed scalar status/timer fields, no paths, environment, raw
        // journal or arbitrary unit/provider names are copied to evidence.
        assert(/^[A-Za-z0-9_. -]{0,80}$/.test(value)); if (key === "Id") assert.equal(value, name);
        properties[key] = value;
      }
      if (rows.length) assert(properties.Id === name && properties.LoadState && properties.ActiveState && properties.SubState);
      observations.push({ unit: name, status: result.status, signal: result.signal,
        failed: !!result.error, properties, diagnostic: setupDiagnostic(result.stderr ?? "") });
  }
  assert.deepEqual(identity(), before);
  return { purpose: "TEST_failed_guest_boot_observation_only", invocationId, pid1: before,
    address: "unix:path=/run/systemd/private", systemctl: binaryIdentity, observations };
  } finally { for (const fd of retained) closeSync(fd); }
}
