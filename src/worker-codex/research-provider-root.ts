import { assertResearchMimoProviderHome } from "./research-launch-admission";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { X509Certificate } from "node:crypto";
import { hostedCodexExecutableReadPath } from "../provider-codex/hosted-codex-permissions";
import { resolvePreparedHostScratchBinds, resolvePreparedHostScratchCacheBinds, type ScratchTempHost } from "./host-scratch-temp";
import { parseResearchStartSpec, type ResearchStartSpec } from "./research-launch-contract";
import { researchAuthorityRoot, researchHash, researchInvalid, researchName, researchPath, researchPublish, researchRead, researchJson, researchRecord } from "./research-launch-files";
import { assertResearchInitialRoot, researchProviderUnitPattern } from "./research-launch-host";
import { researchProviderUnits, readResearchProviderReservation } from "./research-launch-lifecycle";
import { inspectKernelPathBackings, readKernelMountTable } from "./host-scratch-mount";

/** Private finite observations only; never execution authority or error payloads. */
export enum ResearchProviderRootCheck {
  MountTable = "research-provider-root:mountTable", Backing = "research-provider-root:backing",
  Snapshot = "research-provider-root:snapshot", Observe = "research-provider-root:observe",
  Add = "research-provider-root:add", CapturePublic = "research-provider-root:capturePublic",
  CorroborateHome = "research-provider-root:corroborateHome", Accounts = "research-provider-root:validateAccounts",
  CaBundle = "research-provider-root:validateCaBundle", Regular = "research-provider-root:regular",
  SkeletonEntries = "research-provider-root:skeletonEntries", SkeletonIdentity = "research-provider-root:skeletonIdentity",
  Custody = "research-provider-root:rootCustody", Prepare = "research-provider-root:prepareResearchProviderRoot",
  Assert = "research-provider-root:assertResearchProviderRoot",
}
export type ResearchProviderRootTiming = Readonly<{ check: ResearchProviderRootCheck; count: number; inclusiveElapsedMs: number }>;
let rootTimings: Map<ResearchProviderRootCheck, { count: number; inclusiveElapsedMs: number }> | undefined;
/** Synchronous private observations; neither the callback nor timing failures affect the root operation. */
export function captureResearchProviderRootTiming<T>(operation: () => T,
  receive: (checks: readonly ResearchProviderRootTiming[]) => void): T {
  const previous = rootTimings;
  const timings = new Map(Object.values(ResearchProviderRootCheck).map(check => [check, { count: 0, inclusiveElapsedMs: 0 }] as const));
  rootTimings = timings;
  try { return operation(); }
  finally {
    rootTimings = previous;
    try { receive([...timings].map(([check, value]) => ({ check, ...value }))); } catch { /* Observation only. */ }
  }
}
const rootFailureChecks = new WeakMap<object, ResearchProviderRootCheck>();
export function researchProviderRootFailureCheck(error: unknown): ResearchProviderRootCheck | undefined {
  return error && typeof error === "object" ? rootFailureChecks.get(error) : undefined;
}
function observeRootFailure<T>(check: ResearchProviderRootCheck, operation: () => T): T {
  const timings = rootTimings; let started: number | undefined;
  try { if (timings) started = performance.now(); } catch { /* Observation only. */ }
  try { return operation(); }
  catch (error) {
    if (error && typeof error === "object" && !rootFailureChecks.has(error)) rootFailureChecks.set(error, check);
    throw error;
  } finally {
    try {
      const value = timings?.get(check), elapsed = started === undefined ? 0 : performance.now() - started;
      if (value) {
        if (Number.isSafeInteger(value.count + 1)) value.count++;
        const total = value.inclusiveElapsedMs + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
        if (Number.isFinite(total)) value.inclusiveElapsedMs = total;
      }
    } catch { /* Observation only; preserve the original return or thrown identity. */ }
  }
}

