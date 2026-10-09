import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertResearchProviderCurrentAuthority, assertResearchProviderStartMaterial, readResearchStartBinding, researchCurrentStart } from "./research-launch-admission";
import { researchProviderSetupAllowanceMs } from "./research-launch-contract";
import { assertResearchProviderRootIdentity, assertResearchServiceOwner, researchDescription, researchExecutableDigest, researchProcessIdentity, researchProcessLifetime, researchServiceIdentity } from "./research-launch-host";
import { assertResearchProviderNotCancelled, readResearchProviderReservation } from "./research-launch-lifecycle";
import { researchHash, researchInvalid, researchPath, researchRead } from "./research-launch-files";
import { readKernelMountTable } from "./host-scratch-mount";
import { assertResearchProviderAssemblyContext, readResearchProviderAssemblyRoot, researchProviderProtectedPaths, ResearchRootMountAccess } from "./research-provider-root";

const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const environment = Object.freeze({ PATH: "/usr/bin:/usr/sbin", LANG: "C", LC_ALL: "C" });
const identity = (path: string): string => { const stat = lstatSync(path); return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.rdev].join(":"); };
const descriptorIdentity = (fd: number): string => { const stat = fstatSync(fd); return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.rdev].join(":"); };
const inside = (parent: string, path: string): boolean => path === parent || path.startsWith(parent + "/");
// Linux O_PATH is not exposed by Node's portable constants. It pins a device
// without opening /dev/tty (which fails ENXIO in a headless service).
const linuxPathDescriptor = 0x200000;
const apiDevices = [["null", 1, 3], ["zero", 1, 5], ["full", 1, 7], ["random", 1, 8], ["urandom", 1, 9], ["tty", 5, 0]] as const;
// Static OS glue, never a request recipe. FD3 is the freshly pinned root mount
// in this already private mount namespace, not the skeleton's covered lower FD.
// No new mount namespace is cloned here: an inherited FD would still reference
// the original mount. The trusted supervisor only awaits/signals after pivot.
const pivotRoot = [
  '[ "$#" -ge 2 ] && [ -d /proc/self/fd/3 ] && [ /proc/self/fd/3 -ef "$1" ] || exit 70',
  'for handle in /proc/self/fd/*; do',
  '  case "$handle" in',
  '    /proc/self/fd/0|/proc/self/fd/1|/proc/self/fd/2) [ -p "$handle" ] || [ -S "$handle" ] || exit 70 ;;',
  '    /proc/self/fd/3) ;;',
  '    *) [ ! -e "$handle" ] && [ ! -L "$handle" ] || exit 70 ;;',
  '  esac',
  'done',
  'exec 4>/dev/null || exit 70',
  'cd -P /proc/self/fd/3 2>&4 || exit 70',
  '[ "$PWD" = "$1" ] || exit 70',
  'shift',
  '/usr/sbin/pivot_root . . 2>&4 || exit 70',
  '/usr/bin/umount --no-canonicalize --internal-only --no-mtab --lazy -- . 2>&4 || exit 70',
  'cd / 2>&4 || exit 70',
  'exec 3<&- 4>&- || exit 70',
  'exec "$@"',
].join("\n");
const deviceNumber = (value: number): readonly [number, number] => {
  const device = BigInt(value);
  return [Number((device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n)), Number((device & 0xffn) | (device >> 12n & 0xffffff00n))];
};

/** Fixed concrete transition, shared with the nearest disposable primitive
 * fixture. This is not request configuration or a public launch capability. */
export function researchProviderRootTransition(root: string): Readonly<{ command: string; args: readonly string[] }> {
  researchPath(root);
  return Object.freeze({ command: "/usr/bin/bash", args: Object.freeze(["--noprofile", "--norc", "-p", "-c", pivotRoot, "research-root-pivot", root,
    "/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps",
    "--wd=/", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all",
    "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--"]) });
}

/** Provider-only first-exec adapter. All mount operations occur after the fixed
 * unshare --mount --propagation private prelude; no request supplies a recipe.
 * The creator's skeleton stays unmounted in its independent namespace. */
