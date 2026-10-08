import {
  assemblyDescriptorIo, assemblyUnit, preparePrivateRootAssemblyFixture,
  setupPrivateRootAssemblyFixture,
} from "./private-root-assembly-fixture";
import { cleanupResearchFixture, host, local } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { assertResearchProviderAssemblyContext, readResearchProviderAssemblyRoot, type ResearchProviderAssemblyRoot } from "../research-provider-root";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import type { ResearchInitialHostContext } from "../research-launch-host";

beforeEach(setupPrivateRootAssemblyFixture);
afterEach(cleanupResearchFixture);
const denied = "hosted_research_launch_denied";
function expectClosed(fd: number): void {
  expect(() => assemblyDescriptorIo.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
}
function snapshotWrite(path: string, bytes: string): void {
  fs.chmodSync(local(path), 0o644);
  try { fs.writeFileSync(path, bytes); }
  finally { fs.chmodSync(local(path), 0o444); }
}

describe("sealed provider assembly reader over native TEST descriptors", () => {
  // RED if reader authority is replaced by a structural context or its own
  // reduced-role assertion still needs a foreign namespace read.
  it("uses the genuine sealed Host witness and refuses a copied reader", () => {
    const f = preparePrivateRootAssemblyFixture(), root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    const initial = { user: "user:[4026531837]", mnt: "mnt:[4026531841]", pid: "pid:[4026531836]", net: "net:[4026531840]" };
    const readlink = fs.readlinkSync;
    try {
      expect(root.initialHostContext).toEqual({ bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", machineId: "b".repeat(32), namespaces: initial });
      host.processNamespaces.set(process.pid, { ...initial, mnt: "mnt:[4026532841]" });
      vi.spyOn(fs, "readlinkSync").mockImplementation(((path: fs.PathLike, options?: Parameters<typeof fs.readlinkSync>[1]) => {
        if (typeof path === "string" && /^\/proc\/(?:1|[0-9]+)\/ns\//.test(path) && !path.startsWith(`/proc/${process.pid}/`))
          throw Object.assign(new Error("TEST foreign namespace unavailable"), { code: "EACCES" });
        return readlink(path, options);
      }) as typeof fs.readlinkSync);
      const calls = host.calls.length;
      expect(() => assertResearchProviderAssemblyContext(root)).not.toThrow();
      expect(() => assertResearchProviderAssemblyContext({ ...root })).toThrow(denied);
      expect(host.calls).toHaveLength(calls); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { root.close(); }
    expect(() => assertResearchProviderAssemblyContext(root)).toThrow(denied);
  });

  // Exercise the fixed reader parser beyond the generic digest fence: these
  // corruptions start from a genuine creator record and have a self-consistent
  // caller digest, which still cannot mint a valid context or branded creator.
  it.each(["missing", "duplicate", "wrong-label", "extra-field"] as const)("rejects a %s sealed reference before pinning assembly sources", fault => {
    const f = preparePrivateRootAssemblyFixture(), path = join(dirname(f.plan.fixedRootDirectory), "plan.json");
    const record = JSON.parse(researchRead(path).toString()) as { captured: { observations: unknown[] } };
    const entry = record.captured.observations.find(value => Array.isArray(value) && value[0] === "initial-host-context");
    if (!Array.isArray(entry)) throw new Error("Missing genuine TEST creator reference");
    if (fault === "missing") record.captured.observations = record.captured.observations.filter(value => value !== entry);
    if (fault === "duplicate") record.captured.observations.push(entry);
    const context = entry[1] as ResearchInitialHostContext;
    if (fault === "wrong-label") entry[1] = { ...context, namespaces: { ...context.namespaces, mnt: "user:[4026531841]" } };
    if (fault === "extra-field") entry[1] = { ...context, skipRoot: true };
    researchPublish(path, record);
    const open = vi.spyOn(fs, "openSync"), calls = host.calls.length;
    expect(() => readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, researchHash(researchRead(path)))).toThrow(denied);
    expect(open.mock.calls.some(([selected]) => selected === f.plan.fixedRootDirectory || f.plan.bindings.some(bind => bind.source === selected))).toBe(false);
    expect(host.calls).toHaveLength(calls); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
  });

  // RED if a valid captured reference is treated as evidence about changed self
  // context rather than compared with current kernel observations before effects.
  it.each(["boot", "machine", "user", "pid", "net", "host-mnt", "stat-unavailable", "cgroup-malformed", "shared"] as const)("rejects changed own %s through the genuine reader", fault => {
    const f = preparePrivateRootAssemblyFixture(), root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    const own = { ...root.initialHostContext.namespaces, mnt: "mnt:[4026532841]" };
    try {
      host.processNamespaces.set(process.pid, own);
      expect(() => assertResearchProviderAssemblyContext(root)).not.toThrow();
      if (fault === "boot") host.boot = "dddddddd-dddd-dddd-dddd-dddddddddddd";
      if (fault === "machine" || fault === "stat-unavailable" || fault === "cgroup-malformed") {
        const read = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
          if (fault === "machine" && path === "/etc/machine-id") return "c".repeat(32);
          if (fault === "stat-unavailable" && path === `/proc/${process.pid}/stat`) throw Object.assign(new Error("TEST process disappeared"), { code: "ESRCH" });
          if (fault === "cgroup-malformed" && path === `/proc/${process.pid}/cgroup`) return "0::relative\n";
          return read(path, options);
        }) as typeof fs.readFileSync);
      }
      if (fault === "shared") {
        const open = fs.openSync;
        vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
          const fd = open(path, flags, mode);
          if (path === "/proc/self/mountinfo") fs.writeFileSync(join(host.root, "mountinfo"), fs.readFileSync(join(host.root, "mountinfo"), "utf8").replace("rw - ext4", "rw shared:1 - ext4"));
          return fd;
        }) as typeof fs.openSync);
      }
      if (fault === "host-mnt") own.mnt = root.initialHostContext.namespaces.mnt;
      if (fault === "user" || fault === "pid" || fault === "net") own[fault] = `${fault}:[4026533000]`;
      const calls = host.calls.length;
      expect(() => assertResearchProviderAssemblyContext(root)).toThrow(fault === "stat-unavailable" ? "TEST process disappeared" : denied);
      expect(host.calls).toHaveLength(calls); expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { root.close(); }
  });

  it("denies changed sealed bytes through the reduced-role admission path", () => {
    const f = preparePrivateRootAssemblyFixture(), root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    try {
      host.processNamespaces.set(process.pid, { ...root.initialHostContext.namespaces, mnt: "mnt:[4026532841]" });
      expect(() => assertResearchProviderAssemblyContext(root)).not.toThrow();
      const planPath = join(dirname(root.root), "plan.json"), before = fs.lstatSync(planPath);
      snapshotWrite(planPath, researchRead(planPath).toString() + " ");
      expect(fs.lstatSync(planPath).ino).toBe(before.ino);
      expect(() => assertResearchProviderAssemblyContext(root)).toThrow(denied);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { root.close(); }
  });

  // Red if readFileSync(fd) consumes a public snapshot: construction leaves the
  // held FD at EOF, so the next unchanged guard falsely denies a valid root.
  it("revalidates nonempty public bytes repeatedly without consuming the held FD offset", () => {
    const f = preparePrivateRootAssemblyFixture(), original = fs.readFileSync("/etc/hosts", "utf8");
    const root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    try {
      const publicBind = root.bindings.find(bind => bind.target === "/etc/hosts");
      expect(publicBind).toBeDefined();
      expect(original.length).toBeGreaterThan(1);
      const fd = publicBind!.fd, bytes = Buffer.alloc(Buffer.byteLength(original));
      expect(assemblyDescriptorIo.readSync(fd, bytes, 0, bytes.length, 0)).toBe(bytes.length);
      expect(bytes.toString("utf8")).toBe(original);
      expect(() => root.assertCurrent()).not.toThrow();
      expect(() => root.assertCurrent()).not.toThrow();
      const next = Buffer.alloc(1);
      expect(assemblyDescriptorIo.readSync(fd, next, 0, 1, null)).toBe(1);
      expect(next.toString()).toBe(original[0]);
      // A caller's ordinary FD read may move its offset; guards still use the
      // same descriptor with explicit positions and must preserve that offset.
      expect(() => root.assertCurrent()).not.toThrow();
      expect(assemblyDescriptorIo.readSync(fd, next, 0, 1, null)).toBe(1);
      expect(next.toString()).toBe(original[1]);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    } finally { root.close(); }
  });

  // Equal bytes/perms cannot authorize a replacement inode. A rename also
  // revokes the admitted path while its original descriptor remains held.
  it.each(["replacement", "rename"] as const)("denies a public source %s with the original FD still open", fault => {
    const f = preparePrivateRootAssemblyFixture();
    const root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    try {
      expect(() => root.assertCurrent()).not.toThrow();
      const binding = root.bindings.find(bind => bind.target === "/etc/hosts")!;
      const before = assemblyDescriptorIo.fstatSync(binding.fd), bytes = fs.readFileSync(binding.source, "utf8");
      fs.renameSync(binding.source, join("/TEST-operator", "retained-public-source"));
      if (fault === "replacement") {
        fs.writeFileSync(binding.source, bytes, { mode: 0o444 });
        fs.chmodSync(local(binding.source), 0o444);
        expect(fs.lstatSync(binding.source).mode & 0o7777).toBe(0o444);
      }
      expect(assemblyDescriptorIo.fstatSync(binding.fd).ino).toBe(before.ino);
      if (fault === "replacement") expect(fs.lstatSync(binding.source).ino).not.toBe(before.ino);
      expect(() => root.assertCurrent()).toThrow();
    } finally { root.close(); }
  });

  // Preserve every held root/snapshot inode while replacing its parent. Only
  // custody identity, rather than leaf content/identity, distinguishes this.
  it("denies renamed and replaced private custody even when held leaf inodes are preserved", () => {
    const f = preparePrivateRootAssemblyFixture();
    const root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    try {
      expect(() => root.assertCurrent()).not.toThrow();
      const directory = dirname(root.root), before = fs.lstatSync(directory);
      const held = [root.rootFd, ...root.bindings.map(bind => bind.fd)].map(fd => [fd, assemblyDescriptorIo.fstatSync(fd).ino] as const);
      const saved = "/TEST-operator/renamed-private-custody";
      fs.renameSync(directory, saved);
      fs.mkdirSync(local(directory), { mode: 0o700 });
      for (const name of fs.readdirSync(saved)) fs.renameSync(join(saved, name), join(directory, name));
      expect(fs.lstatSync(directory).ino).not.toBe(before.ino);
      for (const [fd, inode] of held) expect(assemblyDescriptorIo.fstatSync(fd).ino).toBe(inode);
      expect(() => root.assertCurrent()).toThrow(denied);
    } finally { root.close(); }
  });

  // Red if a held public inode's read-only mode is mistaken for immutable bytes.
  it("denies same-inode public snapshot byte mutation after its mode is restored", () => {
    const f = preparePrivateRootAssemblyFixture();
    const root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    try {
      expect(() => root.assertCurrent()).not.toThrow();
      const binding = root.bindings.find(bind => bind.target === "/etc/hosts")!;
      const before = assemblyDescriptorIo.fstatSync(binding.fd);
      snapshotWrite(binding.source, "127.0.0.1 TEST-host\n");
      const after = assemblyDescriptorIo.fstatSync(binding.fd);
      expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size);
      expect(after.mode & 0o7777).toBe(0o444);
      expect(() => root.assertCurrent()).toThrow(denied);
    } finally { root.close(); }
  });

  // Red if constructor denial abandons any opened root/source FD. The fault is
  // a real public-file mutation after pinning, never a mocked guard rejection.
  it("closes every pinned descriptor when initial byte validation fails", () => {
    const f = preparePrivateRootAssemblyFixture();
    const sources = new Set([f.plan.fixedRootDirectory, ...f.plan.bindings.map(bind => bind.source)]);
    const opened: number[] = [], open = fs.openSync;
    const lastSource = f.plan.bindings.at(-1)!.source;
    let changed = false, returned: ResearchProviderAssemblyRoot | undefined;
    const opening = vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
      const fd = open(path, flags, mode);
      if (typeof path === "string" && sources.has(path)) {
        opened.push(fd);
        if (path === lastSource && !changed) {
          changed = true; snapshotWrite(f.publicSource, "127.0.0.1 TEST-host\n");
        }
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(() => { returned = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256); }).toThrow(denied);
      expect(changed).toBe(true); expect(opened).toHaveLength(f.plan.bindings.length + 1);
      for (const fd of opened) expectClosed(fd);
    } finally {
      opening.mockRestore(); returned?.close();
      // Also contain leaks when exercising a deliberately broken old variant.
      for (const fd of opened) {
        try { assemblyDescriptorIo.closeSync(fd); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
      }
    }
  });

  // Red if close leaks root or bind FDs, retries a closed descriptor, or allows
  // a closed receipt to authorize another assembly effect.
  it("closes root and source descriptors idempotently and rejects later guards", () => {
    const f = preparePrivateRootAssemblyFixture();
    const root = readResearchProviderAssemblyRoot(f.jobId, assemblyUnit, f.home, f.seal.sha256);
    const fds = [root.rootFd, ...root.bindings.map(bind => bind.fd)];
    try {
      root.close();
      for (const fd of fds) expectClosed(fd);
      expect(() => root.close()).not.toThrow();
      expect(() => root.assertCurrent()).toThrow(denied);
    } finally { root.close(); }
  });
});
