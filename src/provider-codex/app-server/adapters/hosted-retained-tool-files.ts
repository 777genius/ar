import { observedProcessCgroup } from "../../../worker-codex/hosted-readonly-observations";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dependencyToolGuestConfig, dependencyToolGuestConfigPath, dependencyToolQualificationRecordName,
  parseDependencyToolQualification, type DependencyToolQualification } from "../../../core/dependency-environment/dependency-tool-profile";
import { fdCollectorProfilePath } from "../../../core/host-infrastructure/fd-collector-profile";
import { decodeHostedInventoryBytes } from "../../../core/host-infrastructure/host-inventory";
import { hostedFdTable } from "./hosted-fd-table";
import { assertHostedFdProcess, HostedFdLaunchKind } from "./hosted-fd-child";
import { hostedDependencySystemdRunExecutable } from "./hosted-dependency-systemd-command";

const root = "/var/lib/subscription-runtime-host-policy";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(): never { throw new Error("hosted_retained_tool_files_denied"); }
type Anchor = Readonly<{ path: string; dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint; mount: string }>;
type Leaf = Readonly<{ path: string; fd: number; dev: bigint; ino: bigint; mode: bigint; ctime: bigint; mtime: bigint;
  flags: number; mount: string; bytes: Buffer; sha256: string; ancestors: readonly Anchor[] }>;
export type HostedRetainedToolFiles = Readonly<object>;
type State = { readonly unit: string; readonly parentStartId: string; readonly root: string; readonly parentBirth: string;
  readonly group: string; readonly namespace: string; readonly leaves: readonly Leaf[];
  readonly snapshots: readonly Leaf[]; invocation?: object; command?: string; args?: readonly string[];
  child?: ChildProcess; revoked: boolean };
const scopes = new WeakMap<object, State>(), children = new WeakMap<object, object>();
function state(scope: HostedRetainedToolFiles): State { const s = scopes.get(scope); if (!s || s.revoked) fail(); return s; }
function selfBirth(): string {
  const bytes = readFileSync("/proc/self/stat", "utf8"), at = bytes.lastIndexOf(") ");
  const tick = bytes.slice(at + 2).trim().split(/\s+/)[19];
  if (!bytes.startsWith(process.pid + " (") || at < 0 || !tick || !/^[1-9][0-9]*$/.test(tick)) fail();
  return process.pid + ":" + tick;
}
function fdInfo(fd: number): { flags: number; mount: string } {
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  const flags = /^flags:\s+([0-7]{1,12})$/m.exec(info), mount = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(info);
  if (!flags || !mount) fail();
  return { flags: Number.parseInt(flags[1]!, 8), mount: mount[1]! };
}
function anchors(path: string): readonly Anchor[] {
  const pins: Anchor[] = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const named = lstatSync(p, { bigint: true });
    if (!named.isDirectory() || named.uid !== 0n || named.gid !== 0n || (named.mode & 0o022n) || realpathSync(p) !== p) fail();
    const fd = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd, { bigint: true }), current = lstatSync(p, { bigint: true });
      if (actual.dev !== named.dev || actual.ino !== named.ino || current.dev !== actual.dev || current.ino !== actual.ino) fail();
      pins.push(Object.freeze({ path: p, dev: actual.dev, ino: actual.ino, mode: actual.mode,
        uid: actual.uid, gid: actual.gid, mount: fdInfo(fd).mount }));
    } finally { closeSync(fd); }
    if (p === "/") break;
    if (pins.length >= 128) fail();
  }
  return Object.freeze(pins);
}
function readFd(fd: number, bound: number): Buffer {
  const s = fstatSync(fd, { bigint: true });
  if (!s.isFile() || s.size <= 0n || s.size > BigInt(bound)) fail();
  const bytes = Buffer.alloc(Number(s.size) + 1); let length = 0;
  while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
  if (BigInt(length) !== s.size) fail(); return bytes.subarray(0, length);
}
function openLeaf(path: string, bound: number): Leaf {
  const parents = anchors(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true }), info = fdInfo(fd);
    if (!actual.isFile() || actual.uid !== 0n || actual.gid !== 0n || actual.nlink !== 1n || (actual.mode & 0o077n) ||
        actual.dev !== named.dev || actual.ino !== named.ino || realpathSync(path) !== path ||
        (info.flags & 3) || !(info.flags & 0o2000000) || (info.flags & 0o10000000)) fail();
    const bytes = readFd(fd, bound);
    const leaf = Object.freeze({ path, fd, dev: actual.dev, ino: actual.ino, mode: actual.mode,
      ctime: actual.ctimeNs, mtime: actual.mtimeNs, ...info, bytes, sha256: hash(bytes), ancestors: parents });
    assertLeaf(leaf); return leaf;
  } catch (error) { closeSync(fd); throw error; }
}
function assertLeaf(leaf: Leaf): void {
  const actual = fstatSync(leaf.fd, { bigint: true }), named = lstatSync(leaf.path, { bigint: true }), info = fdInfo(leaf.fd);
  if (!actual.isFile() || actual.uid !== 0n || actual.gid !== 0n || actual.nlink !== 1n || actual.mode !== leaf.mode ||
      actual.dev !== leaf.dev || actual.ino !== leaf.ino || actual.ctimeNs !== leaf.ctime || actual.mtimeNs !== leaf.mtime ||
      named.dev !== leaf.dev || named.ino !== leaf.ino || named.ctimeNs !== leaf.ctime || named.mtimeNs !== leaf.mtime ||
      actual.size !== BigInt(leaf.bytes.length) || info.flags !== leaf.flags || info.mount !== leaf.mount ||
      readlinkSync(`/proc/self/fd/${leaf.fd}`) !== leaf.path || realpathSync(leaf.path) !== leaf.path ||
      !readFd(leaf.fd, leaf.bytes.length).equals(leaf.bytes) || hash(leaf.bytes) !== leaf.sha256) fail();
  const current = anchors(leaf.path);
  if (current.length !== leaf.ancestors.length || current.some((a, i) => {
    const p = leaf.ancestors[i]!; return a.path !== p.path || a.dev !== p.dev || a.ino !== p.ino ||
      a.mode !== p.mode || a.uid !== p.uid || a.gid !== p.gid || a.mount !== p.mount;
  })) fail();
  const after = fstatSync(leaf.fd, { bigint: true }), entry = lstatSync(leaf.path, { bigint: true });
  if (after.ctimeNs !== leaf.ctime || after.mtimeNs !== leaf.mtime || after.dev !== leaf.dev || after.ino !== leaf.ino ||
      entry.dev !== leaf.dev || entry.ino !== leaf.ino || entry.ctimeNs !== leaf.ctime || entry.mtimeNs !== leaf.mtime ||
      fdInfo(leaf.fd).mount !== leaf.mount) fail();
}
function json(bytes: Buffer): Record<string, unknown> {
  const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(); return v as Record<string, unknown>;
}