export enum ResearchRootMountAccess { ReadOnly = "read-only", ReadWrite = "read-write" }
export enum ResearchRootReadRole { Dns = "dns", ScratchPolicy = "scratch-policy", PublicText = "public-text", CaBundle = "ca-bundle" }
const publicTextNames = ["passwd", "group", "nsswitch.conf", "hosts", "resolv.conf", "gai.conf", "host.conf"] as const;
const resolverConfNames = ["resolv.conf", "stub-resolv.conf"] as const;
const resolverSockets = [{ name: "io.systemd.Resolve", mode: 0o666 }, { name: "io.systemd.Resolve.Monitor", mode: 0o600 }] as const;
const caPath = "/etc/ssl/certs/ca-certificates.crt";
function publicSnapshotPath(path: string, name: string): boolean {
  const prefix = researchAuthorityRoot + "/";
  if (!path.startsWith(prefix)) return false;
  const fields = path.slice(prefix.length).split("/");
  return fields.length === 6 && /^[a-f0-9]{64}$/.test(fields[0]!) && fields[1] === "starts" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(fields[2]!) &&
    fields[3] === "provider-roots" && researchProviderUnitPattern.test(fields[4]!) && fields[5] === name;
}
type Info = Pick<Stats, "uid" | "gid" | "mode" | "dev" | "ino" | "nlink" | "size" | "isDirectory" | "isFile" | "isSymbolicLink">;
const leafSignature = (info: Info): string => [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink].join(":");
/** Native observations and finite skeleton effects. No launch input supplies this port. */
export interface ResearchProviderRootHost {
  info(path: string): Info; canonical(path: string): string; link(path: string): string;
  read(path: string): string; entries(path: string): readonly string[];
  mkdir(path: string, mode: number): void; symlink(target: string, path: string): void; file(path: string): void;
  regular(path: string, expected: Info, role?: ResearchRootReadRole): string; snapshot(path: string, bytes: string): void;
  publish(path: string, value: unknown): void; record(path: string): string;
}
const nativeHost: ResearchProviderRootHost = {
  info: lstatSync, canonical: realpathSync, link: readlinkSync, read: path => path === "/proc/self/mountinfo" ? readKernelMountTable() : readFileSync(path, "utf8"), entries: readdirSync,
  mkdir: (path, mode) => { mkdirSync(path, { mode }); }, symlink: symlinkSync,
  file: path => { writeFileSync(path, "", { mode: 0o644, flag: "wx" }); },
  regular(path, expected, role = ResearchRootReadRole.Dns) {
    return observeRootFailure(ResearchProviderRootCheck.Regular, () => {
    if (role === ResearchRootReadRole.ScratchPolicy ? path !== "/etc/subscription-runtime/scratch-temp.json" :
        role === ResearchRootReadRole.PublicText ? !publicTextNames.some(name => path === "/etc/" + name || publicSnapshotPath(path, "public-" + name + ".snapshot")) :
        role === ResearchRootReadRole.CaBundle ? path !== caPath && !publicSnapshotPath(path, "public-ca-certificates.crt.snapshot") :
        role !== ResearchRootReadRole.Dns) researchInvalid();
    const maxBytes = role === ResearchRootReadRole.ScratchPolicy ? 8 * 1024 * 1024 : role === ResearchRootReadRole.CaBundle ? 1024 * 1024 : 65536;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > maxBytes || leafSignature(before) !== leafSignature(expected)) researchInvalid();
      const buffer = Buffer.alloc(before.size + 1); let used = 0;
      while (used < buffer.length) { const count = readSync(fd, buffer, used, buffer.length - used, used); if (!count) break; used += count; }
      const after = fstatSync(fd);
      if (leafSignature(after) !== leafSignature(before) || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs ||
          leafSignature(lstatSync(path)) !== leafSignature(before) || used !== before.size) researchInvalid();
      try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)); } catch { researchInvalid(); }
    } finally { closeSync(fd); }
    });
  },
  snapshot(path, bytes) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  },
  publish: (path, value) => researchPublish(path, value, true), record: path => researchRead(path).toString("utf8"),
};
enum MountRootKind { Path = "path", Opaque = "opaque" }
type Mount = { point: string; root: string; rootKind: MountRootKind; device: string; id: string; parent: string };
type Backing = { device: string; path: string; mount: Mount; ancestors: Mount[] };
type Binding = { source: string; target: string; access: ResearchRootMountAccess; identity: readonly [number, number]; backing: Backing; file: boolean };
type OmittedCache = { source: string; target: string; identity: readonly [number, number]; backing: Backing; mounted: Backing; base: Backing };
type PublicFile = { target: string; bytes: string; name: string; role: ResearchRootReadRole };
type Snapshot = { omittedCaches: OmittedCache[]; bindings: Binding[]; aliases: [string, string][]; fileLinks: [string, string][]; observations: unknown[]; files: PublicFile[] };
function validateAccounts(bytes: string, group: boolean): void {
  return observeRootFailure(ResearchProviderRootCheck.Accounts, () => {
  const names = new Set<string>();
  const records = bytes.trimEnd().split("\n");
  if (!records.length || records.some(line => {
    const fields = line.split(":"), name = fields[0]!, password = fields[1];
    if (fields.length !== (group ? 4 : 7) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(name) || names.has(name) ||
        !["", "x", "*", "!", "!!"].includes(password ?? "") || fields.some(field => /[\r\x00]/.test(field))) return true;
    names.add(name);
    if (!(group ? [fields[2]] : [fields[2], fields[3]]).every(field => /^\d+$/.test(field!) && Number.isSafeInteger(Number(field)))) return true;
    return group && fields[3] !== "" && !fields[3]!.split(",").every(member => /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(member));
  })) researchInvalid();
  });
}
function validateCaBundle(bytes: string): void {
  return observeRootFailure(ResearchProviderRootCheck.CaBundle, () => {
  const pattern = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g;
  const blocks = [...bytes.matchAll(pattern)];
  if (!blocks.length || bytes.replace(pattern, "").trim()) researchInvalid();
  try {
    for (const block of blocks) {
      const encoded = block[1]!.replace(/\s/g, "");
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) researchInvalid();
      const der = Buffer.from(encoded, "base64"), certificate = new X509Certificate(der);
      if (!certificate.ca || !certificate.raw.equals(der)) researchInvalid();
    }
  } catch { researchInvalid(); }
  });
}
const rootPlanBrand: unique symbol = Symbol("research-provider-root");
/** Opaque retained receipt; its DTO fields cannot confer execution authority. */
export type ResearchProviderRootPlan = Readonly<{ fixedRootDirectory: string; bindings: readonly Binding[]; [rootPlanBrand]: true }>;
type Retained = { spec: ResearchStartSpec; unit: string; home: string; scratchHost: ScratchTempHost | undefined; host: ResearchProviderRootHost;
  directory: string; snapshot: string; skeleton: string; custody: string; record: string; materialized: string;
  omittedCaches: readonly (OmittedCache & { baseIdentity: readonly [number, number] })[] };