export async function assembleResearchProviderRoot(jobId: string, unit: string, home: string, seal: string, deadline: number): Promise<number> {
  assertResearchProviderRootIdentity();
  if (!Number.isSafeInteger(deadline) || deadline <= now()) researchInvalid();
  const current = researchCurrentStart(jobId), remaining = deadline - now();
  if (remaining <= 0 || remaining > researchProviderSetupAllowanceMs(current.spec.request)) researchInvalid();
  const reservation = readResearchProviderReservation(current.directory, unit);
  if (reservation.specSha256 !== researchHash(current.bytes)) researchInvalid();
  const service = researchServiceIdentity(unit), own = researchProcessIdentity();
  assertResearchServiceOwner(own, service, reservation.description);
  const binding = readResearchStartBinding(current.directory);
  const bindingBytes = researchRead(join(current.directory, "binding.json"));
  if (binding.specSha256 !== reservation.specSha256 || binding.service.unit !== current.spec.unit) researchInvalid();
  assertResearchServiceOwner(binding.process, binding.service, researchDescription(jobId, reservation.specSha256));
  // Foreign namespace freshness belongs to the full-root creator's transport
  // fences. This role still observes actual PID lifetime and service identity.
  const { namespaces: _runtimeNamespaces, ...runtimeLifetime } = binding.process;
  const assertAuthority = (): void => {
    if (now() >= deadline) researchInvalid();
    const fresh = researchCurrentStart(jobId);
    if (!fresh.bytes.equals(current.bytes) || fresh.directory !== current.directory ||
        JSON.stringify(readResearchStartBinding(current.directory)) !== JSON.stringify(binding) ||
        JSON.stringify(researchProcessLifetime(binding.process.pid)) !== JSON.stringify(runtimeLifetime) ||
        JSON.stringify(researchServiceIdentity(current.spec.unit)) !== JSON.stringify(binding.service) ||
        JSON.stringify(researchProcessIdentity()) !== JSON.stringify(own) || JSON.stringify(researchServiceIdentity(unit)) !== JSON.stringify(service)) researchInvalid();
    assertResearchProviderNotCancelled(current.directory, unit);
  };
  assertAuthority();
  const root = readResearchProviderAssemblyRoot(jobId, unit, home, seal);
  let handoffRoot: number | undefined, child: ReturnType<typeof spawn> | undefined;
  try {
  if (JSON.stringify(root.spec) !== JSON.stringify(current.spec)) researchInvalid();
  assertResearchProviderAssemblyContext(root);
  const finalAuthority = (): void => {
    // Reuse the established grant/closing/shared-policy/root/pin checks after
    // blocking material walks, at each synchronous mount/spawn boundary.
    assertResearchProviderCurrentAuthority(jobId, current, root, bindingBytes);
    assertResearchProviderNotCancelled(current.directory, unit);
    if (now() >= deadline) researchInvalid();
  };
  assertAuthority(); assertResearchProviderStartMaterial(root); assertAuthority(); finalAuthority();
  for (const path of ["/usr/bin/mount", "/usr/bin/bash", "/usr/sbin/pivot_root", "/usr/bin/umount", "/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini"]) researchExecutableDigest(path);
  const check = (): void => { assertAuthority(); root.assertCurrent(); finalAuthority(); };
  const descriptors = new Map<number, Readonly<{ path: string; identity: string }>>([
    [root.rootFd, { path: root.root, identity: descriptorIdentity(root.rootFd) }],
    ...root.bindings.map(entry => [entry.fd, { path: entry.source, identity: descriptorIdentity(entry.fd) }] as const),
  ]);
  const closeTarget = (fd: number): void => { descriptors.delete(fd); closeSync(fd); };
  const command = (args: readonly string[], descriptorsForCommand: readonly number[] = []): void => {
    check();
    for (const fd of descriptorsForCommand) {
      const pinned = descriptors.get(fd);
      if (!pinned || descriptorIdentity(fd) !== pinned.identity || readlinkSync(`/proc/self/fd/${fd}`) !== pinned.path) researchInvalid();
    }
    const result = spawnSync("/usr/bin/mount", ["--no-canonicalize", "--no-mtab", ...args], { cwd: "/", env: environment,
      stdio: ["ignore", "pipe", "pipe", ...descriptorsForCommand], timeout: Math.max(1, deadline - now()), killSignal: "SIGKILL", maxBuffer: 65536 });
    if (result.error || result.signal || result.status !== 0) researchInvalid();
    check();
  };
  const targetFd = (target: string, file: boolean): number => {
    const path = researchPath(join(root.root, target.slice(1)));
    if (!inside(root.root, path) || realpathSync(path) !== path) researchInvalid();
    for (let parent = dirname(path); inside(root.root, parent); parent = dirname(parent)) {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || realpathSync(parent) !== parent) researchInvalid();
      if (parent === root.root) break;
    }
    const fd = openSync(path, linuxPathDescriptor | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if ((file ? !stat.isFile() && !stat.isCharacterDevice() : !stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) ||
          descriptorIdentity(fd) !== identity(path) || readlinkSync(`/proc/self/fd/${fd}`) !== path) researchInvalid();
      descriptors.set(fd, { path, identity: descriptorIdentity(fd) }); return fd;
    } catch (error) { closeTarget(fd); throw error; }
  };
  const mountId = (fd: number): string => {
    const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
    if (!id) researchInvalid(); return id;
  };
  const flags = (fd: number): string[] => {
    const id = mountId(fd);
    const row = readKernelMountTable().trimEnd().split("\n").find(row => row.split(" ")[0] === id);
    if (!row) researchInvalid();
    const fields = row.split(" "), separator = fields.indexOf("-");
    return [...new Set([...fields[5]!.split(","), ...fields[separator + 3]!.split(",")].filter(flag => ["ro", "nosuid", "nodev", "noexec"].includes(flag)))];
  };
  const protectMount = (fd: number, target: string, readOnly: boolean, file: boolean, sourceFlags: readonly string[]): void => {
    if (!readOnly && sourceFlags.includes("ro")) researchInvalid();
    const before = descriptorIdentity(fd), mountedId = mountId(fd);
    command(["-o", [...new Set(["remount", "bind", readOnly ? "ro" : "rw", ...sourceFlags])].join(","), "/proc/self/fd/3"], [fd]);
    const fresh = targetFd(target, file);
    try {
      const observed = flags(fresh);
      if (descriptorIdentity(fd) !== before || descriptorIdentity(fresh) !== before || mountId(fd) !== mountedId || mountId(fresh) !== mountedId ||
          observed.includes("ro") !== readOnly || sourceFlags.some(flag => !observed.includes(flag))) researchInvalid();
    } finally { closeTarget(fresh); }
  };
  const bind = (fd: number, target: string, readOnly: boolean, file: boolean): void => {
    const before = descriptorIdentity(fd), inherited = flags(fd), targetHandle = targetFd(target, file);
    if (!readOnly && inherited.includes("ro")) { closeTarget(targetHandle); researchInvalid(); }
    try { command(["--bind", "/proc/self/fd/3", "/proc/self/fd/4"], [fd, targetHandle]); }
    finally { closeTarget(targetHandle); }
    const mounted = targetFd(target, file);
    try {
      if (descriptorIdentity(mounted) !== before) researchInvalid();
      protectMount(mounted, target, readOnly, file, inherited);
    } finally { closeTarget(mounted); }
  };
  const temporary = (target: string, options: string): void => {
    const fd = targetFd(target, false);
    try { command(["-t", "tmpfs", "-o", options, "tmpfs", "/proc/self/fd/3"], [fd]); } finally { closeTarget(fd); }
  };
    // Nonrecursive self-bind creates only our private root mount. Later target
    // descriptors are opened through that new mount, never the covered lower FD.
    command(["--bind", "/proc/self/fd/3", "/proc/self/fd/3"], [root.rootFd]);
    const temporaryRoots = [["/tmp", "rw,nosuid,nodev,mode=1777,size=256M"], ["/var/tmp", "rw,nosuid,nodev,mode=1777,size=64M"],
      ["/run", "rw,nosuid,nodev,noexec,mode=0755,size=16M"], ["/sys", "ro,nosuid,nodev,noexec,mode=0555,size=1M"], ["/dev", "rw,nosuid,noexec,mode=0755,size=4M"]] as const;
    for (const [path, options] of temporaryRoots) temporary(path, options);
    // tmpfs overlays precede declared binds. Recreate only the finite sealed
    // anchors they covered (notably the admitted resolver leaves under /run).
    for (const entry of root.bindings.filter(entry => temporaryRoots.some(([path]) => inside(path, entry.target)))) {
      const path = join(root.root, entry.target.slice(1)); check();
      mkdirSync(entry.file ? dirname(path) : path, { recursive: true, mode: 0o755 });
      if (entry.file) writeFileSync(path, "", { flag: "wx", mode: 0o644 });
    }
    for (const entry of root.bindings.slice().sort((a, b) => a.target.length - b.target.length || a.target.localeCompare(b.target))) {
      bind(entry.fd, entry.target, entry.access === ResearchRootMountAccess.ReadOnly, entry.file);
    }
    for (const [name, major, minor] of apiDevices) {
      const source = "/dev/" + name, target = join(root.root, "dev", name), info = lstatSync(source);
      if (!info.isCharacterDevice() || info.uid !== 0 || info.nlink !== 1 || realpathSync(source) !== source ||
          JSON.stringify(deviceNumber(info.rdev)) !== JSON.stringify([major, minor])) researchInvalid();
      check(); writeFileSync(target, "", { flag: "wx", mode: 0o666 });
      const fd = openSync(source, linuxPathDescriptor | constants.O_NOFOLLOW);
      try {
        const pinned = fstatSync(fd);
        if (!pinned.isCharacterDevice() || pinned.uid !== 0 || pinned.nlink !== 1 || pinned.dev !== info.dev || pinned.ino !== info.ino ||
            pinned.mode !== info.mode || pinned.gid !== info.gid || pinned.rdev !== info.rdev ||
            JSON.stringify(deviceNumber(pinned.rdev)) !== JSON.stringify([major, minor]) || descriptorIdentity(fd) !== identity(source)) researchInvalid();
        descriptors.set(fd, { path: source, identity: descriptorIdentity(fd) }); bind(fd, "/dev/" + name, true, true);
      } finally { closeTarget(fd); }
    }
    check(); mkdirSync(join(root.root, "dev/shm"), { mode: 0o1777 }); mkdirSync(join(root.root, "dev/pts"), { mode: 0o755 });
    temporary("/dev/shm", "rw,nosuid,nodev,noexec,mode=1777,size=64M");
    const pts = targetFd("/dev/pts", false);
    try { command(["-t", "devpts", "-o", "newinstance,nosuid,noexec,mode=0620,ptmxmode=0666,gid=65532", "devpts", "/proc/self/fd/3"], [pts]); }
    finally { closeTarget(pts); }
    check(); symlinkSync("pts/ptmx", join(root.root, "dev/ptmx"));
    for (const [name, target] of [["fd", "/proc/self/fd"], ["stdin", "fd/0"], ["stdout", "fd/1"], ["stderr", "fd/2"]]) {
      check(); symlinkSync(target!, join(root.root, "dev", name!));
    }
    // Canonical /lib is an admitted alias to /usr/lib; never expose the Host's
    // module tree. Missing fixed leaves need no mask or new skeleton mutation.
    for (const path of ["/usr/lib/modules", "/usr/lib64/modules"]) {
      try { lstatSync(join(root.root, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      temporary(path, "ro,nosuid,nodev,noexec,mode=0000,size=1M");
    }
    const deviceRoot = targetFd("/dev", false);
    try { protectMount(deviceRoot, "/dev", true, false, ["nosuid", "noexec"]); } finally { closeTarget(deviceRoot); }
    // An empty read-only skeleton masks protected leaves; neither /run/user nor
    // arbitrary Host /etc or /var is a source. Check every fixed omission now.
    for (const path of researchProviderProtectedPaths(current.spec.request.authRootDir)) {
      try { lstatSync(join(root.root, path)); researchInvalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const liveRoot = openSync(root.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.set(liveRoot, { path: root.root, identity: descriptorIdentity(liveRoot) });
    try { protectMount(liveRoot, "/", true, false, [...new Set([...flags(liveRoot), "nosuid", "nodev"])]); } finally { closeTarget(liveRoot); }
    handoffRoot = openSync(root.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const mountedId = mountId(handoffRoot), mountedFlags = flags(handoffRoot);
    const row = readKernelMountTable().trimEnd().split("\n").find(line => line.split(" ")[0] === mountedId)?.split(" ");
    if (!row || row.indexOf("-") < 6) researchInvalid();
    if (descriptorIdentity(handoffRoot) !== descriptorIdentity(root.rootFd) || readlinkSync(`/proc/self/fd/${handoffRoot}`) !== root.root ||
        realpathSync(root.root) !== root.root || mountedId === mountId(root.rootFd) || row[4] !== root.root ||
        row.slice(6, row.indexOf("-")).some(field => /^(?:shared|master|propagate_from):/.test(field)) ||
        ["ro", "nosuid", "nodev"].some(flag => !mountedFlags.includes(flag)) || process.cwd() !== "/" ||
        readlinkSync("/proc/self/root") !== "/" || readlinkSync("/proc/self/cwd") !== "/") researchInvalid();
    check();
    assertAuthority(); finalAuthority();
    const transition = researchProviderRootTransition(root.root);
    root.close();
    // Only the mounted root FD3 crosses this trusted transition. The glue
    // detaches the old root and closes FD3 before user mapping or payload exec.
    child = spawn(transition.command, [...transition.args, process.execPath,
      join(current.spec.runtimeDirectory, "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js"), "--research-ready-v1"],
    { cwd: "/", env: environment, stdio: ["inherit", "inherit", "inherit", handoffRoot] });
  } finally { try { root.close(); } finally { if (handoffRoot !== undefined) closeSync(handoffRoot); } }
  if (!child) researchInvalid();
  const payload = child;
  return await new Promise<number>(resolveExit => {
    const terminate = (): void => { payload.kill("SIGKILL"); };
    process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
    const finish = (code: number): void => { process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate); resolveExit(code); };
    payload.once("error", () => finish(70)); payload.once("exit", (code, signal) => finish(signal ? 70 : code ?? 70));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5 || !/^[1-9]\d{0,14}$/.test(args[4]!)) researchInvalid();
    process.exitCode = await assembleResearchProviderRoot(args[0]!, args[1]!, args[2]!, args[3]!, Number(args[4]));
  } catch { process.exitCode = 70; }
}