/** Closed open/create/open operation. Context is checked against independently
 * protected records, not a caller FD, byte allowlist, root or authority callback. */
export function openHostedRetainedToolFiles(context: Readonly<{ unit: string; parentStartId: string; jobId: string; bindingBytes: Buffer }>): Readonly<{
  scope: HostedRetainedToolFiles; qualification: DependencyToolQualification; capsulePath: string;
}> {
  const id = /^subscription-runtime-hosted-([a-f0-9-]{36})\.service$/.exec(context.unit)?.[1];
  if (!id || !uuid.test(id) || !uuid.test(context.parentStartId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context.jobId)) fail();
  const providerRoot = `${root}/dependency-provider-roots/${id}`;
  const names = ["host-installation.json", "readonly-inventory.json", "fd-collector-profile.v1.json",
    `dependency-bindings/${hash(context.jobId)}.json`, `ordinary-starts/${context.parentStartId}.json`,
    `ordinary-starts/${id}.json`, `dependency-provider-attempts/${id}.json`];
  const snapshots: Leaf[] = [], leaves: Leaf[] = [];
  let scope: HostedRetainedToolFiles | undefined;
  try {
    for (const name of names) { const leaf = openLeaf(join(root, name), 4 * 1024 * 1024); snapshots.push(leaf); closeSync(leaf.fd); }
    const installation = json(snapshots[0]!.bytes), inventory = decodeHostedInventoryBytes(snapshots[1]!.bytes) as Record<string, unknown>, binding = json(snapshots[3]!.bytes),
      parent = json(snapshots[4]!.bytes), provider = json(snapshots[5]!.bytes), relation = json(snapshots[6]!.bytes);
    const pin = inventory.collectorProfile as { path?: unknown; sha256?: unknown } | undefined;
    if (!snapshots[3]!.bytes.equals(context.bindingBytes) || binding.version !== 2 || binding.jobId !== context.jobId ||
        installation.installationId !== binding.installationId || installation.runtimeSha !== binding.runtimeSha ||
        installation.inventorySha256 !== hash(snapshots[1]!.bytes) || ![4, 5].includes(inventory.schemaVersion as number) ||
        !pin || pin.path !== fdCollectorProfilePath || pin.sha256 !== hash(snapshots[2]!.bytes) ||
        parent.unit !== `subscription-runtime-ordinary-${context.parentStartId}.service` || parent.jobId !== context.jobId ||
        provider.unit !== context.unit || provider.jobId !== context.jobId || provider.installationId !== parent.installationId ||
        provider.creatorId !== parent.creatorId || provider.grantSha256 !== binding.grantDigest ||
        parent.installationId !== binding.installationId || parent.grantSha256 !== binding.grantDigest ||
        parent.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${parent.unit}` ||
        observedProcessCgroup(readFileSync("/proc/self/cgroup", "utf8")) !== `0::${parent.controlGroup}` ||
        relation.parentStartId !== context.parentStartId || relation.providerStartId !== id || relation.unit !== context.unit ||
        relation.startDigest !== hash(snapshots[5]!.bytes)) fail();
    const record = openLeaf(join(root, dependencyToolQualificationRecordName(context.parentStartId)), 65536); leaves.push(record);
    const q = parseDependencyToolQualification(json(record.bytes));
    if (!encode(q).equals(record.bytes) || q.startId !== context.parentStartId || q.installationId !== binding.installationId ||
        q.runtimeSha !== binding.runtimeSha || q.grantDigest !== binding.grantDigest || q.attemptId !== relation.attemptId ||
        q.epoch !== relation.epoch || !encode(q.workspace).equals(encode(binding.workspace))) fail();
    const rootStat = lstatSync(providerRoot);
    if (!rootStat.isDirectory() || rootStat.uid !== 0 || rootStat.gid !== 0 || (rootStat.mode & 0o777) !== 0o700) fail();
    const capsulePath = join(providerRoot, dependencyToolGuestConfigPath);
    const fd = openSync(capsulePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, encode(dependencyToolGuestConfig(q))); fsyncSync(fd); } finally { closeSync(fd); }
    const parentFd = openSync(dirname(capsulePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    const capsule = openLeaf(capsulePath, 65536); leaves.push(capsule);
    if (!capsule.bytes.equals(encode(dependencyToolGuestConfig(q)))) fail();
    scope = Object.freeze({});
    scopes.set(scope, { unit: context.unit, parentStartId: context.parentStartId, root: providerRoot,
      parentBirth: selfBirth(), group: observedProcessCgroup(readFileSync("/proc/self/cgroup", "utf8")),
      namespace: readlinkSync("/proc/self/ns/mnt"), leaves: Object.freeze(leaves), snapshots: Object.freeze(snapshots), revoked: false });
    assertHostedRetainedToolDescriptors(scope);
    return Object.freeze({ scope, qualification: q, capsulePath });
  } catch (error) {
    if (scope) revokeHostedRetainedToolFiles(scope);
    else for (const leaf of leaves) try { closeSync(leaf.fd); } catch { /* Fail closed; never reopen. */ }
    throw error;
  }
}
export function assertHostedRetainedToolDescriptors(scope: HostedRetainedToolFiles): void {
  const s = state(scope);
  try {
    for (const fd of [0, 1, 2]) {
      const stat = fstatSync(fd);
      if (!stat.isFIFO() && !stat.isSocket()) throw new Error("hosted_custody_stdio_pipe_required");
    }
    if (s.parentBirth !== selfBirth() || s.group !== observedProcessCgroup(readFileSync("/proc/self/cgroup", "utf8")) ||
        s.namespace !== readlinkSync("/proc/self/ns/mnt")) fail();
    for (const leaf of s.leaves) assertLeaf(leaf);
    for (const old of s.snapshots) {
      const fresh = openLeaf(old.path, old.bytes.length);
      try { if (fresh.dev !== old.dev || fresh.ino !== old.ino || fresh.ctime !== old.ctime || fresh.mtime !== old.mtime ||
          fresh.mount !== old.mount || !fresh.bytes.equals(old.bytes) ||
          JSON.stringify(fresh.ancestors, (_, v: unknown) => typeof v === "bigint" ? String(v) : v) !==
          JSON.stringify(old.ancestors, (_, v: unknown) => typeof v === "bigint" ? String(v) : v)) fail(); }
      finally { closeSync(fresh.fd); }
    }
    const table = hostedFdTable(process.pid);
    for (const fd of table) {
      if (fd.fd <= 2 || !fd.file && !fd.directory) continue;
      const leaf = s.leaves.find(leaf => leaf.fd === fd.fd);
      if (!leaf || !fd.file || fd.target !== leaf.path || fd.dev !== String(leaf.dev) || fd.ino !== String(leaf.ino) ||
          fd.flags !== leaf.flags || (fd.flags & 3) || !(fd.flags & 0o2000000) || (fd.flags & 0o10000000)) fail();
    }
    if (s.leaves.some(leaf => !table.some(fd => fd.fd === leaf.fd && fd.file))) fail();
    for (const leaf of s.leaves) assertLeaf(leaf);
    if (JSON.stringify(hostedFdTable(process.pid)) !== JSON.stringify(table) || s.namespace !== readlinkSync("/proc/self/ns/mnt")) fail();
    if (s.child) assertHostedFdProcess(s.child, s.unit, HostedFdLaunchKind.Provider, s.command, s.args);
  } catch (error) { revokeHostedRetainedToolFiles(scope); throw error; }
}
export function retainHostedToolFilesInvocation(scope: HostedRetainedToolFiles, invocation: Readonly<{
  command: string; args: readonly string[]; systemdUnit?: string;
}>): void {
  const s = state(scope);
  if (s.invocation || invocation.systemdUnit !== s.unit || invocation.command !== hostedDependencySystemdRunExecutable ||
      !invocation.args.includes(`--unit=${s.unit}`) || !invocation.args.includes(`--property=RootDirectory=${s.root}`)) fail();
  assertHostedRetainedToolDescriptors(scope);
  s.invocation = invocation; s.command = invocation.command; s.args = Object.freeze([...invocation.args]);
}
export function bindHostedToolFilesChild(scope: HostedRetainedToolFiles, invocation: object, child: ChildProcess): void {
  const s = state(scope);
  if (s.invocation !== invocation || s.child || children.has(child) || !s.command || !s.args) fail();
  assertHostedFdProcess(child, s.unit, HostedFdLaunchKind.Provider, s.command, s.args);
  s.child = child; children.set(child, scope);
  child.once("error", () => revokeHostedRetainedToolFiles(scope));
  child.once("close", () => revokeHostedRetainedToolFiles(scope));
}
export function hostedToolFilesForChild(child: object): HostedRetainedToolFiles | undefined {
  const scope = children.get(child); if (!scope) return undefined;
  const s = state(scope), actual = s.child;
  if (!actual || actual !== child) fail();
  try { assertHostedFdProcess(actual, s.unit, HostedFdLaunchKind.Provider, s.command, s.args); return scope; }
  catch (error) { revokeHostedRetainedToolFiles(scope); throw error; }
}
export function revokeHostedToolFilesForChild(child: object): void {
  const scope = children.get(child); if (scope) revokeHostedRetainedToolFiles(scope);
}
/** Compare an actual contained namespace-opened config FD with the retained
 * capsule. This cannot mint or register a descriptor exception. */
export function assertHostedToolCapsuleCopy(scope: HostedRetainedToolFiles, fd: number): void {
  const s = state(scope), capsule = s.leaves[1]; if (!capsule) fail();
  assertLeaf(capsule);
  const actual = fstatSync(fd, { bigint: true });
  if (!actual.isFile() || actual.uid !== 0n || actual.nlink !== 1n || actual.mode !== capsule.mode ||
      actual.dev !== capsule.dev || actual.ino !== capsule.ino || actual.size !== BigInt(capsule.bytes.length) ||
      !readFd(fd, capsule.bytes.length).equals(capsule.bytes)) fail();
}
export function revokeHostedRetainedToolFiles(scope: HostedRetainedToolFiles): void {
  const s = scopes.get(scope); if (!s || s.revoked) return;
  s.revoked = true; if (s.child) children.delete(s.child);
  for (const leaf of s.leaves) try { closeSync(leaf.fd); } catch { /* Revoked before any descriptor number can be reused. */ }
}
