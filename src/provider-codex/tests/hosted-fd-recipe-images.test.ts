import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedFdProcess } from "../app-server/adapters/hosted-fd-observation";
import { closedObserverFailure, AppServerObserverPoint as Point, AppServerObserverErrno as Errno } from "../app-server/domain/app-server-observer-failure";
import { readHostedFdRecipeImages } from "../app-server/adapters/hosted-fd-recipe-images";
import { assertHostedFdNamespaceAncestry, hostedFdNamespacePrefix } from "../app-server/adapters/hosted-fd-namespace-stages";
const state = vi.hoisted(() => ({ paths: new Map<string, string>(), exe: "", fds: new Set<number>(), sourceFd: -1, closeFailure: false, afterRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mapped = (path: fs.PathLike) => typeof path === "string" ? state.paths.get(path) ?? path : path;
  // Only protected ownership is synthetic. Every opened FD, inode, content,
  // nofollow failure and replacement below is from the actual temporary files.
  const owned = (info: fs.Stats | fs.BigIntStats) => { if (typeof info.uid === "bigint") { info.uid = 0n; info.gid = 0n; } else { info.uid = 0; info.gid = 0; } return info; };
  return { ...actual,
    lstatSync: (path: fs.PathLike, options?: { bigint: true }) => owned(options ? actual.lstatSync(mapped(path), options) : actual.lstatSync(mapped(path))),
    statSync: (path: fs.PathLike, options?: { bigint: true }) => owned(options ? actual.statSync(mapped(path), options) : actual.statSync(mapped(path))),
    fstatSync: (fd: number, options?: { bigint: true }) => owned(options ? actual.fstatSync(fd, options) : actual.fstatSync(fd)),
    openSync: (path: fs.PathLike, flags: number) => { const fd = actual.openSync(mapped(path), flags); state.fds.add(fd); if (path === "/usr/bin/unshare") state.sourceFd = fd; return fd; },
    closeSync: (fd: number) => { actual.closeSync(fd); state.fds.delete(fd); if (state.closeFailure) { state.closeFailure = false; throw Object.assign(Error("TEST-private-close-canary"), { code: "EIO" }); } },
    readlinkSync: (path: fs.PathLike) => path === "/proc/902/exe" ? state.exe : actual.readlinkSync(mapped(path)),
    readFileSync: (path: fs.PathOrFileDescriptor, options?: fs.ObjectEncodingOptions | BufferEncoding | null) => {
      const result = actual.readFileSync(typeof path === "number" ? path : mapped(path), options);
      if (path === state.sourceFd && state.afterRead) { const hook = state.afterRead; state.afterRead = undefined; hook(); }
      return result;
    },
  };
});
const root = "/var/lib/subscription-runtime-host-policy/dependency-provider-roots/01234567-89ab-cdef-0123-456789abcdef", canonical = "/usr/bin/unshare";
const argv = [...hostedFdNamespacePrefix, "/TEST/node", "/TEST/bootstrap.js"];
let directory = "", source = "", copy = "", stat = "", observed: HostedFdProcess;
const pins = () => [{ path: canonical, sha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"), elfFiles: [] }];
function startTicks(value: string): string { const fields = Array<string>(22).fill("0"); fields[0] = "S"; fields[1] = "1"; fields[19] = value; return `902 (TEST) ${fields.join(" ")}\n`; }
beforeEach(() => {
  state.paths.clear(); state.exe = root + canonical; state.fds.clear(); state.afterRead = undefined; state.closeFailure = false;
  directory = fs.mkdtempSync(join(tmpdir(), "TEST-recipe-image-"));
  const parent = join(directory, "usr"); fs.mkdirSync(parent, { mode: 0o700 });
  const ownedRoot = join(directory, "root"); fs.mkdirSync(ownedRoot, { mode: 0o700 });
  source = join(parent, "unshare"); copy = join(parent, "other-image");
  const bytes = Buffer.alloc(128); Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes); bytes.writeUInt16LE(62, 18);
  fs.writeFileSync(source, bytes, { mode: 0o755 }); fs.writeFileSync(copy, bytes, { mode: 0o755 });
  stat = join(directory, "stat"); fs.writeFileSync(stat, startTicks("77"));
  const cmdline = join(directory, "cmdline"); fs.writeFileSync(cmdline, [...argv, ""].join("\0"));
  const group = join(directory, "cgroup"); fs.writeFileSync(group, "0::/TEST-service\n");
  for (const [a, b] of [[root, ownedRoot], ["/usr", directory], ["/usr/bin", parent], [canonical, source],
    ["/proc/902/exe", source], ["/proc/902/root" + canonical, source], ["/proc/902/root", ownedRoot],
    ["/proc/902/stat", stat], ["/proc/902/cmdline", cmdline], ["/proc/902/cgroup", group]]) state.paths.set(a!, b!);
  for (const path of ["/var", "/var/lib", "/var/lib/subscription-runtime-host-policy", "/var/lib/subscription-runtime-host-policy/dependency-provider-roots"]) state.paths.set(path, directory);
  observed = { pid: 902, parentPid: 1, birth: "902:77", argv, exe: state.exe, group: "0::/TEST-service", net: "TEST", user: "TEST", mount: "TEST", pidNamespace: "TEST", uidMap: "TEST", gidMap: "TEST", status: "TEST", descriptors: [] };
});
afterEach(() => { expect(state.fds.size).toBe(0); fs.rmSync(directory, { recursive: true, force: true }); });
it.each([false, true])("authenticates the same physical pinned image before projecting exact recipe argv (alias=%s)", alias => {
  state.exe = alias ? root + canonical : canonical; observed = { ...observed, exe: state.exe };
  const images = readHostedFdRecipeImages([observed], pins(), root, () => 1000);
  expect(observed.exe).toBe(state.exe); expect(images.processes[0]!.exe).toBe(canonical);
  expect(() => assertHostedFdNamespaceAncestry(argv, images.processes, 902)).not.toThrow();
  images.revalidate(); expect(state.fds.size).toBe(0);
});
it("keeps foreign root, prefix and basename spellings untrusted", () => {
  for (const exe of ["/TEST-other-root" + canonical, root + "-foreign" + canonical, "unshare", "/foreign/unshare"]) {
    state.exe = exe; const raw = { ...observed, exe };
    const images = readHostedFdRecipeImages([raw], pins(), root, () => 1000);
    expect(images.processes[0]!.exe).toBe(exe);
    expect(() => assertHostedFdNamespaceAncestry(argv, images.processes, 902)).toThrow("hosted_fd_namespace_stage_unresolved");
  }
});
it("rejects byte-identical foreign image and observed-root view inodes", () => {
  expect(fs.readFileSync(source).equals(fs.readFileSync(copy))).toBe(true);
  expect(fs.statSync(source).ino).not.toBe(fs.statSync(copy).ino);
  for (const path of ["/proc/902/exe", "/proc/902/root" + canonical]) {
    state.paths.set(path, copy);
    expect(() => readHostedFdRecipeImages([observed], pins(), root, () => 1000)).toThrow();
    state.paths.set(path, source);
  }
  state.paths.set("/proc/902/root", directory);
  expect(() => readHostedFdRecipeImages([observed], pins(), root, () => 1000)).toThrow();
});
it("rejects symlink source/view and deleted source names without leaking held descriptors", () => {
  const link = join(directory, "alias"); fs.symlinkSync(source, link);
  const selected = pins();
  for (const path of [canonical, "/proc/902/root" + canonical]) {
    state.paths.set(path, link);
    expect(() => readHostedFdRecipeImages([observed], selected, root, () => 1000)).toThrow();
    state.paths.set(path, source);
  }
  state.exe += " (deleted)";
  expect(() => readHostedFdRecipeImages([observed], selected, root, () => 1000)).toThrow();
});
it("rejoins birth, group, pinned source hash and actual image after observation", () => {
  const selected = pins(), images = readHostedFdRecipeImages([observed], selected, root, () => 1000);
  fs.writeFileSync(stat, startTicks("78")); expect(() => images.revalidate()).toThrow(); fs.writeFileSync(stat, startTicks("77"));
  const group = state.paths.get("/proc/902/cgroup")!; fs.writeFileSync(group, "0::/TEST-other\n"); expect(() => images.revalidate()).toThrow(); fs.writeFileSync(group, "0::/TEST-service\n");
  state.paths.set("/proc/902/exe", copy); expect(() => images.revalidate()).toThrow(); state.paths.set("/proc/902/exe", source);
  const replacement = Buffer.from(fs.readFileSync(source)); replacement[70] = 1; fs.writeFileSync(source, replacement);
  expect(() => images.revalidate()).toThrow();
});
it("refuses a later byte-identical source/image replacement inode", () => {
  const images = readHostedFdRecipeImages([observed], pins(), root, () => 1000);
  fs.renameSync(copy, source);
  expect(() => images.revalidate()).toThrow("hosted_fd_namespace_stage_unresolved");
});
it("rejects image replacement during a held-source read and closes every local FD on refusal", () => {
  state.afterRead = () => state.paths.set("/proc/902/exe", copy);
  expect(() => readHostedFdRecipeImages([observed], pins(), root, () => 1000)).toThrow();
  expect(state.fds.size).toBe(0);
});

it("retains only a closed image predicate and errno when collection or close refuses", () => {
  state.closeFailure = true; let failure: unknown;
  try { readHostedFdRecipeImages([observed], pins(), root, () => 1000); } catch (error) { failure = error; }
  expect((failure as Error).message).toBe("hosted_fd_namespace_stage_unresolved");
  expect(closedObserverFailure(failure, Point.Native, 0)).toMatchObject({ point: Point.ImageClose, errno: Errno.EIO });
  expect(JSON.stringify(closedObserverFailure(failure, Point.Native, 0))).not.toContain("canary");
  expect(state.fds.size).toBe(0);
});

it("cold-loads the exact finite compiled RootDirectory fixture closure", () => {
  const result = spawnSync(globalThis.process.execPath, [fileURLToPath(new URL("./fixtures/hosted-fd-recipe-root-native.mts", import.meta.url)), "--closure"],
    { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 15000, maxBuffer: 4096 });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
  expect(result.stdout).toBe("TEST finite root closure complete\n");
});

it("transports only bounded closed native/assertion facts across the actual fixture child boundary", () => {
  const fixture = fileURLToPath(new URL("./fixtures/hosted-fd-recipe-root-native.mts", import.meta.url));
  function run(selected: string): { output: string; fact: Record<string, unknown> } {
    const result = spawnSync(globalThis.process.execPath, [fixture, "--diagnostic-case", selected], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeLessThan(2048); expect(result.stderr).toMatch(/^TEST-root-failure \{[\x20-\x7e]+\}\n$/);
    expect(result.stderr).not.toMatch(/canary|private|auth|\/|\\|stack/);
    return { output: result.stderr, fact: JSON.parse(result.stderr.slice("TEST-root-failure ".length)) as Record<string, unknown> };
  }
  expect(run("native").fact).toMatchObject({ mode: "diagnostic", stage: "diagnostic_case", name: "Error", errno: "EROFS" });
  expect(run("nested").output).toBe(run("native").output);
  expect(run("nested_assertion").fact).toMatchObject({ name: "AssertionError", operator: "strictEqual", actual: "number", actualNumber: 23, expectedNumber: 18 });
  expect(run("string").fact).toMatchObject({ name: "AssertionError", actual: "string", expected: "string", actualNumber: -1, expectedNumber: -1 });
  expect(run("poison").fact).toMatchObject({ primitive: "diagnostic_child", status: 1, stderrCode: "unknown" });
  expect(run("bootstrap").fact).toMatchObject({ primitive: "diagnostic_child", status: 1, stderrCode: "module_missing" });
});

it.runIf(globalThis.process.platform === "linux")("checks the actual private RootDirectory alias and foreign view inode with the compiled image boundary", context => {
  const result = spawnSync(globalThis.process.execPath, [fileURLToPath(new URL("./fixtures/hosted-fd-recipe-root-native.mts", import.meta.url))],
    { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 40000, maxBuffer: 8192 });
  if (result.status === 77 && result.stdout === "TEST root namespace capability unavailable\n") { context.skip(); return; }
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
  const rows = result.stdout.trim().split("\n");
  expect(rows).toHaveLength(2); expect(rows[1]).toBe("TEST owned RootDirectory image projection accepted");
  expect(rows[0]).toMatch(/^TEST-node-maps \{[\x20-\x7e]+\}$/);
  console.info(rows[0]); // Closed booleans/counts only, useful on the mandatory ROOT CI lane.
});