const retained = new WeakMap<ResearchProviderRootPlan, Retained>();
function freezeFacts<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeFacts(child); Object.freeze(value); }
  return value;
}
const aliases = [["/bin", "/usr/bin"], ["/sbin", "/usr/sbin"], ["/lib", "/usr/lib"], ["/lib64", "/usr/lib64"]] as const;
const contains = (parent: string, child: string): boolean => parent === "/" || child === parent || child.startsWith(parent + "/");
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);
const sameBacking = (a: Backing, b: Backing): boolean => a.device === b.device && a.path === b.path;
const backingOverlap = (a: Backing, b: Backing): boolean => a.device === b.device && overlaps(a.path, b.path);
export function researchProviderProtectedPaths(authRoot: string): string[] {
  return ["/run/systemd/private", "/run/systemd/journal", "/dev/log", "/run/dbus", "/run/user",
    "/var/lib/subscription-runtime-host-policy", researchAuthorityRoot, "/run/docker.sock", "/run/containerd/containerd.sock",
    "/run/podman/podman.sock", "/etc/subscription-runtime/secrets", authRoot];
}
function mountTable(host: ResearchProviderRootHost): Mount[] {
  return observeRootFailure(ResearchProviderRootCheck.MountTable, () => {
  const bytes = host.read("/proc/self/mountinfo");
  if (bytes.length > 8 * 1024 * 1024) researchInvalid();
  const lines = bytes.trimEnd().split("\n");
  if (!lines.length || lines.length > 32768) researchInvalid();
  const decode = (field: string): string => field.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  const normalizedAbsolute = (path: string): boolean => path.startsWith("/") && resolve(path) === path;
  return lines.map(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4 || !/^\d+:\d+$/.test(fields[2] ?? "") ||
        !/^\d+$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[1] ?? "")) researchInvalid();
    const point = decode(fields[4]!), root = decode(fields[3]!);
    if (!normalizedAbsolute(point)) researchInvalid();
    const mount: Mount = { point, root, rootKind: MountRootKind.Path, device: fields[2]!, id: fields[0]!, parent: fields[1]! };
    if (normalizedAbsolute(root)) return mount;
    // Linux's generic show_path -> seq_dentry -> dentry_path appends exactly
    // "//deleted" to an unlinked non-root dentry. ext4 has no show_path override.
    // Retain this opaque ROOT in the graph; never normalize it into path backing.
    const deletedPrefix = root.endsWith("//deleted") ? root.slice(0, -9) : undefined;
    if (fields[separator + 1] === "ext4" && deletedPrefix !== undefined && deletedPrefix !== "/" &&
        normalizedAbsolute(deletedPrefix) &&
        /^(?:[^\\\x00 \t\n]|\\(?:040|011|012|134))+$/.test(fields[3]!)) return { ...mount, rootKind: MountRootKind.Opaque };
    // Linux nsfs show_path emits namespace type:[unsigned namespace inode],
    // on its anonymous major-zero device and the kern_mount source "nsfs".
    // Keep these rows in the graph; their handles can never be path backing.
    const handle = /^(?:cgroup|ipc|mnt|net|pid|time|user|uts):\[([1-9]\d{0,9})\]$/.exec(root);
    const device = /^0:([1-9]\d{0,6})$/.exec(mount.device);
    if (fields[separator + 1] !== "nsfs" || fields[separator + 2] !== "nsfs" || !handle ||
        Number(handle[1]) > 0xffffffff || !device || Number(device[1]) > 0xfffff) researchInvalid();
    return { ...mount, rootKind: MountRootKind.Opaque };
  });
  });
}
function backing(path: string, mounts: Mount[], intentionalAlias = false): Backing {
  return observeRootFailure(ResearchProviderRootCheck.Backing, () => {
  const ancestors = mounts.filter(m => contains(m.point, path)).sort((a, b) => b.point.length - a.point.length);
  if (!ancestors.length || ancestors.some(m => m.rootKind === MountRootKind.Opaque) ||
      new Set(ancestors.map(m => m.point)).size !== ancestors.length) researchInvalid();
  const mount = ancestors[0]!;
  const result = { device: mount.device, path: join(mount.root, relative(mount.point, path)), mount, ancestors };
  if (!intentionalAlias) {
    const containing = ancestors.slice(1).filter(ancestor => ancestor.device === mount.device);
    if (containing.length ? containing.some(ancestor => join(ancestor.root, relative(ancestor.point, path)) !== result.path) : mount.root !== "/") researchInvalid();
  }
  return result;
  });
}
function nativeDevice(info: Info): string {
  const device = BigInt(info.dev), major = (device >> 8n & 0xfffn) | (device >> 32n & 0xfffff000n), minor = (device & 0xffn) | (device >> 12n & 0xffffff00n);
  return `${major}:${minor}`;
}
function snapshot(spec: ResearchStartSpec, directory: string, unit: string, home: string,
  host: ResearchProviderRootHost, scratchHost?: ScratchTempHost): Snapshot {
  return observeRootFailure(ResearchProviderRootCheck.Snapshot, () => {
  const mounts = mountTable(host), observations: unknown[] = [], observed = new Set<string>(), bindings: Binding[] = [], layout: [string, string][] = [], fileLinks: [string, string][] = [], files: PublicFile[] = [];
  const durable = spec.registeredHandoff?.durableDirectory;
  const durableBacking = durable ? backing(durable.path, mounts) : undefined;
  if (durable && durableBacking && (durableBacking.device !== durable.mountDevice ||
      durableBacking.path !== join(durable.mountRoot, relative(durable.mountPoint, durable.path)))) researchInvalid();
  const boundInfos = new Map<Binding, Info>();
  let resolverOwner: number | undefined;
  const observe = (path: string, owner = 0, leafOnly = false, ownedAncestorRoot?: string): Info => observeRootFailure(ResearchProviderRootCheck.Observe, () => {
    researchPath(path);
    let leaf: Info | undefined;
    for (let current = path;; current = dirname(current)) {
      const info = host.info(current), expectedOwner = current === path ? owner : current === "/run/systemd/resolve" ? resolverOwner ?? 0 : 0;
      if ((!info.isDirectory() && !(current === path && info.isFile())) || info.isSymbolicLink() ||
          (current === path || !leafOnly || ownedAncestorRoot !== undefined && contains(ownedAncestorRoot, current)) &&
          (info.uid !== expectedOwner || (info.mode & 0o022)) ||
          (info.isFile() && info.nlink !== 1) || host.canonical(current) !== current) researchInvalid();
      if (current === path) leaf = info;
      if (!observed.has(current)) { observed.add(current); observations.push([current, info.dev, info.ino, info.mode, info.uid, info.gid]); }
      if (current === "/") return leaf!;
    }
  });
  const add = (source: string, target: string, access: ResearchRootMountAccess, owner = 0, leafOnly = false): Binding => observeRootFailure(ResearchProviderRootCheck.Add, () => {
    const info = observe(source, owner, leafOnly), canonicalTarget = normalize(target), sourceBacking = backing(source, mounts, source.startsWith(join(directory, "pins") + "/"));
    if (nativeDevice(info) !== sourceBacking.device) researchInvalid();
    const entry = { source, target, access, identity: [info.dev, info.ino] as const, backing: sourceBacking, file: info.isFile() };
    // Every provider binding, including read-only runtime/package ancestors,
    // excludes the durable sink's physical backing and nominal target. A bind
    // alias cannot turn registry custody into provider-visible source data.
    if (durable && durableBacking && (overlaps(canonicalTarget, durable.path) || backingOverlap(sourceBacking, durableBacking) ||
        info.dev === durable.device && info.ino === durable.inode)) researchInvalid();
    if (access === ResearchRootMountAccess.ReadWrite) {
      const targetInfo = observe(target, 0, true);
      const scratchTarget = [join(spec.request.jobRootDir, "tmp"), join(home, "plugins/cache"), join(home, "cache/remote_plugin_catalog")].includes(target);
      if (info.dev !== targetInfo.dev || info.ino !== targetInfo.ino || !sameBacking(sourceBacking, backing(canonicalTarget, mounts, scratchTarget))) researchInvalid();
    }
    boundInfos.set(entry, info); bindings.push(entry); return entry;
  });
  const normalize = (path: string): string => {
    researchPath(path);
    const alias = layout.find(([from]) => contains(from, path));
    return alias ? join(alias[1], relative(alias[0], path)) : path;
  };
  add("/usr", "/usr", ResearchRootMountAccess.ReadOnly); observe("/etc");
  for (const [path, target] of aliases) {
    let info: Info;
    try { info = host.info(path); } catch (e) { if (path === "/lib64" && (e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (info.isSymbolicLink()) {
      const link = host.link(path);
      if (info.uid !== 0 || info.nlink !== 1 || (link !== target && link !== target.slice(1)) || host.canonical(path) !== target) researchInvalid();
      observe(target); layout.push([path, target]); observations.push([path, info.dev, info.ino, link]);
    } else add(path, path, ResearchRootMountAccess.ReadOnly);
  }
  // Only fixed public leaves enter /etc. Their immutable snapshots, rather
  // than the Host directory or mutable original files, become root bindings.
  const capturePublic = (path: string, name: string, role = ResearchRootReadRole.PublicText): string => observeRootFailure(ResearchProviderRootCheck.CapturePublic, () => {
    const info = observe(path);
    if (!info.isFile() || info.gid !== 0 || (info.mode & 0o7777) !== 0o644 || info.nlink !== 1) researchInvalid();
    const entry = add(path, path, ResearchRootMountAccess.ReadOnly);
    if (leafSignature(boundInfos.get(entry)!) !== leafSignature(info)) researchInvalid();
    const bytes = host.regular(path, info, role); files.push({ target: path, bytes, name, role }); return bytes;
  });
  const passwdBytes = capturePublic("/etc/passwd", "public-passwd.snapshot"); validateAccounts(passwdBytes, false);
  validateAccounts(capturePublic("/etc/group", "public-group.snapshot"), true);
  for (const name of ["nsswitch.conf", "hosts"]) capturePublic("/etc/" + name, "public-" + name + ".snapshot");
  for (const name of ["gai.conf", "host.conf"]) {
    const path = "/etc/" + name;
    try { host.info(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      observations.push([path, "absent"]); continue;
    }
    capturePublic(path, "public-" + name + ".snapshot");
  }
  validateCaBundle(capturePublic(caPath, "public-ca-certificates.crt.snapshot", ResearchRootReadRole.CaBundle));
  // DNS data is the sole non-root-owned dependency: only the installed resolved
  // account's two regular files, never its directory or sockets, enter the root.
  const resolver = "/etc/resolv.conf", resolverInfo = host.info(resolver);
  if (resolverInfo.isSymbolicLink()) {
    const destination = host.canonical(resolver), originalLink = host.link(resolver);
    if (resolverInfo.uid !== 0 || resolverInfo.gid !== 0 || resolverInfo.nlink !== 1 ||
        !["/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/resolv.conf"].includes(destination) ||
        resolve(dirname(resolver), originalLink) !== destination) researchInvalid();
    const servicePath = "/usr/lib/systemd/system/systemd-resolved.service";
    observe(servicePath);
    const serviceBytes = host.read(servicePath), records = passwdBytes.split("\n").filter(line => line.startsWith("systemd-resolve:"));
    if (records.length !== 1 || !/^User=systemd-resolve$/m.test(serviceBytes)) researchInvalid();
    const fields = records[0]!.split(":"), uid = Number(fields[2]), gid = Number(fields[3]);
    if (fields.length !== 7 || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) researchInvalid();
    resolverOwner = uid;
    const resolverDirectory = observe("/run/systemd/resolve", uid);
    const resolverEntries = [...host.entries("/run/systemd/resolve")].sort();
    if (resolverDirectory.gid !== gid || (resolverDirectory.mode & 0o7777) !== 0o755 ||
        resolverEntries.some(name => !resolverConfNames.some(conf => conf === name) && !resolverSockets.some(socket => socket.name === name))) researchInvalid();
    // Daemon control sockets are authenticated omissions, never root bindings.
    for (const name of resolverEntries) {
      const socket = resolverSockets.find(candidate => candidate.name === name);
      if (!socket) continue;
      const path = join("/run/systemd/resolve", name), info = host.info(path), sourceBacking = backing(path, mounts);
      if ((info.mode & constants.S_IFMT) !== constants.S_IFSOCK || (info.mode & 0o7777) !== socket.mode ||
          info.uid !== uid || info.gid !== gid || info.nlink !== 1 || info.dev !== resolverDirectory.dev ||
          nativeDevice(info) !== sourceBacking.device || host.canonical(path) !== path) researchInvalid();
      observations.push([path, info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, sourceBacking]);
    }
    observations.push([resolver, resolverInfo.dev, resolverInfo.ino, resolverInfo.mode, originalLink, researchHash(serviceBytes)]);
    fileLinks.push([resolver, "../run/systemd/resolve/" + destination.slice(destination.lastIndexOf("/") + 1)]);
    for (const name of resolverConfNames) {
      if (!resolverEntries.includes(name)) continue;
      const path = join("/run/systemd/resolve", name), entry = add(path, path, ResearchRootMountAccess.ReadOnly, uid), info = boundInfos.get(entry)!;
      if (!entry.file || info.gid !== gid || (info.mode & 0o7777) !== 0o644) researchInvalid();
      files.push({ target: path, bytes: host.regular(path, info), name: "resolver-" + name + ".snapshot", role: ResearchRootReadRole.Dns });
    }
    if (!bindings.some(b => b.source === destination)) researchInvalid();
  } else capturePublic(resolver, "public-resolv.conf.snapshot");
  add(spec.runtimeDirectory, spec.runtimeDirectory, ResearchRootMountAccess.ReadOnly);
  for (const executable of [process.execPath, spec.request.codexBinaryPath]) {
    const info = observe(executable); if (!info.isFile() || !(info.mode & 0o111)) researchInvalid();
    if (!contains("/usr", executable) && !contains(spec.runtimeDirectory, executable)) add(executable, executable, ResearchRootMountAccess.ReadOnly);
  }
  const packageRoot = hostedCodexExecutableReadPath({ codexBinaryPath: spec.request.codexBinaryPath, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } });
  if (!packageRoot && !contains("/usr", spec.request.codexBinaryPath)) researchInvalid();
  if (packageRoot && !contains("/usr", packageRoot) && !contains(spec.runtimeDirectory, packageRoot) && packageRoot !== spec.request.codexBinaryPath) add(packageRoot, packageRoot, ResearchRootMountAccess.ReadOnly);
  const { jobRootDir: job, workspacePath: workspace, authRootDir } = spec.request;
  const pins = join(directory, "pins"), jobBind = add(join(pins, "job"), job, ResearchRootMountAccess.ReadWrite), workspaceBind = add(join(pins, "workspace"), workspace, ResearchRootMountAccess.ReadWrite);
  if (jobBind.identity[0] !== spec.jobDirectory.device || jobBind.identity[1] !== spec.jobDirectory.inode ||
      workspaceBind.identity[0] !== spec.workspaceDirectory.device || workspaceBind.identity[1] !== spec.workspaceDirectory.inode) researchInvalid();
  if (!home.startsWith(join(job, "home") + "/")) researchInvalid();
  // Preserve nominal home custody through the captured job; project ancestors remain data.
  const corroborateHome = (candidate: string): void => observeRootFailure(ResearchProviderRootCheck.CorroborateHome, () => {
    const nominal = observe(candidate, 0, true, job), pinned = join(pins, "job", relative(job, candidate)), original = observe(pinned);
    if (!nominal.isDirectory() || !original.isDirectory() || nominal.dev !== original.dev || nominal.ino !== original.ino || !sameBacking(backing(candidate, mounts), backing(pinned, mounts, true))) researchInvalid();
  });
  corroborateHome(home);
  const scratch = resolvePreparedHostScratchBinds(job, home, scratchHost);
  const scratchTargets = [join(job, "tmp"), join(home, "plugins/cache"), join(home, "cache/remote_plugin_catalog")];
  if (scratch.length > 3 || new Set(scratch.map(b => b.target)).size !== scratch.length || scratch.some(b => !scratchTargets.includes(b.target))) researchInvalid();
  for (const bind of scratch) add(bind.source, bind.target, ResearchRootMountAccess.ReadWrite);
  const protectedPaths = ["/etc", ...researchProviderProtectedPaths(authRootDir), join(directory, "provider-roots", unit)];
  if (mounts.some(m => contains(join(directory, "provider-roots", unit), m.point))) researchInvalid();
  const rw = bindings.filter(b => b.access === ResearchRootMountAccess.ReadWrite), ro = bindings.filter(b => b.access === ResearchRootMountAccess.ReadOnly);
  // Runtime prewarm/fallback retains other account mounts after the private,
  // nonrecursive job pin was captured. Authenticate their empty lower anchors;
  // their physical sources never become provider bindings or skeleton entries.
  const cacheRoot = join(job, "home/codex-session-cache"), foreignHomes = new Set<string>(), omittedCaches: OmittedCache[] = [];
  for (const mount of mounts) {
    const match = /^(codex-[a-f0-9]{32}\/codex-home)\/(?:plugins\/cache|cache\/remote_plugin_catalog)$/.exec(relative(cacheRoot, mount.point));
    if (!match) continue;
    const candidate = join(cacheRoot, match[1]!);
    if (candidate === home) continue;
    if (overlaps(candidate, home)) researchInvalid();
    foreignHomes.add(candidate);
  }
  // The fixed research account pool admits at most sixteen generated homes.
  if (foreignHomes.size > 15) researchInvalid();
  if (foreignHomes.size) {
    const policyPath = "/etc/subscription-runtime/scratch-temp.json", policyInfo = observe(policyPath);
    if (!policyInfo.isFile()) researchInvalid();
    observations.push(["scratch-policy", researchHash(host.regular(policyPath, policyInfo, ResearchRootReadRole.ScratchPolicy))]);
  }
  for (const candidate of [...foreignHomes].sort()) {
    corroborateHome(candidate);
    const foreign = resolvePreparedHostScratchCacheBinds(candidate, scratchHost);
    if (foreign.length > 2 || new Set(foreign.map(entry => entry.target)).size !== foreign.length ||
        foreign.some(entry => ![join(candidate, "plugins/cache"), join(candidate, "cache/remote_plugin_catalog")].includes(entry.target))) researchInvalid();
    for (const { source, target } of foreign) {
      const sourceInfo = observe(source), targetInfo = observe(target, 0, true, job), basePath = join(pins, "job", relative(job, target)), baseInfo = observe(basePath);
      const sourceBacking = backing(source, mounts), mounted = backing(target, mounts, true), base = backing(basePath, mounts, true);
      const scratchRoot = dirname(dirname(source)), rootInfo = observe(scratchRoot); observe(dirname(source));
      const rootBacking = backing(scratchRoot, mounts);
      observations.push(["omitted-scratch-root", scratchRoot, rootBacking]);
      if (!sourceInfo.isDirectory() || !targetInfo.isDirectory() || !baseInfo.isDirectory() ||
          rootBacking.mount.point !== scratchRoot || rootBacking.mount.root !== "/" || nativeDevice(rootInfo) !== rootBacking.device ||
          sourceBacking.mount.point !== scratchRoot || nativeDevice(sourceInfo) !== sourceBacking.device || nativeDevice(targetInfo) !== mounted.device ||
          sourceInfo.dev !== targetInfo.dev || sourceInfo.ino !== targetInfo.ino || !sameBacking(sourceBacking, mounted) || mounted.mount.point !== target ||
          baseInfo.dev !== jobBind.identity[0] || nativeDevice(baseInfo) !== base.device || base.device !== jobBind.backing.device ||
          base.path !== join(jobBind.backing.path, relative(job, target)) || host.entries(basePath).length ||
          mounts.some(m => m.point !== source && contains(source, m.point)) || mounts.some(m => m.point !== basePath && contains(basePath, m.point))) researchInvalid();
      const omission: OmittedCache = { source, target, identity: [sourceInfo.dev, sourceInfo.ino], backing: sourceBacking, mounted, base };
      if ([...bindings, ...omittedCaches].some(entry => backingOverlap(sourceBacking, entry.backing) ||
          sourceInfo.dev === entry.identity[0] && sourceInfo.ino === entry.identity[1]) ||
          protectedPaths.some(path => backingOverlap(sourceBacking, backing(path, mounts)))) researchInvalid();
      omittedCaches.push(omission);
    }
    // Native mountinfo and the existing fixed scratch observer must agree.
    if (mounts.filter(m => m.point === join(candidate, "plugins/cache") || m.point === join(candidate, "cache/remote_plugin_catalog"))
        .some(m => !foreign.some(entry => entry.target === m.point))) researchInvalid();
  }
  for (const writable of rw) {
    for (const readonly of ro) if ([writable.target, normalize(writable.target)].some(path => [readonly.target, normalize(readonly.target)].some(other => overlaps(path, other))) ||
        backingOverlap(writable.backing, readonly.backing) || writable.identity[0] === readonly.identity[0] && writable.identity[1] === readonly.identity[1]) researchInvalid();
    for (const protectedPath of protectedPaths) if ([writable.target, normalize(writable.target)].some(path => overlaps(path, protectedPath)) || backingOverlap(writable.backing, backing(protectedPath, mounts))) researchInvalid();
  }
  for (let i = 0; i < rw.length; i++) for (const other of rw.slice(i + 1)) {
    const writable = rw[i]!, nestedWorkspace = writable === jobBind && other === workspaceBind && contains(job, workspace) && workspace !== job;
    const nestedScratch = scratchTargets.includes(other.target) && (writable === jobBind || writable === workspaceBind) && contains(writable.target, other.target);
    if (normalize(writable.target) === normalize(other.target) ||
        (overlaps(normalize(writable.target), normalize(other.target)) || backingOverlap(writable.backing, other.backing)) && !nestedWorkspace && !nestedScratch) researchInvalid();
    if (nestedWorkspace && !(writable.backing.device === other.backing.device && join(writable.backing.path, relative(job, workspace)) === other.backing.path)) researchInvalid();
  }
  for (const bind of bindings) {
    // Nonrecursive binds must not silently omit dependencies or unknown RW mounts.
    if (mounts.some(m => m.point !== bind.source && contains(bind.source, m.point))) researchInvalid();
    if (bind.access === ResearchRootMountAccess.ReadWrite) for (const mount of mounts.filter(m => m.point !== normalize(bind.target) && contains(normalize(bind.target), m.point))) {
      if ((bind === jobBind || bind === workspaceBind) && omittedCaches.some(entry => entry.target === mount.point)) continue;
      const admitted = rw.find(entry => normalize(entry.target) === mount.point);
      if (!admitted || !(admitted === workspaceBind && bind === jobBind && contains(job, workspace) || scratch.some(s => s.target === admitted.target)) ||
          !sameBacking(admitted.backing, backing(mount.point, mounts, scratchTargets.includes(admitted.target)))) researchInvalid();
    }
  }
  const unique = bindings.filter((bind, index) => {
    const previous = bindings.slice(0, index).find(other => normalize(other.target) === normalize(bind.target));
    if (!previous) return true;
    if (bind.access !== ResearchRootMountAccess.ReadOnly || JSON.stringify(bind) !== JSON.stringify(previous)) researchInvalid();
    return false;
  });
  return { omittedCaches, bindings: unique, aliases: layout, fileLinks, observations, files };
  });
}

function skeletonEntries(root: string, snapshot: Snapshot): Map<string, "directory" | "file" | string> {
  return observeRootFailure(ResearchProviderRootCheck.SkeletonEntries, () => {
  const entries = new Map<string, "directory" | "file" | string>([[root, "directory"]]);
  const add = (path: string, kind: "directory" | "file" | string): void => {
    const absolute = researchPath(join(root, path.slice(1))), previous = entries.get(absolute);
    if (previous && previous !== kind) researchInvalid();
    entries.set(absolute, kind);
    for (let parent = dirname(absolute); parent !== dirname(root); parent = dirname(parent)) {
      const existing = entries.get(parent); if (existing && existing !== "directory") researchInvalid();
      entries.set(parent, "directory"); if (parent === root) break;
    }
  };
  // ProtectSystem=strict prepares this empty anchor; it never binds Host /root.
  for (const path of ["/run", "/proc", "/sys", "/dev", "/root", "/tmp", "/var/tmp"]) add(path, "directory");
  for (const bind of snapshot.bindings) add(bind.target, bind.file ? "file" : "directory");
  for (const [path, target] of snapshot.aliases) add(path, target.slice(1));
  for (const [path, link] of snapshot.fileLinks) add(path, link);
  if (entries.size > 512) researchInvalid();
  return entries;
  });
}
function skeletonIdentity(entries: Map<string, string>, host: ResearchProviderRootHost): string {
  return observeRootFailure(ResearchProviderRootCheck.SkeletonIdentity, () => {
  const roots = [...entries.keys()], root = roots[0]!, mounts = mountTable(host);
  if (mounts.some(m => contains(root, m.point))) researchInvalid();
  return JSON.stringify(roots.sort().map(path => {
    const info = host.info(path), kind = entries.get(path)!;
    if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022)) ||
        (kind === "directory" ? !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o755 ||
          host.entries(path).some(name => !entries.has(join(path, name))) :
          kind === "file" ? !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0 :
            !info.isSymbolicLink() || host.link(path) !== kind)) researchInvalid();
    return [path, kind, info.dev, info.ino, info.mode];
  }));
  });
}
function rootCustody(directory: string, host: ResearchProviderRootHost): string {
  return observeRootFailure(ResearchProviderRootCheck.Custody, () => {
  const rows: unknown[] = [];
  for (let path = directory;; path = dirname(path)) {
    const info = host.info(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || host.canonical(path) !== path ||
        contains(researchAuthorityRoot, path) && (info.mode & 0o077)) researchInvalid();
    rows.push([path, info.dev, info.ino, info.mode]); if (path === "/") break;
  }
  return JSON.stringify(rows);
  });
}
export function prepareResearchProviderRoot(value: ResearchStartSpec, unit: string, home: string,
  scratchHost?: ScratchTempHost, host: ResearchProviderRootHost = nativeHost): ResearchProviderRootPlan {
  return observeRootFailure(ResearchProviderRootCheck.Prepare, () => {
  const spec = parseResearchStartSpec(value);
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const directory = join(researchAuthorityRoot, researchName(spec.request.jobId), "starts", spec.startId);
  const reservation = readResearchProviderReservation(directory, unit);
  if (JSON.stringify(reservation.spec) !== JSON.stringify(spec)) researchInvalid();
  // Capture and deny the complete graph before the first new root effect.
  const captured = snapshot(spec, directory, unit, researchPath(home), host, scratchHost);
  const parent = join(directory, "provider-roots"), unitDirectory = join(parent, unit), root = join(unitDirectory, "root");
  const entries = skeletonEntries(root, captured);
  // Account for the escaped skeleton receipt and repeated materialized bindings
  // before effects; the existing private reader's 1 MiB ceiling remains exact.
  if (Buffer.byteLength(JSON.stringify(captured)) * 2 + [...entries.keys()].reduce((sum, path) => sum + path.length * 2 + 128, 65536) > 1024 * 1024) researchInvalid();
  rootCustody(directory, host);
  let parentExists = false;
  try {
    rootCustody(parent, host); parentExists = true;
    if (host.entries(parent).some(name => !researchProviderUnitPattern.test(name)) || host.entries(parent).length > 1024) researchInvalid();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Never replace or adopt a root from a previous/uncertain submission.
  try { host.info(unitDirectory); researchInvalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (mountTable(host).some(m => contains(parent, m.point))) researchInvalid();
  if (!parentExists) host.mkdir(parent, 0o700);
  host.mkdir(unitDirectory, 0o700);
  for (const [path, kind] of [...entries].sort(([a], [b]) => a.length - b.length || a.localeCompare(b))) {
    if (kind === "directory") host.mkdir(path, 0o755); else if (kind === "file") host.file(path); else host.symlink(kind, path);
  }
  const materialized = captured.bindings.map(bind => {
    const file = captured.files.find(file => file.target === bind.target);
    if (!file) return bind;
    const source = join(unitDirectory, file.name);
    host.snapshot(source, file.bytes); const info = host.info(source);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o444) researchInvalid();
    return { ...bind, source, identity: [info.dev, info.ino] as const, backing: backing(source, mountTable(host)) };
  });
  const skeleton = skeletonIdentity(entries, host), custody = rootCustody(unitDirectory, host), serialized = JSON.stringify(captured);
  const materializedBytes = JSON.stringify(materialized);
  const record = JSON.stringify({ schemaVersion: 1, unit, specSha256: reservation.specSha256, artifactSha256: spec.artifactSha256, captured, materialized, skeleton, custody }) + "\n";
  host.publish(join(unitDirectory, "plan.json"), JSON.parse(record));
  const plan: ResearchProviderRootPlan = freezeFacts({ fixedRootDirectory: root, bindings: materialized, [rootPlanBrand]: true as const });
  const omittedCaches = captured.omittedCaches.map(entry => {
    const base = host.info(join(directory, "pins/job", relative(spec.request.jobRootDir, entry.target)));
    return { ...entry, baseIdentity: [base.dev, base.ino] as const };
  });
  retained.set(plan, { spec, unit, home, scratchHost, host, directory, snapshot: serialized, skeleton, custody, record,
    materialized: materializedBytes, omittedCaches: freezeFacts(omittedCaches) });
  assertResearchProviderRoot(plan, spec, unit, home); return plan;
  });
}
/** Facts from an owner-retained allocated plan, not a serializable launch permit.
 * Both nominal paths and kernel backing are needed when comparing bind aliases. */
export type ResearchProviderWritableRoot = Readonly<{
  source: string; target: string; device: string; backingPath: string;
}>;

/** Lightweight census observation. The opaque plan is retained by its actual
 * owner; callers cannot supply a parsed plan.json as authority. Revocation does
 * not imply release: these allocated roots remain conservatively reserved.
 * This avoids executable/public-file walks and all manager/provider waits. */
export function observeResearchProviderWritableRoots(plan: ResearchProviderRootPlan): readonly ResearchProviderWritableRoot[] {
  const state = retained.get(plan);
  if (!state) researchInvalid();
  return observeAllocatedResearchRoots({ ...state, bindings: plan.bindings });
}

enum ResearchWriterFootprintProfile { MimoLifetimeV1 = "mimo-lifetime-rw-v1" }
const footprintRoots = (roots: readonly ResearchProviderWritableRoot[]): readonly ResearchProviderWritableRoot[] =>
  [...roots].sort((left, right) => left.target.localeCompare(right.target));

/** First enforced MiMo plan fixes the allocation's writable extent. Later
 * provider preparations cannot widen it, even when a new unit is reserved.
 * This private witness grants no launch authority and is not a registry lease. */
export function bindResearchMimoWritableFootprint(plan: ResearchProviderRootPlan): void {
  const state = retained.get(plan);
  if (!state) researchInvalid();
  if (state.spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) return;
  assertResearchMimoProviderHome(state.spec, state.home);
  const roots = footprintRoots(observeResearchProviderWritableRoots(plan));
  const path = join(state.directory, "mimo-writable-footprint.json");
  const binding = { schemaVersion: 1, profile: ResearchWriterFootprintProfile.MimoLifetimeV1,
    specSha256: researchHash(researchRead(join(state.directory, "spec.json"))),
    artifactSha256: state.spec.artifactSha256,
    homeSha256: researchHash(researchRead(join(state.directory, "mimo-home.json"))), roots };
  try { researchRead(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A successor must never replace a lost lifetime witness with wider roots.
    const units = researchProviderUnits(state.directory);
    if (units.length !== 1 || units[0] !== state.unit) researchInvalid();
    try { researchPublish(path, { ...binding, unit: state.unit, planSha256: researchHash(state.record) }, true); }
    catch (publicationError) { if ((publicationError as NodeJS.ErrnoException).code !== "EEXIST") throw publicationError; }
  }
  const record = researchRecord(researchJson(researchRead(path)), "schemaVersion,profile,specSha256,artifactSha256,homeSha256,roots,unit,planSha256");
  // The first unit remains the immutable index; subsequent units only compare.
  if (typeof record.unit !== "string" || !researchProviderUnitPattern.test(record.unit) ||
      record.planSha256 !== researchHash(researchRead(join(state.directory, "provider-roots", record.unit, "plan.json"))) ||
      JSON.stringify({ schemaVersion: record.schemaVersion, profile: record.profile, specSha256: record.specSha256,
        artifactSha256: record.artifactSha256, homeSha256: record.homeSha256, roots: record.roots }) !== JSON.stringify(binding)) researchInvalid();
}

/** Cheap private binding plus actual source-pin observation. The sealed first
 * plan covers future providers because their effect path enforces this same
 * immutable extent. Pending reservations therefore need no heartbeat/plan. */
export function observeResearchMimoAllocationWritableRoots(spec: ResearchStartSpec): readonly ResearchProviderWritableRoot[] {
  assertResearchInitialRoot(true);
  if (spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || spec.registeredHandoff) researchInvalid();
  const directory = join(researchAuthorityRoot, researchName(spec.request.jobId), "starts", spec.startId);
  const path = join(directory, "mimo-writable-footprint.json"), bytes = researchRead(path);
  const record = researchRecord(researchJson(bytes), "schemaVersion,profile,specSha256,artifactSha256,homeSha256,roots,unit,planSha256");
  if (record.schemaVersion !== 1 || record.profile !== ResearchWriterFootprintProfile.MimoLifetimeV1 ||
      record.specSha256 !== researchHash(researchRead(join(directory, "spec.json"))) || record.artifactSha256 !== spec.artifactSha256 ||
      record.homeSha256 !== researchHash(researchRead(join(directory, "mimo-home.json"))) ||
      typeof record.unit !== "string" || !researchProviderUnitPattern.test(record.unit)) researchInvalid();
  const planPath = join(directory, "provider-roots", record.unit, "plan.json");
  if (record.planSha256 !== researchHash(researchRead(planPath))) researchInvalid();
  const homeRecord = researchRecord(researchJson(researchRead(join(directory, "mimo-home.json"))), "schemaVersion,specSha256,identity");
  const homeIdentity = researchRecord(homeRecord.identity, "path,device,inode");
  if (typeof homeIdentity.path !== "string") researchInvalid();
  assertResearchMimoProviderHome(spec, homeIdentity.path);
  const roots = footprintRoots(observeRetainedResearchProviderWritableRoots(spec, record.unit));
  if (JSON.stringify(roots) !== JSON.stringify(record.roots) || !researchRead(path).equals(bytes) ||
      record.planSha256 !== researchHash(researchRead(planPath)) ||
      record.homeSha256 !== researchHash(researchRead(join(directory, "mimo-home.json")))) researchInvalid();
  return roots;
}

type AllocatedRootObservation = Pick<Retained, "host" | "spec" | "unit" | "directory" | "record" | "omittedCaches"> & {
  readonly bindings: readonly Binding[];
};

/** Initial-host owner read model. A protected retained record supplies facts,
 * never an opaque launch permit; no parsed DTO is adopted into the WeakMap.
 * Source pins are observed in the host namespace, never nominal child targets.
 */
export function observeRetainedResearchProviderWritableRoots(value: ResearchStartSpec, unit: string): readonly ResearchProviderWritableRoot[] {
  assertResearchInitialRoot(true);
  const spec = parseResearchStartSpec(value);
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const directory = join(researchAuthorityRoot, researchName(spec.request.jobId), "starts", spec.startId);
  const reservation = readResearchProviderReservation(directory, unit);
  if (JSON.stringify(reservation.spec) !== JSON.stringify(spec)) researchInvalid();
  const unitDirectory = join(directory, "provider-roots", unit), record = nativeHost.record(join(unitDirectory, "plan.json"));
  const parsed = researchRecord(researchJson(Buffer.from(record)), "schemaVersion,unit,specSha256,artifactSha256,captured,materialized,skeleton,custody");
  if (parsed.schemaVersion !== 1 || parsed.unit !== unit || parsed.specSha256 !== reservation.specSha256 ||
      parsed.artifactSha256 !== spec.artifactSha256 || parsed.custody !== rootCustody(unitDirectory, nativeHost)) researchInvalid();
  const captured = researchRecord(parsed.captured, "omittedCaches,bindings,aliases,fileLinks,observations,files");
  if (!Array.isArray(parsed.materialized) || !Array.isArray(captured.bindings) ||
      !Array.isArray(captured.omittedCaches) || !Array.isArray(captured.observations) ||
      parsed.materialized.length > 128 || captured.bindings.length > 128 || captured.omittedCaches.length > 30 ||
      captured.observations.length > 512) researchInvalid();
  const bindings = parsed.materialized as Binding[];
  for (const bind of bindings) {
    researchRecord(bind, "source,target,access,identity,backing,file");
    researchPath(bind.source); researchPath(bind.target);
    if (!Object.values(ResearchRootMountAccess).includes(bind.access) || typeof bind.file !== "boolean" ||
        !Array.isArray(bind.identity) || bind.identity.length !== 2 ||
        !bind.identity.every(id => Number.isSafeInteger(id) && id >= 0)) researchInvalid();
  }
  const writable = bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite);
  if (writable.length < 2 || writable.length > 5) researchInvalid();
  if (JSON.stringify(writable) !== JSON.stringify((captured.bindings as Binding[])
      .filter(bind => bind.access === ResearchRootMountAccess.ReadWrite))) researchInvalid();
  const jobBind = writable.find(bind => bind.target === spec.request.jobRootDir);
  const workspaceBind = writable.find(bind => bind.target === spec.request.workspacePath);
  if (!jobBind || !workspaceBind || jobBind.source !== join(directory, "pins/job") ||
      workspaceBind.source !== join(directory, "pins/workspace") ||
      jobBind.identity[0] !== spec.jobDirectory.device || jobBind.identity[1] !== spec.jobDirectory.inode ||
      workspaceBind.identity[0] !== spec.workspaceDirectory.device || workspaceBind.identity[1] !== spec.workspaceDirectory.inode) researchInvalid();
  // The closed recipe binds these explicit nonrecursive sources. Its nominal
  // targets live in another namespace; only source pins are compared here.
  const observe = (): ResearchProviderWritableRoot[] => writable.map(bind => {
    const before = nativeHost.info(bind.source);
    if (bind.file || !before.isDirectory() || before.isSymbolicLink() ||
        nativeHost.canonical(bind.source) !== bind.source || before.dev !== bind.identity[0] || before.ino !== bind.identity[1]) researchInvalid();
    const roots = inspectKernelPathBackings(bind.source), root = roots[0];
    if (roots.length !== 1 || !root || root.device !== bind.backing.device || root.backingPath !== bind.backing.path) researchInvalid();
    const after = nativeHost.info(bind.source);
    if (after.dev !== before.dev || after.ino !== before.ino) researchInvalid();
    return { source: bind.source, target: bind.target, device: root.device, backingPath: root.backingPath };
  });
  const roots = observe();
  const fresh = readResearchProviderReservation(directory, unit);
  if (JSON.stringify(fresh.spec) !== JSON.stringify(spec) || nativeHost.record(join(unitDirectory, "plan.json")) !== record ||
      JSON.stringify(observe()) !== JSON.stringify(roots) || rootCustody(unitDirectory, nativeHost) !== parsed.custody) researchInvalid();
  return Object.freeze(roots.map(root => Object.freeze(root)));
}

function observeAllocatedResearchRoots(state: AllocatedRootObservation): readonly ResearchProviderWritableRoot[] {
  const { host, spec, unit, directory } = state;
  const recordPath = join(directory, "provider-roots", unit, "plan.json");
  const assertBinding = (): void => {
    const reservation = readResearchProviderReservation(directory, unit);
    if (JSON.stringify(reservation.spec) !== JSON.stringify(spec) ||
        host.record(recordPath) !== state.record) researchInvalid();
  };
  assertBinding();
  const mounts = mountTable(host);
  const writable = state.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite);
  if (writable.length < 2 || writable.length > 5 || state.omittedCaches.length > 30) researchInvalid();
  const assertOmissions = (): void => {
    for (const omitted of state.omittedCaches) {
      const basePath = join(directory, "pins/job", relative(spec.request.jobRootDir, omitted.target));
      const source = host.info(omitted.source), target = host.info(omitted.target), base = host.info(basePath);
      if ([source, target, base].some(info => !info.isDirectory() || info.isSymbolicLink()) ||
          source.dev !== omitted.identity[0] || source.ino !== omitted.identity[1] ||
          target.dev !== source.dev || target.ino !== source.ino ||
          base.dev !== omitted.baseIdentity[0] || base.ino !== omitted.baseIdentity[1] ||
          host.canonical(omitted.source) !== omitted.source || host.canonical(omitted.target) !== omitted.target ||
          host.canonical(basePath) !== basePath || host.entries(basePath).length ||
          JSON.stringify(backing(omitted.source, mounts)) !== JSON.stringify(omitted.backing) ||
          JSON.stringify(backing(omitted.target, mounts, true)) !== JSON.stringify(omitted.mounted) ||
          JSON.stringify(backing(basePath, mounts, true)) !== JSON.stringify(omitted.base) ||
          mounts.some(m => m.point !== omitted.source && contains(omitted.source, m.point)) ||
          mounts.some(m => m.point !== basePath && contains(basePath, m.point))) researchInvalid();
    }
  };
  const observe = (): ResearchProviderWritableRoot[] => writable.map(bind => {
    const source = host.info(bind.source), target = host.info(bind.target);
    if (!source.isDirectory() || source.isSymbolicLink() || !target.isDirectory() || target.isSymbolicLink() ||
        host.canonical(bind.source) !== bind.source || host.canonical(bind.target) !== bind.target ||
        source.dev !== bind.identity[0] || source.ino !== bind.identity[1] ||
        target.dev !== source.dev || target.ino !== source.ino) researchInvalid();
    const current = backing(bind.source, mounts, true), nominal = backing(bind.target, mounts, true);
    if (nativeDevice(source) !== current.device || JSON.stringify(current) !== JSON.stringify(bind.backing) ||
        !sameBacking(current, nominal)) researchInvalid();
    // A new descendant bind could redirect writes outside the retained graph.
    for (const mount of mounts.filter(m => m.point !== bind.target && contains(bind.target, m.point))) {
      const child = state.bindings.find(candidate => candidate.target === mount.point);
      if (child && sameBacking(child.backing, backing(mount.point, mounts, true))) continue;
      // A retained foreign cache is absent from the nonrecursive job pin. Its
      // empty underlying anchor is covered by job RW; the foreign source is not.
      if (state.omittedCaches.some(omitted => omitted.target === mount.point &&
          sameBacking(omitted.mounted, backing(mount.point, mounts, true)))) continue;
      researchInvalid();
    }
    return { source: bind.source, target: bind.target, device: current.device, backingPath: current.path };
  });
  assertOmissions();
  const roots = observe();
  assertBinding();
  if (JSON.stringify(mountTable(host)) !== JSON.stringify(mounts) ||
      JSON.stringify(observe()) !== JSON.stringify(roots)) researchInvalid();
  assertOmissions();
  assertBinding();
  return Object.freeze(roots.map(root => Object.freeze(root)));
}

