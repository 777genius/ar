import {
  assemblyDescriptorIo, assemblyUnit, preparePrivateRootAssemblyFixture,
  setupPrivateRootAssemblyFixture,
} from "./private-root-assembly-fixture";
import { cleanupResearchFixture, host, local } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { readResearchProviderAssemblyRoot, type ResearchProviderAssemblyRoot } from "../research-provider-root";

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
