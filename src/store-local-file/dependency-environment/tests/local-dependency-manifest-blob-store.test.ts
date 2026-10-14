import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DependencyManifestStorageFailure as Failure,
  LocalDependencyManifestBlobStore as Store,
} from "../local-dependency-manifest-blob-store";

const runFile = promisify(execFile);

// All data belongs to new synthetic TEST filesystems. No project installs,
// worker runtime, actual credentials or production storage are involved.
async function fixture(limits: Partial<{ maxManifestBytes: number; maxStoredBytes: number; maxBlobs: number }> = {}) {
  const testRoot = await realpath(await mkdtemp(join(tmpdir(), "dependency-manifest-TEST-")));
  const rootPath = join(testRoot, "protected");
  await mkdir(rootPath, { mode: 0o700 });
  const store = await Store.open({ rootPath, maxManifestBytes: 4096, maxStoredBytes: 8192, maxBlobs: 16, ...limits });
  return { store, rootPath, testRoot, async cleanup() { await store.close(); await rm(testRoot, { recursive: true, force: true }); } };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.skipIf(process.platform !== "linux")("protected dependency manifest blobs", () => {
  it("stores ten identical manifests once and restores the exact bytes", async () => {
    const sample = await fixture();
    try {
      const bytes = Buffer.from('{"version":1,"entries":[{"path":"a","digest":"independent-content"}]}\n');
      const expected = digest(bytes);
      for (let n = 0; n < 10; n++) expect(await sample.store.put(bytes)).toBe(expected);
      expect(await readdir(sample.rootPath)).toEqual([`${expected}.gz`]);
      expect(await sample.store.get(expected)).toEqual(bytes);
      expect((await lstat(join(sample.rootPath, `${expected}.gz`))).mode & 0o777).toBe(0o600);
    } finally { await sample.cleanup(); }
  });

  it("keeps different output contents distinct even for the same install-key label", async () => {
    const sample = await fixture();
    try {
      const a = Buffer.from('{"installKey":"same","output":"native-a"}');
      const b = Buffer.from('{"installKey":"same","output":"native-b"}');
      const first = await sample.store.put(a);
      const second = await sample.store.put(b);
      expect(first).not.toBe(second);
      expect((await readdir(sample.rootPath)).sort()).toEqual([`${digest(a)}.gz`, `${digest(b)}.gz`].sort());
      expect(await sample.store.get(first)).toEqual(a);
      expect(await sample.store.get(second)).toEqual(b);
    } finally { await sample.cleanup(); }
  });

  it("rejects corrupt existing content without overwriting or removing it", async () => {
    const sample = await fixture();
    try {
      const bytes = Buffer.from('{"entries":[]}');
      const key = await sample.store.put(bytes);
      const path = join(sample.rootPath, `${key}.gz`);
      const corrupt = gzipSync(Buffer.from("different bytes"));
      await writeFile(path, corrupt);
      await expect(sample.store.get(key)).rejects.toMatchObject({ reason: Failure.Corrupt });
      await expect(sample.store.put(bytes)).rejects.toMatchObject({ reason: Failure.Corrupt });
      expect(await readFile(path)).toEqual(corrupt);
      expect(await readdir(sample.rootPath)).toEqual([`${key}.gz`]);
    } finally { await sample.cleanup(); }
  });

  it("bounds decompression and preserves an oversized compressed manifest", async () => {
    const sample = await fixture({ maxManifestBytes: 128 });
    try {
      const bytes = Buffer.alloc(16 * 1024, 65);
      const key = digest(bytes);
      const compressed = gzipSync(bytes);
      const path = join(sample.rootPath, `${key}.gz`);
      await writeFile(path, compressed, { mode: 0o600 });
      await expect(sample.store.get(key)).rejects.toMatchObject({ reason: Failure.Corrupt });
      expect(await readFile(path)).toEqual(compressed);
    } finally { await sample.cleanup(); }
  });

  it("enforces entry quota without damaging existing committed manifests", async () => {
    const sample = await fixture({ maxBlobs: 2 });
    try {
      const first = await sample.store.put(Buffer.from("first"));
      const second = await sample.store.put(Buffer.from("second"));
      await expect(sample.store.put(Buffer.from("third"))).rejects.toMatchObject({ reason: Failure.Quota });
      expect(await sample.store.get(first)).toEqual(Buffer.from("first"));
      expect(await sample.store.get(second)).toEqual(Buffer.from("second"));
      expect((await readdir(sample.rootPath)).sort()).toEqual([`${first}.gz`, `${second}.gz`].sort());
    } finally { await sample.cleanup(); }
  });

  it("refuses size quotas before publication and leaves the store empty", async () => {
    const sample = await fixture({ maxManifestBytes: 16, maxStoredBytes: 1 });
    try {
      await expect(sample.store.put(Buffer.alloc(17))).rejects.toMatchObject({ reason: Failure.Quota });
      await expect(sample.store.put(Buffer.from("valid"))).rejects.toMatchObject({ reason: Failure.Quota });
      expect(await readdir(sample.rootPath)).toEqual([]);
    } finally { await sample.cleanup(); }
  });

  it("never follows an existing blob symlink or overwrites its external sentinel", async () => {
    const sample = await fixture();
    try {
      const bytes = Buffer.from("manifest");
      const outside = join(sample.testRoot, "external");
      const original = Buffer.from("independent external sentinel");
      await writeFile(outside, original, { mode: 0o600 });
      await symlink(outside, join(sample.rootPath, `${digest(bytes)}.gz`));
      await expect(sample.store.get(digest(bytes))).rejects.toMatchObject({ reason: Failure.Corrupt });
      await expect(sample.store.put(bytes)).rejects.toMatchObject({ reason: Failure.Corrupt });
      expect(await readFile(outside)).toEqual(original);
      expect((await lstat(join(sample.rootPath, `${digest(bytes)}.gz`))).isSymbolicLink()).toBe(true);
    } finally { await sample.cleanup(); }
  });

  it("rejects a FIFO blob before blocking on a writer and preserves the FIFO", async () => {
    const sample = await fixture();
    const bytes = Buffer.from("TEST-fifo-manifest");
    const key = digest(bytes);
    const fifo = join(sample.rootPath, `${key}.gz`);
    let watchdogFired = false;
    let rescue: Promise<FileHandle> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await runFile("mkfifo", ["-m", "600", fifo], { timeout: 1000 });
      watchdog = setTimeout(() => {
        watchdogFired = true;
        // Linux O_RDWR opens without another endpoint. Keep it open until the
        // inspected operation returns, so a legacy blocking reader cannot hang.
        rescue = open(fifo, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        void rescue.catch(() => undefined);
      }, 1500);
      await expect(sample.store.get(key)).rejects.toMatchObject({ reason: Failure.Corrupt });
      await expect(sample.store.put(bytes)).rejects.toMatchObject({ reason: Failure.Corrupt });
      expect(watchdogFired).toBe(false);
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      expect(await readdir(sample.rootPath)).toEqual([`${key}.gz`]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      try { if (rescue) await (await rescue).close(); } finally { await sample.cleanup(); }
    }
  });

  it("drains active publication and reads before closing while refusing new operations", async () => {
    const sample = await fixture();
    try {
      const original = Buffer.from("TEST-existing-manifest");
      const oldKey = await sample.store.put(original);
      const next = Buffer.alloc(2048, 84);
      const reading = sample.store.get(oldKey);
      const publishing = sample.store.put(next);
      const closing = sample.store.close();
      const completion = Promise.allSettled([reading, publishing, closing, sample.store.close()]);
      await expect(sample.store.put(Buffer.from("TEST-after-close"))).rejects.toMatchObject({ reason: Failure.Closed });
      await expect(sample.store.get(oldKey)).rejects.toMatchObject({ reason: Failure.Closed });
      const outcomes = await completion;
      expect(outcomes).toEqual([
        { status: "fulfilled", value: original },
        { status: "fulfilled", value: digest(next) },
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(gunzipSync(await readFile(join(sample.rootPath, `${digest(next)}.gz`)))).toEqual(next);
      expect((await readdir(sample.rootPath)).sort()).toEqual([`${oldKey}.gz`, `${digest(next)}.gz`].sort());
    } finally { await sample.cleanup(); }
  });

  it("rejects root replacement before publication without touching the replacement", async () => {
    const sample = await fixture();
    try {
      await rename(sample.rootPath, join(sample.testRoot, "retained-root"));
      await mkdir(sample.rootPath, { mode: 0o700 });
      await writeFile(join(sample.rootPath, "sentinel"), "replacement original");
      await expect(sample.store.put(Buffer.from("new"))).rejects.toMatchObject({ reason: Failure.UnsafeRoot });
      expect(await readdir(sample.rootPath)).toEqual(["sentinel"]);
      expect(await readFile(join(sample.rootPath, "sentinel"), "utf8")).toBe("replacement original");
      expect(await readdir(join(sample.testRoot, "retained-root"))).toEqual([]);
    } finally { await sample.cleanup(); }
  });

  it("refuses a blob with an unexpected external hardlink and preserves both names", async () => {
    const sample = await fixture();
    try {
      const bytes = Buffer.from("immutable manifest");
      const key = await sample.store.put(bytes);
      const original = join(sample.rootPath, `${key}.gz`);
      const external = join(sample.testRoot, "external-hardlink");
      const compressed = await readFile(original);
      await link(original, external);
      await expect(sample.store.get(key)).rejects.toMatchObject({ reason: Failure.Corrupt });
      await expect(sample.store.put(bytes)).rejects.toMatchObject({ reason: Failure.Corrupt });
      expect(await readFile(original)).toEqual(compressed);
      expect(await readFile(external)).toEqual(compressed);
      expect((await lstat(original)).nlink).toBe(2);
    } finally { await sample.cleanup(); }
  });

  it("holds a crashed or unknown publisher lock without taking it over by age", async () => {
    const sample = await fixture();
    try {
      const original = Buffer.from("unknown publisher, no release evidence\n");
      await writeFile(join(sample.rootPath, ".publication-lock"), original, { mode: 0o600 });
      await expect(sample.store.put(Buffer.from("new"))).rejects.toMatchObject({ reason: Failure.Busy });
      expect(await readFile(join(sample.rootPath, ".publication-lock"))).toEqual(original);
      expect(await readdir(sample.rootPath)).toEqual([".publication-lock"]);
    } finally { await sample.cleanup(); }
  });

  it("rejects traversal digest inputs and insecure root permissions", async () => {
    const sample = await fixture();
    try {
      await expect(sample.store.get("../external")).rejects.toMatchObject({ reason: Failure.InvalidDigest });
      await chmod(sample.rootPath, 0o755);
      await expect(sample.store.put(Buffer.from("new"))).rejects.toMatchObject({ reason: Failure.UnsafeRoot });
      await expect(Store.open({ rootPath: sample.rootPath, maxManifestBytes: 4096, maxStoredBytes: 8192, maxBlobs: 16 }))
        .rejects.toMatchObject({ reason: Failure.UnsafeRoot });
    } finally { await sample.cleanup(); }
  });
});
