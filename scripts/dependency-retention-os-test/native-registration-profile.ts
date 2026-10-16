/** Exact accepted native physical FD/bus/root-Git qualification bodies.
 * Observations remain factual until ORIGINAL installed readers authenticate them. */
import { qualifyIoUringEffects } from "./io-uring.ts";
import assert from "node:assert/strict";
import { observedProcessCgroup } from "../../dist/core/host-infrastructure/process-cgroup.js";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from "node:fs";

import { verifySystemBusInfrastructure } from "../../dist/provider-codex/index.js";
import { parseSystemBusInfrastructure, SystemBusInfrastructureRole, SYSTEM_BUS_ARGUMENTS, SYSTEM_BUS_CONFIG, SYSTEM_BUS_CONFIG_PATH, SYSTEM_BUS_CONTROL_GROUP, SYSTEM_BUS_ENDPOINT, SYSTEM_BUS_EXECUTABLE, SYSTEM_BUS_SERVICE_FRAGMENT, SYSTEM_BUS_SOCKET_FRAGMENT, SystemBusQueryRenderer, type SystemBusQueryTool, type SystemBusFilePin, type SystemBusInfrastructure } from "../../dist/core/index.js";

import { assertPinnedSystemBusQueryTool, observeSystemdServiceEmptyArrays, SystemdServiceArrayKind, type SystemdEmptyArrayFact } from "../../dist/provider-codex/app-server/adapters/systemd-service-arrays.js";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyToolRootKind } from "../../dist/worker-core/index.js";
import { HostedDependencyInstallerNetworkInput, hostedDependencyInstallerNetworkRoot, hostedDependencyInstallerNpmRootSha256, HostedDependencyInstallerRevision, hostedDependencyInstallerDropperSha256, type HostedDependencyInstallerProfile } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { HostedDependencyRootGitRecipe, assertHostedDependencyRootGitProfile, type HostedDependencyRootGitFilePin, type HostedDependencyRootGitProfile } from "../../dist/worker-codex/hosted-dependency-root-git-profile.js";

import { fdCollectorProfilePath, FdCollectorRenderer, parseFdCollectorProfile, parseFdCollectorRows, knownFdCollectorPeer, type FdCollectorProfile, type FdExecutablePin, type FdFilePin, type FdCollectorPeer } from "../../dist/core/host-infrastructure/fd-collector-profile.js";
import { assertHostedFdInternals, observeHostedFdProcess, hostedFdTable } from "../../dist/provider-codex/app-server/adapters/hosted-fd-observation.js";

import { hostedDependencySystemdRunExecutable } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-systemd-command.js";
import { cleanEnv, command, digest, directory, fileDigest, json, node, OwnedOsScenario, policy, runtime } from "./common.ts";

