import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Explicit source-gate TEST helper compilation required. Never a native backend
// invocation; skipped discovery is not qualification evidence.
const binary = process.env.BOUNDED_STORAGE_MOUNTINFO_TEST_BINARY;
const suite = binary ? describe : describe.skip;
const record = (id: number | string, optional = "", pad = ""): string =>
  `${id} 1 8:1 / /test${pad} rw${optional} - ext4 /dev/test rw\n`;
function parse(text: string, id = "999999"): string {
  assert(binary);
  const result = spawnSync(binary, [id], { input: text, encoding: "utf8", timeout: 10000,
    maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(result.stderr, ""); return result.stdout.trim();
}
suite("native mountinfo observation bounds", () => {
  beforeAll(() => {
    assert(binary && isAbsolute(binary)); assert.equal(realpathSync(binary), binary);
    for (let path = binary; ; path = dirname(path)) {
      const stat = lstatSync(path);
      assert(!stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
      if (path === binary) assert(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o111));
      else assert(stat.isDirectory());
      if (path === "/") break;
    }
  });
  // Red on the old 2MiB reader: the actual matching NEW mount follows >2MiB.
  it("accepts a private NEW mount after a large inherited prefix", () => {
    const prefix = record(2, "", "x".repeat(3000)).repeat(3000);
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(2 * 1024 * 1024);
    expect(parse(prefix + record(999999))).toBe("private");
  });
  it("rejects every propagation token on the matching mount", () => {
    for (const optional of [" shared:7", " master:8", " propagate_from:9"])
      expect(parse(record(999999, optional))).toBe("unsupported");
    expect(parse(record(2, " shared:7") + record(999999))).toBe("private");
  });
  it("accepts the final allowed row and refuses the next row", () => {
    const row = record(2);
    expect(parse(row.repeat(65535) + record(999999))).toBe("private");
    expect(parse(row.repeat(65536) + record(999999))).toBe("unsupported");
  });
  it("accepts exactly 16MiB and refuses one byte beyond it", () => {
    const sized = (id: number, bytes: number): string => record(id, "", "x".repeat(bytes - Buffer.byteLength(record(id))));
    const prefix = sized(2, 4094).repeat(4096) + sized(2, 2731).repeat(2);
    const exact = prefix + sized(999999, 2730);
    expect(Buffer.byteLength(exact)).toBe(16777216);
    expect(parse(exact)).toBe("private");
    expect(parse(prefix + sized(999999, 2731))).toBe("unsupported");
  });
  it("refuses an oversized byte prefix before a late matching mount", () => {
    const prefix = record(2, "", "x".repeat(3000)).repeat(6000);
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(16 * 1024 * 1024);
    expect(parse(prefix + record(999999))).toBe("unsupported");
  });
  it("fails closed for absent, truncated, long-line and overflow identities", () => {
    expect(parse(record(2))).toBe("unsupported");
    expect(parse(record(999999).trimEnd())).toBe("unsupported");
    expect(parse(record(2, "", "x".repeat(4096)) + record(999999))).toBe("unsupported");
    expect(parse(record("18446744073709551616") + record(999999))).toBe("identity");
    expect(parse("999999 1 8:1 / /test rw\n")).toBe("identity");
  });
  it("stops at the selected identity without consuming unrelated suffix", () => {
    expect(parse(record(999999) + "invalid trailing record\n")).toBe("private");
  });
});
