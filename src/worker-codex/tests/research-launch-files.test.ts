import { host, local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { researchArtifactDigest, researchFileDigest, researchRead } from "../research-launch-files";
import { researchExecutableDigest } from "../research-launch-host";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const sha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  // Independent streaming oracle, with a different I/O path and chunk size.
  for await (const chunk of fs.createReadStream(local(path), { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
};
function sizedFile(path: string, size: number): void {
  const fd = fs.openSync(local(path), "w", 0o755);
  try {
    fs.ftruncateSync(fd, size);
    const header = Buffer.from("TEST native ELF-sized bytes");
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, Buffer.from("TEST end"), 0, 8, size - 8);
  } finally { fs.closeSync(fd); }
}
const freshOptions = (maxBytes = 512 * 1024 * 1024) => ({ maxBytes, deadline: performance.now() + 4000,
  cache: new Map<string, { signature: string; digest: string }>(), cacheEntries: 32 });

describe("research byte witnesses (real sized TEST files under substituted root custody)", () => {
  it("accepts the observed native Codex and artifact SDK sizes using bounded reads and independent digests", async () => {
    const native = "/usr/bin/TEST-codex", sdk = "/TEST-artifact/node_modules/TEST-sdk";
    sizedFile(native, 286754152); sizedFile(sdk, 334715184);
    const expectedNative = await sha256(native), expectedSdk = await sha256(sdk);
    const realRead = fs.readSync, chunks: number[] = [];
    const reads = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      chunks.push((args[1] as Buffer).byteLength);
      return realRead(...args);
    });
    const wholeReads = vi.spyOn(fs, "readFileSync");
    expect(researchExecutableDigest(native)).toBe(expectedNative);
    expect(researchFileDigest(sdk, freshOptions())).toBe(expectedSdk);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
    expect(chunks.length).toBeGreaterThan(9000);
    expect(wholeReads).not.toHaveBeenCalled();
    reads.mockClear();
    expect(researchExecutableDigest(native)).toBe(expectedNative);
    expect(reads).not.toHaveBeenCalled(); // Metadata-checked cache.
    const artifact = researchArtifactDigest("/TEST-artifact");
    expect(researchArtifactDigest("/TEST-artifact")).toBe(artifact);
    const fd = fs.openSync(local(sdk), "r+");
    try { fs.writeSync(fd, Buffer.from("changed"), 0, 7, 200000000); } finally { fs.closeSync(fd); }
    expect(researchArtifactDigest("/TEST-artifact")).not.toBe(artifact);
    expect(wholeReads).not.toHaveBeenCalled();
    sizedFile("/TEST-artifact/node_modules/zz-overbudget", 210 * 1024 * 1024);
    expect(() => researchArtifactDigest("/TEST-artifact")).toThrow(); // Existing total byte cap.
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
    // Raising hash eligibility did not raise the private JSON read bound.
    fs.chmodSync(local(native), 0o600);
    expect(() => researchRead(native)).toThrow();
  });
  it("rejects over-byte and elapsed-time bounds before reusing a cached witness", () => {
    const path = "/usr/bin/TEST-codex", options = freshOptions();
    const digest = researchFileDigest(path, options);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const reads = vi.spyOn(fs, "readSync");
    expect(() => researchFileDigest(path, { ...options, maxBytes: 1 })).toThrow();
    expect(() => researchFileDigest(path, { ...options, deadline: performance.now() - 1 })).toThrow();
    expect(reads).not.toHaveBeenCalled();
    sizedFile(path, 512 * 1024 * 1024 + 1);
    expect(() => researchExecutableDigest(path)).toThrow();
    expect(reads).not.toHaveBeenCalled();
  });
  it("rejects path replacement during a read even when the held descriptor is unchanged", () => {
    const path = "/usr/bin/TEST-codex", options = freshOptions(), realRead = fs.readSync;
    let replaced = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = realRead(...args);
      if (!replaced) {
        replaced = true; fs.renameSync(local(path), local(path) + "-retired");
        fs.writeFileSync(local(path), "TEST replacement", { mode: 0o755 });
      }
      return count;
    });
    expect(() => researchFileDigest(path, options)).toThrow();
    expect(options.cache.size).toBe(0);
  });
  it("checks time between actual chunks and leaves a failed hash out of the cache", () => {
    const path = "/usr/bin/TEST-codex"; sizedFile(path, 256 * 1024);
    const options = freshOptions(), realRead = fs.readSync;
    let clock = 1;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const reads = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = realRead(...args); clock = 5; return count;
    });
    expect(() => researchFileDigest(path, { ...options, deadline: 4 })).toThrow();
    expect(reads).toHaveBeenCalledOnce(); expect(options.cache.size).toBe(0);
  });
  it.each(["symlink", "hardlink", "writable", "foreign", "non-executable", "directory"])("refuses %s executable even with a previously valid cache", fault => {
    const path = "/usr/bin/TEST-codex";
    expect(researchExecutableDigest(path)).toMatch(/^[a-f0-9]{64}$/);
    if (fault === "symlink") { fs.renameSync(local(path), local(path) + "-old"); fs.symlinkSync(local(path) + "-old", local(path)); }
    if (fault === "hardlink") fs.linkSync(local(path), local(path) + "-copy");
    if (fault === "writable") fs.chmodSync(local(path), 0o775);
    if (fault === "foreign") host.foreign.add(path);
    if (fault === "non-executable") fs.chmodSync(local(path), 0o644);
    if (fault === "directory") { fs.unlinkSync(local(path)); fs.mkdirSync(local(path)); }
    const reads = vi.spyOn(fs, "readSync");
    expect(() => researchExecutableDigest(path)).toThrow(); expect(reads).not.toHaveBeenCalled();
  });
  it("opens without following links or blocking special files and detects descriptor changes after reading", () => {
    const path = "/usr/bin/TEST-codex", realStat = fs.fstatSync, options = freshOptions();
    const opened = vi.spyOn(fs, "openSync");
    const stats = vi.spyOn(fs, "fstatSync");
    let observations = 0;
    stats.mockImplementation((fd: number) => {
      const stat = realStat(fd);
      if (++observations === 2) stat.mode = 0o100777;
      return stat;
    });
    expect(() => researchFileDigest(path, options)).toThrow();
    expect(options.cache.size).toBe(0);
    const flags = opened.mock.calls.find(call => call[0] === path)![1] as number;
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(flags & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
    stats.mockRestore();
    expect(researchFileDigest(path, freshOptions())).toMatch(/^[a-f0-9]{64}$/);
  });
});