export function assertResearchProviderRoot(plan: ResearchProviderRootPlan, value: ResearchStartSpec, unit: string, home: string): void {
  return observeRootFailure(ResearchProviderRootCheck.Assert, () => {
  const state = retained.get(plan), spec = parseResearchStartSpec(value);
  if (!state || state.unit !== unit || state.home !== home || JSON.stringify(state.spec) !== JSON.stringify(spec)) researchInvalid();
  const reservation = readResearchProviderReservation(state.directory, unit);
  if (JSON.stringify(reservation.spec) !== JSON.stringify(spec)) researchInvalid();
  const current = snapshot(spec, state.directory, unit, home, state.host, state.scratchHost);
  for (const file of current.files) {
    const bind = plan.bindings.find(entry => entry.target === file.target);
    if (!bind || bind.source !== join(state.directory, "provider-roots", state.unit, file.name)) researchInvalid();
    const info = state.host.info(bind.source);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o444 ||
        info.dev !== bind.identity[0] || info.ino !== bind.identity[1] || JSON.stringify(backing(bind.source, mountTable(state.host))) !== JSON.stringify(bind.backing) ||
        state.host.regular(bind.source, info, file.role) !== file.bytes) researchInvalid();
  }
  const names = ["plan.json", "root", ...current.files.map(file => file.name)].sort().join(",");
  if (JSON.stringify(current) !== state.snapshot || JSON.stringify(plan.bindings) !== state.materialized || skeletonIdentity(skeletonEntries(plan.fixedRootDirectory, current), state.host) !== state.skeleton ||
      rootCustody(dirname(plan.fixedRootDirectory), state.host) !== state.custody || [...state.host.entries(dirname(plan.fixedRootDirectory))].sort().join(",") !== names ||
      state.host.record(join(dirname(plan.fixedRootDirectory), "plan.json")) !== state.record) researchInvalid();
  });
}