export async function issueNativeFdProfile(evidence: Record<string, unknown>, bus: SystemBusInfrastructure): Promise<{
  collectorProfile: { path: typeof fdCollectorProfilePath; sha256: string }; rootGit: HostedDependencyRootGitProfile }> {
  enum NativeFdQualificationPhase { Pins = "pins", UidObservation = "uid_observation", NamedSockets = "named_sockets",
    Profile = "profile", Internals = "internals", ExtraSocket = "extra_socket", DirectBusSocket = "direct_bus_socket",
    FinalPins = "final_pins", Publication = "publication", Complete = "complete" }
  enum NativeFdQualificationParser { None = "none", Rows = "rows", Profile = "profile" }
  const measured = { setupMs: 0, collectorMs: 0, outputBytes: 0, rows: 0, eventPoll: 0, eventFd: 0, pipes: 0, devNull: 0 };
  const progress: { purpose: string; phase: NativeFdQualificationPhase; parser: NativeFdQualificationParser;
    uid: 0 | 65532 | null; completedUidObservations: number; rowParseCalls: number; measured: typeof measured;
    rowsInput?: ReturnType<typeof nativeFdRowsInputFacts>;
    internalsInput?: ReturnType<typeof nativeFdInternalsInputFacts> & { snapshotOrdinal: number };
    profileInput?: { ssElfFiles: number; nodeElfFiles: number;
      wrapperElfFiles: readonly number[]; bootstrapCount: number; limits: FdCollectorProfile["limits"] } } = {
    purpose: "TEST_partial_fd_qualification_facts_not_profile_authority", phase: NativeFdQualificationPhase.Pins,
    parser: NativeFdQualificationParser.None, uid: null, completedUidObservations: 0, rowParseCalls: 0, measured };
  evidence.fdCollectorProgress = progress;
  const observerStatus = boundedProc("/proc/self/status", 16384);
  const capabilitySets = Object.fromEntries(["Inh", "Prm", "Eff", "Bnd", "Amb"].map(name => {
    const value = new RegExp(`^Cap${name}:\\s+([a-f0-9]{1,16})$`, "m").exec(observerStatus)?.[1]; assert(value);
    assert(BigInt("0x" + value) <= (1n << 41n) - 1n); return [name, value];
  })) as Record<string, string>;
  assert(BigInt("0x" + capabilitySets.Eff!) & (1n << 19n), "TEST root observer requires actual cross-UID ptrace access");
  assert.equal(BigInt("0x" + capabilitySets.Amb!), 0n);
  let lsm: string | undefined;
  try { const value = boundedProc("/proc/self/attr/current", 4096).trim();
    lsm = value === "unconfined" ? "unconfined" : "other_" + digest(value); }
  catch (error) { assert(["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")); }
  evidence.rootFdObserver = { uid: process.getuid!(), gid: process.getgid!(), capabilitySets, lsm: lsm ?? "unavailable",
    namespaces: { user: readlinkSync("/proc/self/ns/user"), pid: readlinkSync("/proc/self/ns/pid"), mount: readlinkSync("/proc/self/ns/mnt") },
    scope: "trusted root observer in private owned TEST OS proc; no runner proc or consumer privilege" };
  const qualificationBegan = performance.now();
  // Existing closed 60-second setup bound, shared by signed discovery and Git pins.
  // No per-library reset, no allowance increase for the added root transport.
  const remainingPins = () => {
    const left = Math.floor(60000 - (performance.now() - qualificationBegan));
    assert(left > 0, "TEST native signed pin setup allowance exhausted"); return left;
  };
  const effectDeadline = process.hrtime.bigint() + 20_000_000_000n;
  evidence.ioUringEffects = await qualifyIoUringEffects(bus, () => {
    const left = Number((effectDeadline - process.hrtime.bigint()) / 1_000_000n); assert(left > 0); return left;
  });
  const signedBytes = boundedProc(runtime + "/os-signed-elf-pins.json", 256 * 1024);
  const signedValue = JSON.parse(signedBytes) as { schemaVersion: number; pins: FdFilePin[] };
  assert.equal(signedValue.schemaVersion, 1); assert(Array.isArray(signedValue.pins) && signedValue.pins.length <= 1024);
  const signed = new Map(signedValue.pins.map(pin => [pin.path, pin.sha256])); assert.equal(signed.size, signedValue.pins.length);
  const packageFacts = JSON.parse(boundedProc(runtime + "/os-packages.json", 256 * 1024)) as {
    packages: { package: string; version: string; arch: string; sha256: string }[]; pinnedNode: { sha256: string } };
  const ssPackages = packageFacts.packages.filter(row => row.package === "iproute2");
  assert.equal(ssPackages.length, 1); assert.equal(ssPackages[0]!.version, "6.1.0-1ubuntu6.4");
  assert.equal(ssPackages[0]!.arch, "amd64"); assert.match(ssPackages[0]!.sha256, /^[a-f0-9]{64}$/);
  evidence.fdCandidateNode = { bytes: lstatSync(node).size, version: process.version, artifactSha256: packageFacts.pinnedNode.sha256 };
  const pin = (path: string): FdFilePin => {
    assert.equal(realpathSync(path), path);
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const stat = lstatSync(parent); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
      if (parent === "/") break;
    }
    const before = lstatSync(path); assert(before.isFile() && before.uid === 0 && before.nlink === 1 &&
      !(before.mode & 0o022) && before.size > 0 && before.size <= 256 * 1024 * 1024);
    const sha256 = fileDigest(path), after = lstatSync(path);
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs);
    return { path, sha256 };
  };
  const executable = (path: string): FdExecutablePin => {
    remainingPins(); const first = pin(path);
    assert.equal(first.sha256, path === node ? packageFacts.pinnedNode.sha256 : signed.get(path));
    // Hash/immutable ancestry before invoking the trusted OS linkage tool.
    const libraries = actualLibraries(path, remainingPins).map(row => {
      remainingPins();
      const current = pin(row.path); assert.equal(current.sha256, signed.get(row.path)); return current;
    });
    assert.equal(pin(path).sha256, first.sha256); remainingPins();
    return { ...first, elfFiles: [first, ...libraries] };
  };
  const ss = executable("/usr/bin/ss"), nodePin = executable(node);
  // Exact Git is authenticated independently BEFORE its trusted ldd closure.
  // Never borrow Node's closure or add Git to FDA wrappers/bootstraps.
  const gitPin = executable("/usr/bin/git");
  const physicalGitPin = (file: FdFilePin): HostedDependencyRootGitFilePin => {
    remainingPins(); const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      const info = boundedProc(`/proc/self/fdinfo/${fd}`, 16384);
      const mount = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)]; assert.equal(mount.length, 1); assert(mount[0]?.[1]);
      assert(before.isFile() && before.nlink === 1n && before.uid === 0n && before.gid === 0n &&
        !(before.mode & 0o6022n) && before.size > 0n && before.size <= 32n * 1024n * 1024n);
      assert.equal(pin(file.path).sha256, file.sha256);
      const after = fstatSync(fd, { bigint: true }), named = lstatSync(file.path, { bigint: true });
      for (const stat of [after,named]) assert(stat.dev === before.dev && stat.ino === before.ino && stat.mode === before.mode &&
        stat.uid === before.uid && stat.gid === before.gid && stat.nlink === before.nlink && stat.size === before.size &&
        stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
      remainingPins(); return { path:file.path,sha256:file.sha256,dev:String(before.dev),ino:String(before.ino),
        mountId:mount[0][1],uid:0,gid:0,mode:Number(before.mode & 0o7777n),size:String(before.size) };
    } finally { closeSync(fd); }
  };
  const rootGit = assertHostedDependencyRootGitProfile({ version:1,recipe:HostedDependencyRootGitRecipe.RootGitReadV1,
    executable:physicalGitPin(gitPin),libraries:gitPin.elfFiles.slice(1).map(physicalGitPin) },remainingPins);
  const pythonPin = executable("/usr/bin/python3.12"); // Negative TEST fixture only; never a profile bootstrap.
  const wrappers = ["/usr/bin/setpriv", hostedDependencySystemdRunExecutable, "/usr/bin/tini", "/usr/bin/unshare"].map(executable);
  assert.equal(command(ss.path, ["--version"]).trim(), "ss utility, iproute2-6.1.0");
  const bootstraps = ["provider-codex/app-server/adapters/hosted-app-server-launcher.js",
    "worker-codex/hosted-dependency-installer-bootstrap.js", "worker-codex/hosted-readonly-host-launch-cli.js",
    "worker-codex/hosted-readonly-runtime-bootstrap.js", "worker-codex/hosted-readonly-foreground.js", "worker-codex/hosted-dependency-remover-bootstrap.js"]
    .map(path => pin(runtime + "/dist/" + path));
  if (process.env.TEST_OS_SCENARIO === OwnedOsScenario.Readonly) {
    for (const path of ["managed-launcher/launch.mjs", "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs"])
      bootstraps.push(pin("/opt/subscription-runtime/" + path));
  }
  const query = (): ReadonlyMap<string, FdCollectorPeer> => {
    const began = performance.now();
    delete progress.rowsInput;
    const result = spawnSync(ss.path, ["-H", "-n", "-A", "unix_stream", "state", "established", "src", "unix:"],
      { env: cleanEnv, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assert(!result.error && result.signal === null && result.status === 0 && result.stderr === "");
    // Bounded existing stdout only; numeric shape facts never repair the reply.
    progress.rowsInput = nativeFdRowsInputFacts(result.stdout); progress.rowParseCalls++;
    progress.parser = NativeFdQualificationParser.Rows;
    const rows = parseFdCollectorRows(result.stdout, 65536);
    progress.parser = NativeFdQualificationParser.None;
    measured.collectorMs = Math.max(measured.collectorMs, Math.ceil(performance.now() - began));
    measured.outputBytes = Math.max(measured.outputBytes, Buffer.byteLength(result.stdout)); measured.rows = Math.max(measured.rows, rows.size);
    assert.equal(pin(ss.path).sha256, ss.sha256); return rows;
  };
  const sock = (target: string): string => {
    const match = /^socket:\[([1-9][0-9]*)\]$/.exec(target); assert(match && BigInt(match[1]!) <= 4294967295n); return match[1]!;
  };
  const observations: unknown[] = [], snapshots: { uid: 0 | 65532; observation: ReturnType<typeof observeHostedFdProcess> }[] = [];
  for (const uid of [0, 65532] as const) {
    progress.phase = NativeFdQualificationPhase.UidObservation; progress.uid = uid;
    const began = performance.now(), before = new Set(hostedFdTable(process.pid).filter(row => row.socket).map(row => sock(row.target)));
    const args = ["--experimental-strip-types", runtime + "/scripts/dependency-retention-os-test/common.ts", "fd-qualification"];
    const child = uid === 0 ? spawn(node, args, { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] }) :
      spawn("/usr/bin/setpriv", ["--reuid=65532", "--regid=65532", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
        "--bounding-set=-all", "--no-new-privs", node, ...args], { env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "close"); let birth: string | undefined;
    child.stdin.on("error", () => {}); child.stderr.resume();
    try {
      await boundedWait(new Promise<void>((resolve, reject) => {
        let ready = "";
        child.stdout.on("data", (chunk: Buffer) => { ready += chunk.toString("ascii");
          if (ready.length > 64 || !"TEST_fd_waiting\n".startsWith(ready)) reject(new Error("TEST fd waiting marker invalid"));
          else if (ready === "TEST_fd_waiting\n") resolve(); });
        child.once("error", reject); child.once("exit", () => reject(new Error("TEST fd child exited before observation")));
      }), 10000);
      assert(child.pid); const actual = observeHostedFdProcess(child.pid); birth = actual.birth;
      const status = boundedProc("/proc/" + child.pid + "/status", 16384);
      assert.match(status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
      assert.match(status, new RegExp(`^Gid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
      assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Seccomp:\s+2$/m);
      assert(!actual.descriptors.some(row => row.target === "anon_inode:[io_uring]"));
      if (uid === 65532) {
        for (const kind of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.match(status, new RegExp(`^${kind}:\\s+0+$`, "m"));
        assert.match(status, /^NoNewPrivs:\s+1$/m);
        assert.match(status, /^Groups:\s*$/m);
      } else {
        for (const [set, value] of Object.entries(capabilitySets)) assert.match(status, new RegExp(`^Cap${set}:\\s+${value}$`, "m"));
      }
      const namespaces = { user: readlinkSync(`/proc/${child.pid}/ns/user`), mnt: readlinkSync(`/proc/${child.pid}/ns/mnt`),
        pid: readlinkSync(`/proc/${child.pid}/ns/pid`), net: actual.net };
      for (const kind of ["user", "mnt", "pid", "net"] as const) assert.equal(namespaces[kind], readlinkSync("/proc/self/ns/" + kind));
      assert.equal(actual.exe, node); assert.equal(actual.net, readlinkSync("/proc/self/ns/net"));
      assert.equal(actual.group, observedProcessCgroup(boundedProc("/proc/self/cgroup", 4096)));
      const peerRows = query(), parent = hostedFdTable(process.pid), pairs: { fd: number; parent: string; child: string }[] = [];
      for (const fd of [0, 1, 2]) {
        const target = actual.descriptors.find(row => row.fd === fd); assert(target?.socket);
        const remote = sock(target.target), local = knownFdCollectorPeer(peerRows, remote); assert(local && !before.has(local));
        assert.equal(knownFdCollectorPeer(peerRows, local), remote);
        assert.equal(parent.filter(row => row.socket && sock(row.target) === local).length, 1); pairs.push({ fd, parent: local, child: remote });
      }
      assert.equal(new Set(pairs.flatMap(row => [row.parent, row.child])).size, 6);
      const count = (test: (target: string, character: boolean, pipe: boolean) => boolean) => actual.descriptors.filter(row => row.fd > 2 && test(row.target, row.character, row.pipe)).length;
      measured.eventPoll = Math.max(measured.eventPoll, count(target => target === "anon_inode:[eventpoll]"));
      measured.eventFd = Math.max(measured.eventFd, count(target => target === "anon_inode:[eventfd]"));
      measured.pipes = Math.max(measured.pipes, count((_target, _char, pipe) => pipe));
      measured.devNull = Math.max(measured.devNull, count((_target, character) => character));
      measured.setupMs = Math.max(measured.setupMs, Math.ceil(performance.now() - began));
      const next = observeHostedFdProcess(child.pid); assert.equal(next.birth, birth);
      assert.deepEqual(next.descriptors, actual.descriptors);
      const nextRows = query(); for (const pair of pairs) { assert.equal(knownFdCollectorPeer(nextRows, pair.parent), pair.child); assert.equal(knownFdCollectorPeer(nextRows, pair.child), pair.parent); }
      observations.push({ uid, pid: child.pid, birth, namespaces, group: actual.group, pairs,
        droppedCapabilitiesAndNoNewPrivsObserved: uid === 65532,
        descriptors: actual.descriptors.map(row => ({ fd: row.fd, target: row.target, flags: row.flags, rdev: row.rdev })) });
      snapshots.push({ uid, observation: actual });
      progress.phase = NativeFdQualificationPhase.NamedSockets;
      await qualifyNamedSockets(query, pairs[0]!.parent, pairs[0]!.child, sock);
    } finally {
      child.stdin.end();
      try { const [code, signal] = await boundedWait(exited, 2000); assert.equal(code, 0); assert.equal(signal, null); }
      catch (error) {
        // Exact retained child only. Unobservable identity stays unresolved and
        // the outer owned service performs its normal final cleanup.
        if (child.pid && birth && child.exitCode === null && observeHostedFdProcess(child.pid).birth === birth) child.kill("SIGTERM");
        throw error;
      }
    }
    progress.completedUidObservations++;
  }
  progress.uid = null; progress.phase = NativeFdQualificationPhase.Profile;
  // Include actual immutable toolchain discovery and both native observations,
  // rather than projecting a complete manager setup from one cheap Node spawn.
  measured.setupMs = Math.max(measured.setupMs, Math.ceil(performance.now() - qualificationBegan));
  const headroom = (value: number, maximum: number, floor = 1): number => {
    assert(value <= maximum && floor <= maximum, "TEST measured fd profile exceeds closed bounds");
    return Math.min(maximum, Math.max(floor, value * 4 + 2));
  };
  const collectorTimeoutMs = headroom(measured.collectorMs, 5000, 250);
  const profileInput = { schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed, ss, node: nodePin, wrappers, bootstraps,
    limits: { setupTimeoutMs: Math.max(collectorTimeoutMs, headroom(measured.setupMs, 60000, 1000)), collectorTimeoutMs,
      maxOutputBytes: headroom(measured.outputBytes, 4 * 1024 * 1024, 4096), maxRows: headroom(measured.rows, 65536, 16),
      maxBufferedInputBytes: headroom(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, env: cleanEnv })), 4 * 1024 * 1024, 4096),
      maxEventPoll: headroom(measured.eventPoll, 8), maxEventFd: headroom(measured.eventFd, 8),
      maxPipeEndpoints: headroom(measured.pipes, 32), maxDevNullReserves: headroom(measured.devNull, 8) } };
  progress.profileInput = { ssElfFiles: ss.elfFiles.length, nodeElfFiles: nodePin.elfFiles.length,
    wrapperElfFiles: wrappers.map(pin => pin.elfFiles.length), bootstrapCount: bootstraps.length, limits: { ...profileInput.limits } };
  progress.parser = NativeFdQualificationParser.Profile;
  const profile = parseFdCollectorProfile(profileInput);
  progress.parser = NativeFdQualificationParser.None; progress.phase = NativeFdQualificationPhase.Internals;
  for (const [snapshotOrdinal, { uid, observation: snapshot }] of snapshots.entries()) {
    progress.uid = uid;
    progress.internalsInput = { snapshotOrdinal, ...nativeFdInternalsInputFacts(snapshot) };
    // Positive classification uses the real production contract, not a copied
    // fixture decision. Processes have drained, so retain their actual snapshots.
    assertHostedFdInternals(snapshot, profile);
  }
  delete progress.internalsInput; progress.uid = null;
  progress.phase = NativeFdQualificationPhase.ExtraSocket;
  for (const file of pythonPin.elfFiles) assert.deepEqual(pin(file.path), file);
  const extraDescriptorDenial = await qualifyExtraSocketDenial(profile, pythonPin);
  for (const file of pythonPin.elfFiles) assert.deepEqual(pin(file.path), file);
  progress.phase = NativeFdQualificationPhase.DirectBusSocket;
  const directBusDescriptorDenial = await qualifyExtraSocketDenial(profile, pythonPin, SYSTEM_BUS_ENDPOINT);
  for (const file of pythonPin.elfFiles) assert.deepEqual(pin(file.path), file);
  progress.phase = NativeFdQualificationPhase.FinalPins;
  for (const executable of [ss, nodePin, gitPin, ...wrappers, pythonPin]) for (const file of executable.elfFiles) assert.equal(pin(file.path).sha256, file.sha256);
  progress.phase = NativeFdQualificationPhase.Publication;
  assert(!existsSync(fdCollectorProfilePath)); json(fdCollectorProfilePath, profile);
  const profilePin = { path: fdCollectorProfilePath, sha256: fileDigest(fdCollectorProfilePath) };
  evidence.fdCollectorQualification = { package: ssPackages[0], profilePin, profile, measured, observations, extraDescriptorDenial, directBusDescriptorDenial,
    observer: { net: readlinkSync("/proc/self/ns/net"), user: readlinkSync("/proc/self/ns/user"),
      effectiveCapabilities: /^CapEff:\s+([a-f0-9]+)$/m.exec(boundedProc("/proc/self/status", 16384))?.[1] },
    scope: "actual retained native pairs and cross UID proc access; each production route must reprove before payload" };
  progress.phase = NativeFdQualificationPhase.Complete;
  assertHostedDependencyRootGitProfile(rootGit, remainingPins);
  return { collectorProfile:profilePin, rootGit };
}

/** Detached numeric TEST inputs only; no release/classification decision or IO. */

function nativeFdInternalsInputFacts(snapshot: ReturnType<typeof observeHostedFdProcess>) {
  const KnownAnonymousKind = {
    Unknown: 0, EventPoll: 1, EventFd: 2, IoUring: 3,
  } as const;
  type KnownAnonymousKind = (typeof KnownAnonymousKind)[keyof typeof KnownAnonymousKind];
  const knownAnonymousKind = (target: string): KnownAnonymousKind =>
    target === "anon_inode:[eventpoll]" ? KnownAnonymousKind.EventPoll :
    target === "anon_inode:[eventfd]" ? KnownAnonymousKind.EventFd :
    target === "anon_inode:[io_uring]" ? KnownAnonymousKind.IoUring : KnownAnonymousKind.Unknown;
  const inspected = snapshot.descriptors.filter(fd => fd.fd > 2);
  return { inspectedCount: inspected.length, omittedCount: Math.max(0, inspected.length - 256),
    complete: inspected.length <= 256,
    descriptors: inspected.slice(0, 256).map(fd => ({ fd: fd.fd,
      cloexec: fd.flags & 0o2000000 ? 1 : 0, pathOnly: fd.flags & 0o10000000 ? 1 : 0,
      accessMode: fd.flags & 3, socket: fd.socket ? 1 : 0, pipe: fd.pipe ? 1 : 0,
      character: fd.character ? 1 : 0, file: fd.file ? 1 : 0, directory: fd.directory ? 1 : 0,
      eventPollTarget: fd.target === "anon_inode:[eventpoll]" ? 1 : 0,
      eventFdTarget: fd.target === "anon_inode:[eventfd]" ? 1 : 0,
      knownAnonymousKind: knownAnonymousKind(fd.target),
      pipeTarget: /^pipe:\[[1-9][0-9]*\]$/.test(fd.target) ? 1 : 0,
      devNullDevice: fd.rdev === "259" ? 1 : 0 })) };
}

/** Only numeric classifications of an already bounded TEST collector output.
 * No raw row, token, name, inode, address or hash leaves this summary. */
function nativeFdRowsInputFacts(text: string) {
  const columns = Array<number>(8).fill(0), inodeShapes = { positive: 0, negative: 0, zero: 0, nonCanonical: 0, outOfRange: 0 };
  let rows = 0, start = 0, blankRows = 0, localNotStar = 0, peerNotStar = 0, nonCanonicalQueues = 0, localZero = 0, peerZero = 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let at = 0; text.length > 0 && at <= end; at++) {
    if (at < end && text[at] !== "\n") continue;
    rows++; const rowStart = start; start = at + 1;
    if (rows > 65536) continue; // Detailed row classification stays within the original row bound.
    const row = text.slice(rowStart, at);
    if (!row.trim()) { blankRows++; continue; }
    const fields = row.trim().split(/[\t ]+/), bucket = Math.min(fields.length, 7);
    columns[bucket] = (columns[bucket] ?? 0) + 1;
    if (fields.length !== 6) continue;
    if (fields[2] !== "*") localNotStar++; if (fields[4] !== "*") peerNotStar++;
    if (!fields.slice(0, 2).every(token => /^(?:0|[1-9][0-9]{0,9})$/.test(token) && Number(token) <= 4294967295)) nonCanonicalQueues++;
    if (fields[3] === "0") localZero++; if (fields[5] === "0") peerZero++;
    for (const token of [fields[3]!, fields[5]!]) {
      if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(token)) inodeShapes.nonCanonical++;
      else { const value = Number(token);
        if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) inodeShapes.outOfRange++;
        else if (value === 0) inodeShapes.zero++;
        else if (value < 0) inodeShapes.negative++; else inodeShapes.positive++;
      }
    }
  }
  return { bytes: Buffer.byteLength(text), rows, classifiedRows: Math.min(rows, 65536), omittedRows: Math.max(0, rows - 65536),
    blankRows, columns, localNotStar, peerNotStar, nonCanonicalQueues, inodeShapes, localZero, peerZero,
    nonPrintableAscii: !/^[\x09\x0a\x20-\x7e]*$/.test(text) };
}


async function qualifyExtraSocketDenial(profile: FdCollectorProfile, python: FdExecutablePin, directEndpoint?: typeof SYSTEM_BUS_ENDPOINT) {
  assert.equal(python.path, "/usr/bin/python3.12");
  // Node startup reinstates CLOEXEC. This finite child clears fd3 after its own
  // startup and stays idle for the trusted parent's actual proc observation.
  const program = `import os
if os.__spec__.origin != "frozen" or any(getattr(os, name).__module__ != "posix" for name in ("fstat", "set_inheritable", "get_inheritable", "read", "write")):
    os._exit(70)
if os.fstat(3).st_mode & 0o170000 != 0o140000:
    os._exit(70)
os.set_inheritable(3, True)
if not os.get_inheritable(3):
    os._exit(70)
ready = b"TEST_fd_waiting\\n"
if os.write(1, ready) != len(ready):
    os._exit(70)
data = b""
while True:
    chunk = os.read(0, 33 - len(data))
    if not chunk:
        break
    data += chunk
    if len(data) > 32:
        os._exit(70)
if data:
    if data != b"TEST_fd_release\\n":
        os._exit(70)
    marker = b"TEST_fd_payload_executed\\n"
    if os.write(1, marker) != len(marker):
        os._exit(70)
`;
  const socketPath = "/run/TEST-fd-extra-" + randomUUID(), server = createServer();
  let client: Socket | undefined, accepted: Socket | undefined;
  try {
    if (directEndpoint) {
      const stat = lstatSync(directEndpoint); assert(stat.isSocket() && stat.uid === 0 && (stat.mode & 0o777) === 0o600);
      client = createConnection(directEndpoint); client.on("error", () => {}); client.on("data", () => {});
    } else {
      server.listen(socketPath); await boundedWait(once(server, "listening"), 2000);
      const connection = once(server, "connection"); client = createConnection(socketPath);
      const [socket] = await boundedWait(connection, 2000); accepted = socket as Socket;
    }
    await boundedWait(client.readyState === "open" ? Promise.resolve() : once(client, "connect").then(() => {}), 2000);
    const child = spawn("/usr/bin/setpriv", ["--reuid=65532", "--regid=65532", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
      "--bounding-set=-all", "--no-new-privs", python.path, "-I", "-S", "-c", program],
      { env: cleanEnv, stdio: ["pipe", "pipe", "pipe", client] });
    assert(child.stdin && child.stdout && child.stderr);
    const exited = once(child, "close"); let output = "", birth: string | undefined;
    child.stdin.on("error", () => {}); child.stderr.resume();
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("ascii"); assert(output.length <= 128); });
    try {
      await boundedWait(new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", () => { if (output === "TEST_fd_waiting\n") resolve(); });
        child.once("error", reject); child.once("exit", () => reject(new Error("TEST extra fd child exited")));
      }), 10000);
      assert(child.pid); const actual = observeHostedFdProcess(child.pid); birth = actual.birth;
      assert.equal(actual.exe, python.path); assert.deepEqual(actual.argv, [python.path, "-I", "-S", "-c", program]);
      assert.match(boundedProc("/proc/" + child.pid + "/status", 16384), /^Uid:\s+65532\s+65532\s+65532\s+65532$/m);
      const inherited = actual.descriptors.find(fd => fd.fd === 3); assert(inherited?.socket);
      assert.equal(inherited.flags & 0o2000000, 0, "TEST must actually clear inherited CLOEXEC");
      let denied = false;
      try { assertHostedFdInternals(actual, profile); }
      catch (error) { assert(error instanceof Error && error.message === "hosted_fd_boundary_unresolved"); denied = true; }
      // If the boundary regresses, the real waiting child gets data and executes
      // its bounded TEST marker. No mock descriptor or fake permit is involved.
      if (!denied) child.stdin.write("TEST_fd_release\n");
      child.stdin.end(); const [code, signal] = await boundedWait(exited, 2000);
      assert.equal(code, 0); assert.equal(signal, null); assert(denied, "TEST inherited socket reached payload release");
      assert.equal(output, "TEST_fd_waiting\n", "TEST extra descriptor denial failed before payload");
      return { uid: 65532, pid: child.pid, birth, fd: 3, target: inherited.target, flags: inherited.flags,
        endpoint: directEndpoint ?? socketPath, outcome: "production_internal_boundary_denied_before_TEST_payload",
        limitation: directEndpoint ? "actual direct guest daemon FD3 denial; no daemon sent-byte trace or managed-positive claim" : "plain waiting TEST internal-boundary denial" };
    } finally {
      child.stdin.end();
      if (child.pid && birth && child.exitCode === null && observeHostedFdProcess(child.pid).birth === birth) child.kill("SIGTERM");
      if (child.exitCode === null) await boundedWait(exited, 2000);
    }
  } finally {
    client?.destroy(); accepted?.destroy();
    if (server.listening) await boundedWait(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000);
  }
}


async function boundedWait<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("TEST owned fd observation deadline")), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

async function qualifyNamedSockets(query: () => ReadonlyMap<string, FdCollectorPeer>, local: string, peer: string, sock: (target: string) => string): Promise<void> {
  const directoryPath = "/run/TEST-fd-" + randomUUID(); directory(directoryPath);
  for (const name of [directoryPath + "/named\n0 0 * " + local + " * " + peer,
    "\0TEST-fd-" + randomUUID() + "\n0 0 * " + local + " * " + peer, directoryPath + "/*"]) {
    const server = createServer(); let accepted: Socket | undefined, client: Socket | undefined;
    try {
      server.listen(name); await boundedWait(once(server, "listening"), 2000);
      const previous = new Set(hostedFdTable(process.pid).filter(row => row.socket).map(row => sock(row.target)));
      const connection = once(server, "connection"); client = createConnection(name);
      const [socket] = await boundedWait(connection, 2000); accepted = socket as Socket;
      await boundedWait(client.readyState === "open" ? Promise.resolve() : once(client, "connect").then(() => {}), 2000);
      const created = hostedFdTable(process.pid).filter(row => row.socket && !previous.has(sock(row.target))).map(row => sock(row.target));
      assert.equal(created.length, 2);
      const rows = query(); assert.equal(knownFdCollectorPeer(rows, local), peer); assert.equal(knownFdCollectorPeer(rows, peer), local);
      assert(created.some(inode => !rows.has(inode)), "TEST named local socket bypassed empty-address filter");
      assert(!created.some(inode => knownFdCollectorPeer(rows, knownFdCollectorPeer(rows, inode) ?? "") === inode), "TEST named peer gained reciprocal authority");
    } finally {
      client?.destroy(); accepted?.destroy();
      if (server.listening) await boundedWait(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 2000);
    }
  }
}


export async function issueActualSystemBusInfrastructure(evidence: Record<string, unknown>): Promise<SystemBusInfrastructure> {
  // The original 20-second acquisition allowance now covers signed pin IO,
  // linkage discovery, every query and final observation, without child resets.
  const deadline = process.hrtime.bigint() + 20_000_000_000n;
  const remainingMs = () => {
    const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    assert(Number.isSafeInteger(remaining) && remaining > 0, "TEST genuine system bus setup allowance exhausted"); return remaining;
  };
  remainingMs();
  const pinPath = runtime + "/os-signed-elf-pins.json", beforePins = lstatSync(pinPath);
  assert(beforePins.isFile() && !beforePins.isSymbolicLink() && beforePins.uid === 0 && beforePins.nlink === 1 && (beforePins.mode & 0o777) === 0o600);
  const pinBytes = Buffer.from(boundedProc(pinPath, 256 * 1024));
  const afterPins = lstatSync(pinPath);
  assert(beforePins.dev === afterPins.dev && beforePins.ino === afterPins.ino && beforePins.size === afterPins.size &&
    beforePins.ctimeMs === afterPins.ctimeMs && beforePins.mtimeMs === afterPins.mtimeMs && pinBytes.length === beforePins.size);
  const extraction = JSON.parse(pinBytes.toString("utf8")) as { schemaVersion: number; pins: SystemBusFilePin[] };
  assert.equal(extraction.schemaVersion, 1); assert(Array.isArray(extraction.pins) && extraction.pins.length <= 1024);
  const signed = new Map(extraction.pins.map(pin => {
    assert(([SYSTEM_BUS_EXECUTABLE, "/usr/bin/ss", "/usr/bin/setpriv", hostedDependencySystemdRunExecutable, "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/systemctl", "/usr/bin/busctl", "/usr/bin/python3.12", "/usr/bin/git"].includes(pin.path) || pin.path.startsWith("/usr/lib/")) && /^[a-f0-9]{64}$/.test(pin.sha256));
    return [pin.path, pin.sha256] as const;
  }));
  assert.equal(signed.size, extraction.pins.length);
  remainingMs();
  let queryBytes = 0;
  const queryPin = (path: string, executable = false): SystemBusFilePin => {
    remainingMs(); assert.equal(realpathSync(path), path);
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const stat = lstatSync(parent); remainingMs();
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
      if (parent === "/") break;
    }
    const expected = signed.get(path); assert(expected);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), entry = lstatSync(path);
      assert(before.isFile() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022) &&
        (!executable || (before.mode & 0o111)) && before.size >= 20 && before.size <= 32 * 1024 * 1024 &&
        (queryBytes += before.size) <= 256 * 1024 * 1024 && entry.dev === before.dev && entry.ino === before.ino);
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { remainingMs(); const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break; length += count; remainingMs(); }
      assert.equal(length, before.size);
      assert(bytes[0] === 127 && bytes.subarray(1, 4).toString() === "ELF" && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62);
      const sha256 = digest(bytes.subarray(0, length)); assert.equal(sha256, expected);
      for (const stat of [fstatSync(fd), lstatSync(path)]) assert(stat.isFile() && stat.uid === 0 && stat.gid === 0 &&
        stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino && stat.mode === before.mode &&
        stat.size === before.size && stat.ctimeMs === before.ctimeMs && stat.mtimeMs === before.mtimeMs);
      remainingMs(); return { path, sha256 };
    } finally { closeSync(fd); }
  };
  // Same trusted signed-ELF -> OS ldd procedure as the existing FD issuer.
  // No busctl execution (including --version) precedes the complete closure.
  const queryExecutable = queryPin("/usr/bin/busctl", true);
  const linkage = spawnSync("/usr/bin/ldd", [queryExecutable.path], { env: cleanEnv, encoding: "utf8",
    timeout: Math.min(2000, remainingMs()), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
  remainingMs(); assert(!linkage.error && linkage.signal === null && linkage.status === 0 && linkage.stderr === "" && !linkage.stdout.includes("not found"));
  const libraries = [...new Set([...linkage.stdout.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)\s+\(/g)].map(row => realpathSync(row[1]!)))].sort();
  assert(libraries.length > 0 && libraries.length <= 32 && libraries.every(path => path.startsWith("/usr/lib/")));
  const queryTool: SystemBusQueryTool = { path: "/usr/bin/busctl", sha256: queryExecutable.sha256,
    renderer: SystemBusQueryRenderer.Systemd255Terse, elfClosure: [queryExecutable, ...libraries.map(path => queryPin(path))] };
  assertPinnedSystemBusQueryTool(queryTool, remainingMs);
  const version = spawnSync(queryTool.path, ["--version"], { env: cleanEnv, encoding: "utf8",
    timeout: Math.min(2000, remainingMs()), maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
  remainingMs(); assert(!version.error && version.signal === null && version.status === 0 && version.stderr === "" && /^systemd 255(?:[ .(]|$)/.test(version.stdout));
  assertPinnedSystemBusQueryTool(queryTool, remainingMs);
  let registered = false;
  // Preserve the existing bounded name-registration wait, on the fixed bus.
  // Every query uses the SAME remaining allowance and enrolled signed closure.
  while (!registered) {
    assertPinnedSystemBusQueryTool(queryTool, remainingMs);
    const read = spawnSync(queryTool.path, ["--address=unix:path=/run/dbus/system_bus_socket", "--no-pager",
      "--auto-start=no", "--allow-interactive-authorization=no", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", "org.freedesktop.systemd1"],
      { env: cleanEnv, encoding: "utf8", timeout: Math.min(2000, remainingMs()), maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
    remainingMs(); assertPinnedSystemBusQueryTool(queryTool, remainingMs);
    assert(!read.error && read.signal === null, "TEST genuine PID1 system bus registration query uncertain");
    if (read.status === 0) { assert(read.stderr === "" && (read.stdout === "u 1" || read.stdout === "u 1\n")); registered = true; }
    else await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs())));
  }
  remainingMs();
  const pid = command("/usr/bin/systemctl", ["show", "--property=MainPID", "--value", "--", "dbus.service"], Math.min(2000, remainingMs())).trim();
  remainingMs();
  assert(/^[1-9][0-9]{0,9}$/.test(pid));
  const processBirth = () => {
    const stat = boundedProc("/proc/" + pid + "/stat", 4096), at = stat.lastIndexOf(") ");
    assert(stat.startsWith(pid + " (") && at > 0);
    const fields = stat.slice(at + 2).trim().split(/\s+/); assert.equal(fields[1], "1"); assert(/^[1-9][0-9]*$/.test(fields[19]!));
    return pid + ":" + fields[19];
  };
  const birth = processBirth(); assert.equal(readlinkSync("/proc/" + pid + "/exe"), SYSTEM_BUS_EXECUTABLE);
  assert.equal(observedProcessCgroup(boundedProc("/proc/" + pid + "/cgroup", 4096)), "0::" + SYSTEM_BUS_CONTROL_GROUP);
  const mapped = new Set<string>();
  for (const line of boundedProc("/proc/" + pid + "/maps", 2 * 1024 * 1024).trim().split("\n")) {
    const row = /^[a-f0-9]+-[a-f0-9]+\s+[rwxps-]{4}\s+[a-f0-9]+\s+[a-f0-9]+:[a-f0-9]+\s+[0-9]+(?:\s+(.*))?$/.exec(line); assert(row);
    const path = row[1]; if (!path?.startsWith("/")) continue;
    assert(mapped.size < 64 || mapped.has(path)); assert.equal(realpathSync(path), path); assert(signed.has(path)); mapped.add(path);
  }
  const elfClosure = [...mapped].sort().map(path => {
    const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o022) === 0 && stat.size <= 32 * 1024 * 1024);
    const sha256 = fileDigest(path); assert.equal(sha256, signed.get(path)); return { path, sha256 };
  });
  assert.equal(readFileSync(SYSTEM_BUS_CONFIG_PATH, "utf8"), SYSTEM_BUS_CONFIG);
  const serviceFragment = "/etc/systemd/test-units/dbus.service", socketFragment = "/etc/systemd/test-units/dbus.socket";
  assert.equal(readFileSync(serviceFragment, "utf8"), SYSTEM_BUS_SERVICE_FRAGMENT);
  assert.equal(readFileSync(socketFragment, "utf8"), SYSTEM_BUS_SOCKET_FRAGMENT);
  remainingMs();
  const descriptor = parseSystemBusInfrastructure({ version: 2, role: SystemBusInfrastructureRole.SystemBus,
    service: { name: "dbus.service", controlGroup: SYSTEM_BUS_CONTROL_GROUP, fragmentPath: serviceFragment, fragmentSha256: fileDigest(serviceFragment) },
    socket: { name: "dbus.socket", endpoint: SYSTEM_BUS_ENDPOINT, fragmentPath: socketFragment, fragmentSha256: fileDigest(socketFragment) },
    config: { path: SYSTEM_BUS_CONFIG_PATH, sha256: fileDigest(SYSTEM_BUS_CONFIG_PATH) },
    executable: { path: SYSTEM_BUS_EXECUTABLE, sha256: signed.get(SYSTEM_BUS_EXECUTABLE) }, elfClosure, queryTool });
  const endpoint = lstatSync(SYSTEM_BUS_ENDPOINT); assert(endpoint.isSocket() && endpoint.uid === 0 && (endpoint.mode & 0o777) === 0o600);
  const socketInodes = (processId: string) => {
    const entries = readdirSync("/proc/" + processId + "/fd"); assert(entries.length <= 4096);
    const inodes = new Set<string>();
    for (const name of entries) { assert(/^[0-9]+$/.test(name));
      try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync("/proc/" + processId + "/fd/" + name));
        if (match) inodes.add(match[1]!); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); } }
    return inodes;
  };
  const managerInodes = socketInodes("1"), daemonInodes = socketInodes(pid);
  const listenerRows = boundedProc("/proc/net/unix", 2 * 1024 * 1024).trim().split("\n").slice(1).map(row => row.trim().split(/\s+/))
    .filter(row => /^[a-f0-9]{8}$/.test(row[3] ?? "") && (parseInt(row[3]!, 16) & 0x10000) !== 0 && daemonInodes.has(row[6]!));
  assert.equal(listenerRows.length, 1); const listenerRow = listenerRows[0]!, listener = listenerRow[6]!;
  assert.equal(listenerRow[7], SYSTEM_BUS_ENDPOINT); assert.equal(listenerRow[4], "0001");
  assert.equal(listenerRow[3], "00010000"); assert.equal(listenerRow[5], "01");
  assert(/^[1-9][0-9]*$/.test(listener) && managerInodes.has(listener));
  evidence.systemBus = { descriptor, daemonPidBirth: birth, endpoint: { dev: String(endpoint.dev), ino: String(endpoint.ino), uid: endpoint.uid,
    mode: endpoint.mode & 0o777, listenerInode: listener }, observedManagerPid: 1, extractionPinsSha256: digest(pinBytes) };
  // Execute the real production verifier before issuing any inventory. Its
  // return is not serialized as authority; every later gate verifies again.
  try { verifySystemBusInfrastructure(descriptor, remainingMs); }
  catch (error) {
    const observation: Record<string, unknown> = { purpose: "TEST_post_failure_current_bus_predicates_only", unavailable: true };
    evidence.systemBusRejectedCurrentObservation = observation;
    try {
      // Reuse the existing manager acquisition deadline; telemetry gets no
      // extra budget and never reconstructs the original failing query.
      const until = process.hrtime.bigint() + BigInt(Math.min(remainingMs(), 5000)) * 1000000n;
      const telemetryRemainingMs = () => Number((until - process.hrtime.bigint()) / 1000000n);
      const systemctl = "/usr/bin/systemctl", tool = lstatSync(systemctl);
      assert(tool.isFile() && tool.uid === 0 && tool.nlink === 1 && !(tool.mode & 0o022) && tool.size <= 32 * 1024 * 1024);
      const expectedTool = signed.get(systemctl); assert(expectedTool);
      for (let parent = dirname(systemctl);; parent = dirname(parent)) {
        const stat = lstatSync(parent); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
        if (parent === "/") break;
      }
      assert.equal(realpathSync(systemctl), systemctl); assert.equal(fileDigest(systemctl), expectedTool);
      const current = () => {
        assert(telemetryRemainingMs() > 0); assert.equal(processBirth(), birth);
        for (const name of ["user", "mnt", "pid", "net"] as const)
          assert.equal(readlinkSync(`/proc/self/ns/${name}`), readlinkSync(`/proc/1/ns/${name}`));
        const now = lstatSync(systemctl), socket = lstatSync(SYSTEM_BUS_ENDPOINT);
        assert(now.isFile() && now.uid === 0 && now.nlink === 1 && !(now.mode & 0o022) &&
          now.dev === tool.dev && now.ino === tool.ino && now.size === tool.size && now.ctimeMs === tool.ctimeMs && now.mtimeMs === tool.mtimeMs);
        assert.equal(fileDigest(systemctl), expectedTool);
        assert(socket.isSocket() && socket.uid === 0 && (socket.mode & 0o777) === 0o600 && socket.dev === endpoint.dev && socket.ino === endpoint.ino);
        assert(telemetryRemainingMs() > 0);
      };
      const common = ["Id", "Names", "LoadState", "ActiveState", "SubState", "FragmentPath", "DropInPaths", "Job"] as const;
      const queries = [
        { unit: "dbus.service", keys: [...common, "ControlGroup", "MainPID", "ExecStart", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost", "Environment", "EnvironmentFiles", "User", "Group", "Restart", "Type", "TriggeredBy"] },
        { unit: "dbus.socket", keys: [...common, "Listen", "Accept", "Triggers", "SocketMode", "DirectoryMode", "RemoveOnStop"] },
      ] as const;
      const facts = [];
      for (const query of queries) {
        current(); const allowance = telemetryRemainingMs(); assert(allowance > 0);
        const read = spawnSync(systemctl, ["show", `--property=${query.keys.join(",")}`, "--", query.unit],
          { env: cleanEnv, encoding: "utf8", timeout: Math.min(2000, allowance), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
        assert(!read.error && read.status === 0 && read.signal === null); current();
        const values: Record<string, string> = {}, rows = read.stdout.trim().split("\n"); assert(rows.length <= 64);
        let unknown = 0, duplicates = 0;
        for (const row of rows) {
          const at = row.indexOf("="), key = row.slice(0, at); assert(at > 0);
          if (!query.keys.some(known => known === key)) { unknown++; continue; }
          if (Object.hasOwn(values, key)) duplicates++;
          values[key] = row.slice(at + 1);
        }
        const checks: Record<string, boolean> = { exactKeys: unknown === 0 && duplicates === 0 && Object.keys(values).length === query.keys.length,
          Id: values.Id === query.unit, Names: values.Names === query.unit, LoadState: values.LoadState === "loaded",
          ActiveState: values.ActiveState === "active", SubState: values.SubState === "running", DropInPaths: values.DropInPaths === "", Job: values.Job === "" };
        if (query.unit === "dbus.service") {
          const exec = /^\{ path=([^;]+) ; argv\[\]=(.*?) ; ignore_errors=no ; [^{}]*\}$/.exec(values.ExecStart ?? "");
          Object.assign(checks, { FragmentPath: values.FragmentPath === serviceFragment, ControlGroup: values.ControlGroup === SYSTEM_BUS_CONTROL_GROUP,
            MainPID: /^[1-9][0-9]{0,9}$/.test(values.MainPID ?? ""), User: values.User === "", Group: values.Group === "",
            Restart: values.Restart === "no", Type: values.Type === "notify", TriggeredBy: values.TriggeredBy === "dbus.socket",
            ExecStart: !!exec && exec[1] === SYSTEM_BUS_EXECUTABLE && exec[2] === [SYSTEM_BUS_EXECUTABLE, ...SYSTEM_BUS_ARGUMENTS].join(" ") });
          for (const key of ["ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost", "Environment", "EnvironmentFiles"] as const) checks[key] = values[key] === "";
        } else Object.assign(checks, { FragmentPath: values.FragmentPath === socketFragment, Listen: values.Listen === `${SYSTEM_BUS_ENDPOINT} (Stream)`,
          Accept: values.Accept === "no", Triggers: values.Triggers === "dbus.service", SocketMode: values.SocketMode === "0600",
          DirectoryMode: values.DirectoryMode === "0755", RemoveOnStop: values.RemoveOnStop === "yes" });
        facts.push({ unit: query.unit, checks, missingKnownFields: query.keys.filter(key => !Object.hasOwn(values, key)), unknownFields: unknown, duplicates });
      }
      current(); observation.unavailable = false; observation.units = facts;
    } catch { /* Only closed unavailable telemetry; preserve the real rejection. */ }
    throw error;
  }
  remainingMs(); assert.equal(processBirth(), birth);
  const typedEmptyArrays = observeSystemdServiceEmptyArrays(queryTool, "dbus.service", SystemdServiceArrayKind.Infrastructure, remainingMs);
  assertTypedEmptyArrays(typedEmptyArrays, false);
  assert.equal(processBirth(), birth);
  const currentEndpoint = lstatSync(SYSTEM_BUS_ENDPOINT);
  assert(currentEndpoint.isSocket() && currentEndpoint.uid === 0 && (currentEndpoint.mode & 0o777) === 0o600 &&
    currentEndpoint.dev === endpoint.dev && currentEndpoint.ino === endpoint.ino);
  remainingMs();
  evidence.systemBusTypedEmptyArrays = { purpose: "TEST_actual_fixed_bus_service_facts_not_inventory_authority", facts: typedEmptyArrays };
  return descriptor;
}

function assertTypedEmptyArrays(facts: readonly SystemdEmptyArrayFact[], managed: boolean): void {
  // Independent expected native contract; never create or fill measured facts.
  const names = managed ? ["ExecCondition", "ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost", "EnvironmentFiles"] :
    ["ExecStartPre", "ExecStartPost", "ExecReload", "ExecStop", "ExecStopPost", "EnvironmentFiles"];
  assert.deepEqual(facts, names.map(property => ({ property, signature: property === "EnvironmentFiles" ? "a(sb)" : "a(sasbttttuii)", count: 0 })));
}
function boundedProc(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const buffer = Buffer.alloc(max + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    assert(length <= max); return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
  finally { closeSync(fd); }
}


export function actualToolchainProfile(rootGit: HostedDependencyRootGitProfile): HostedDependencyInstallerProfile {
  assert.equal(realpathSync(process.execPath), node);
  const npmRootPath = runtime + "/toolchain/lib/node_modules/npm", npmCliPath = npmRootPath + "/bin/npm-cli.js";
  const toolRoots = actualLibraries(node);
  // Production validates canonical root ownership and bytes BEFORE execution.
  const helperSha256 = hostedDependencyInstallerDropperSha256();
  assert.equal(command("/usr/bin/setpriv", ["--version"]).trim(), "setpriv from util-linux 2.39.3");
  const privilegeDropper: HostedDependencyInstallerProfile["privilegeDropper"] = { path: "/usr/bin/setpriv", version: "2.39.3",
    sha256: helperSha256, libraries: actualLibraries("/usr/bin/setpriv") };
  assert.equal(hostedDependencyInstallerDropperSha256(), helperSha256);
  const libc = toolRoots.find(row => /\/libc\.so\.[0-9]+$/.test(row.path)); assert(libc);
  const version = /^glibc\s+([0-9]+\.[0-9]+)\s*$/.exec(command("/usr/bin/getconf", ["GNU_LIBC_VERSION"]))?.[1]; assert(version);
  return { schemaVersion: 2, rootGit, platform: "linux", arch: DependencyInstallArchitecture.X64, nodePath: node,
    nodeSha256: fileDigest(node), nodeVersion: process.version, nodeAbi: process.versions.modules,
    npmCliPath, npmSha256: fileDigest(npmCliPath), npmVersion: command(node, [npmCliPath, "--version"]).trim(), npmRootPath,
    npmRootSha256: hostedDependencyInstallerNpmRootSha256(npmRootPath), toolRoots, networkInputs: issueOwnedNetworkInputs(), privilegeDropper,
    recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
    libc: { family: DependencyLibcFamily.Glibc, version, path: libc.path, sha256: libc.sha256 } };
}
function actualLibraries(executable: string, remaining?: () => number): HostedDependencyInstallerProfile["toolRoots"] {
  const output = command("/usr/bin/ldd", [executable], Math.min(30000, remaining?.() ?? 30000));
  remaining?.(); assert(!output.includes("not found"));
  const paths = [...new Set([...output.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)\s+\(/g)].map(m => realpathSync(m[1]!)))].sort();
  assert(paths.length > 0 && paths.length <= 32);
  return paths.map(path => { assert(path.startsWith("/usr/lib/")); return { path, kind: DependencyToolRootKind.File as const, sha256: fileDigest(path) }; });
}
function issueOwnedNetworkInputs(): HostedDependencyInstallerProfile["networkInputs"] {
  directory(hostedDependencyInstallerNetworkRoot);
  const capture = (name: HostedDependencyInstallerNetworkInput): string => {
    // Assembly owns these exact regular files. No alias/OS service mutation is
    // required; data is read through a bounded stable FD, never as authority.
    const path = "/etc/" + name; assert.equal(realpathSync(path), path);
    const before = lstatSync(path, { bigint: true });
    assert(before.isFile() && before.uid === 0n && before.nlink === 1n && before.size > 0n && before.size <= 65536n);
    const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(65537), opened = fstatSync(input, { bigint: true });
      const count = readSync(input, buffer, 0, buffer.length, 0);
      for (const stat of [opened, fstatSync(input, { bigint: true }), lstatSync(path, { bigint: true })])
        assert(stat.isFile() && stat.nlink === 1n && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
          stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
      assert.equal(BigInt(count), before.size); bytes = buffer.subarray(0, count);
    } finally { closeSync(input); }
    const output = openSync(hostedDependencyInstallerNetworkRoot + "/" + name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
    return digest(bytes);
  };
  const pins = { [HostedDependencyInstallerNetworkInput.Hosts]: capture(HostedDependencyInstallerNetworkInput.Hosts),
    [HostedDependencyInstallerNetworkInput.Resolver]: capture(HostedDependencyInstallerNetworkInput.Resolver),
    [HostedDependencyInstallerNetworkInput.NameService]: capture(HostedDependencyInstallerNetworkInput.NameService) };
  const parent = openSync(hostedDependencyInstallerNetworkRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return pins;
}
