import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, fsyncSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDependencyTreePreservation, DependencyPreservationLocation, readDependencyTreeEffectReferenceAnchors } from "../dependency-tree-effects";
// Keep the real filesystem and real fsync. Native ESM namespace properties
// cannot be spied on in Node 22; the configurable mock facade changes only the
// export container. A plain wrapper (not vi.fn) keeps each test's captured
// pass-through independent of the spy implementation and prevents recursion.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: (fd: number) => actual.fsyncSync(fd) };
});
const limits = { maxEntries: 128, maxTotalBytes: 65536, maxManifestBytes: 65536, maxDurationMs: 30000 };
async function identity(path: string) { const stat = await lstat(path, { bigint: true }); return { canonicalPath: path, dev: String(stat.dev), ino: String(stat.ino) }; }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-opaque-preservation-"))), workspace = join(root, "workspace"), quarantine = join(root, "quarantine"), tree = join(workspace, "node_modules");
  await mkdir(workspace); await mkdir(quarantine, { mode: 0o700 }); await mkdir(tree); await mkdir(join(tree, ".vite"));
  await writeFile(join(tree, ".vite/authored-code"), "preserve authored cache-looking code");
  await writeFile(join(tree, "mutated-package.js"), "unknown or mutated original");
  await writeFile(join(root, "external-sentinel"), "outside original");
  await writeFile(join(workspace, "state-output-sentinel"), "state result and source original");
  await symlink("../../external-sentinel", join(tree, "external-link")); await symlink("missing-target", join(tree, "dangling-link"));
  const operationId = randomUUID(), input = { workspace: await identity(workspace), trash: { operationId,
    originalTree: await identity(tree), destinationParent: await identity(quarantine), destinationName: `dependency-${operationId}` }, limits };
  return { root, workspace, tree, input, target: join(quarantine, input.trash.destinationName), async close() { await rm(root, { recursive: true, force: true }); } };
}
// Red if unknown links are followed, authored bytes dropped, a different inode
// moved, conflicting names overwritten, mutations accepted, or a closed/replayed
// session becomes an effect grant. These are real disposable Linux FS effects.
describe.skipIf(process.platform !== "linux")("opaque whole-tree preservation", () => {
  it("moves the entire original inode and inventory without following unknown links", async () => {
    const f = await fixture();
    try {
      const originalFile = await identity(join(f.tree, "mutated-package.js")), operation = await openDependencyTreePreservation(f.input);
      try {
        expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false);
        const result = operation.commit(operation.inventory.digest);
        expect(result.tree).toEqual({ dev: f.input.trash.originalTree.dev, ino: f.input.trash.originalTree.ino });
        expect(await identity(f.target)).toMatchObject(result.tree); expect(existsSync(f.tree)).toBe(false);
        expect(await identity(join(f.target, "mutated-package.js"))).toMatchObject({ dev: originalFile.dev, ino: originalFile.ino });
        expect(await readFile(join(f.target, "mutated-package.js"), "utf8")).toBe("unknown or mutated original");
        expect(await readFile(join(f.target, ".vite/authored-code"), "utf8")).toBe("preserve authored cache-looking code");
        expect(await readlink(join(f.target, "external-link"))).toBe("../../external-sentinel");
        expect(await readlink(join(f.target, "dangling-link"))).toBe("missing-target");
        const inventory = JSON.parse(operation.inventory.canonicalBytes.toString("utf8")) as { entries: { kind: string; target?: string }[] };
        expect(inventory.entries.filter(v => v.kind === "symlink").map(v => Buffer.from(v.target!, "base64").toString()).sort()).toEqual(["../../external-sentinel", "missing-target"]);
        expect(() => operation.commit(operation.inventory.digest)).toThrow("closed");
      } finally { await operation.close(); }
      expect(await readFile(join(f.root, "external-sentinel"), "utf8")).toBe("outside original");
      expect(await readFile(join(f.workspace, "state-output-sentinel"), "utf8")).toBe("state result and source original");
    } finally { await f.close(); }
  });
  it.each(["bytes", "membership", "destination", "source-swap", "ancestor-swap"])("refuses %s races without destroying either tree", async change => {
    const f = await fixture();
    try {
      const operation = await openDependencyTreePreservation(f.input);
      try {
        if (change === "bytes") await writeFile(join(f.tree, "mutated-package.js"), "same-length different bytes");
        if (change === "membership") await writeFile(join(f.tree, ".hidden-authored"), "keep");
        if (change === "destination") { await mkdir(f.target); await writeFile(join(f.target, "sentinel"), "do not overwrite"); }
        if (change === "source-swap") { await rename(f.tree, f.tree + "-original"); await mkdir(f.tree); }
        if (change === "ancestor-swap") { await rename(f.workspace, f.workspace + "-original"); await mkdir(f.workspace); await mkdir(f.tree); }
        expect(() => operation.commit(operation.inventory.digest)).toThrow();
        expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(change === "destination");
        if (change === "destination") expect(await readFile(join(f.target, "sentinel"), "utf8")).toBe("do not overwrite");
        expect(await readFile(join(f.root, "external-sentinel"), "utf8")).toBe("outside original");
      } finally { await operation.close(); }
    } finally { await f.close(); }
  });
  it("reopens the exact relocated inode to reconcile durable post-rename readback", async () => {
    const f = await fixture();
    try {
      const first = await openDependencyTreePreservation(f.input), inventory = first.inventory;
      first.commit(inventory.digest); await first.close();
      const recovery = await openDependencyTreePreservation(f.input, DependencyPreservationLocation.Preserved);
      try { expect(recovery.inventory).toEqual(inventory); expect(recovery.commit(inventory.digest).tree).toEqual({ dev: f.input.trash.originalTree.dev, ino: f.input.trash.originalTree.ino }); }
      finally { await recovery.close(); }
      expect(existsSync(f.tree)).toBe(false); expect(existsSync(f.target)).toBe(true);
    } finally { await f.close(); }
  });
  it("invalidates both the effect and its genuine descriptor session on close", async () => {
    const f = await fixture();
    try {
      const operation = await openDependencyTreePreservation(f.input); await operation.close();
      expect(() => operation.commit(operation.inventory.digest)).toThrow("closed");
      expect(() => readDependencyTreeEffectReferenceAnchors(operation.referenceSession, { workspace: f.input.workspace, trashPath: f.target, operationId: f.input.trash.operationId })).toThrow("closed");
      expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false);
    } finally { await f.close(); }
  });
});
// These use genuine Linux file/directory descriptors and real fsync calls, with
// failures injected only at the chosen completed I/O boundary. They establish
// ordering/refusal/recovery contracts, not a hardware power-loss durability proof.
describe.skipIf(process.platform !== "linux")("preservation data durability barrier", () => {
  it("flushes every regular file and postorder directory before namespace parents", async () => {
    const f = await fixture(), operation = await openDependencyTreePreservation(f.input), synced: string[] = [], actual = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { const path = fs.readlinkSync(`/proc/self/fd/${fd}`); actual(fd); synced.push(path); });
    try {
      operation.commit(operation.inventory.digest);
      expect(synced).toEqual([join(f.tree, ".vite/authored-code"), join(f.tree, ".vite"), join(f.tree, "mutated-package.js"), f.tree, f.workspace, f.input.trash.destinationParent.canonicalPath]);
    } finally { spy.mockRestore(); await operation.close(); await f.close(); }
  });
  it.each(["file", "directory", "namespace-parent"])("holds the operation at uncertain %s fsync and reconciles the exact original inode", async barrier => {
    const f = await fixture(), operation = await openDependencyTreePreservation(f.input), actual = fs.fsyncSync;
    const selected = barrier === "file" ? join(f.tree, ".vite/authored-code") : barrier === "directory" ? join(f.tree, ".vite") : f.workspace;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`); actual(fd);
      if (path === selected) throw Object.assign(new Error("TEST uncertain durability barrier"), { code: "EIO" });
    });
    try {
      expect(() => operation.commit(operation.inventory.digest)).toThrow("uncertain durability");
      expect(() => operation.commit(operation.inventory.digest)).toThrow("closed");
      expect(existsSync(f.tree)).toBe(barrier !== "namespace-parent"); expect(existsSync(f.target)).toBe(barrier === "namespace-parent");
    } finally { spy.mockRestore(); await operation.close(); }
    try {
      const recovery = await openDependencyTreePreservation(f.input, barrier === "namespace-parent" ? DependencyPreservationLocation.Preserved : DependencyPreservationLocation.Original);
      try { expect(recovery.commit(recovery.inventory.digest).tree).toEqual({ dev: f.input.trash.originalTree.dev, ino: f.input.trash.originalTree.ino }); }
      finally { await recovery.close(); }
      expect(await readFile(join(f.target, ".vite/authored-code"), "utf8")).toBe("preserve authored cache-looking code");
      expect(await readFile(join(f.root, "external-sentinel"), "utf8")).toBe("outside original");
    } finally { await f.close(); }
  });
  it.each(["content", "source-alias"])("revalidates %s after successful data/directory I/O and refuses before rename", async change => {
    const f = await fixture(), operation = await openDependencyTreePreservation(f.input), actual = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`); actual(fd);
      if (path !== f.tree) return;
      if (change === "content") fs.writeFileSync(join(f.tree, "mutated-package.js"), "post-fsync changed content");
      else { fs.renameSync(f.tree, f.tree + "-original"); fs.mkdirSync(f.tree); }
    });
    try { expect(() => operation.commit(operation.inventory.digest)).toThrow(); expect(existsSync(f.tree)).toBe(true); expect(existsSync(f.target)).toBe(false); }
    finally { spy.mockRestore(); await operation.close(); await f.close(); }
  });
  it.each(["content", "destination-alias"])("refuses post-parent-sync %s drift before reporting a committed effect", async change => {
    const f = await fixture(), operation = await openDependencyTreePreservation(f.input), actual = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`); actual(fd);
      if (path !== f.input.trash.destinationParent.canonicalPath) return;
      if (change === "content") fs.writeFileSync(join(f.target, "mutated-package.js"), "post-parent-sync mutation");
      else { fs.renameSync(f.target, f.target + "-original"); fs.mkdirSync(f.target); }
    });
    try { expect(() => operation.commit(operation.inventory.digest)).toThrow(); expect(existsSync(f.tree)).toBe(false); expect(existsSync(f.target)).toBe(true); }
    finally { spy.mockRestore(); await operation.close(); await f.close(); }
  });

});

it("a copied descriptor DTO never grants a preservation reference exception", async () => {
  expect(() => readDependencyTreeEffectReferenceAnchors({ operationId: randomUUID() }, { workspace: { canonicalPath: "/TEST", dev: "1", ino: "2" }, trashPath: "/protected/TEST", operationId: randomUUID() })).toThrow("closed");
  // Portable preflight in this existing case keeps the finite Linux roster
  // unchanged and makes ESM spy creation, real I/O, fault injection and restore
  // run even when Darwin skips the eight Linux durability cases.
  const root = await mkdtemp(join(tmpdir(), "TEST-preservation-fsync-spy-")), file = join(root, "sentinel");
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, "TEST real fsync sentinel");
    const before = fs.fstatSync(fd), actual = fs.fsyncSync, synced: number[] = [];
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation(selected => { actual(selected); synced.push(selected); });
    try {
      fsyncSync(fd); expect(synced).toEqual([fd]); expect(spy).toHaveBeenCalledTimes(1);
      spy.mockImplementationOnce(selected => { actual(selected); throw Object.assign(new Error("TEST fsync preflight EIO"), { code: "EIO" }); });
      expect(() => fs.fsyncSync(fd!)).toThrow("TEST fsync preflight EIO"); expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
    expect(fs.fsyncSync).toBe(actual); fs.fsyncSync(fd);
    expect(fs.fstatSync(fd).ino).toBe(before.ino); expect(await readFile(file, "utf8")).toBe("TEST real fsync sentinel");
  } finally { if (fd !== undefined) fs.closeSync(fd); await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "linux")("refuses unsupported host primitives before attempting a preservation", async () => {
  const operationId = randomUUID();
  await expect(openDependencyTreePreservation({ workspace: { canonicalPath: "/TEST/workspace", dev: "1", ino: "2" },
    trash: { operationId, originalTree: { dev: "1", ino: "3" }, destinationParent: { canonicalPath: "/protected/TEST", dev: "1", ino: "4" }, destinationName: `dependency-${operationId}` }, limits })).rejects.toThrow("unsupported");
});
