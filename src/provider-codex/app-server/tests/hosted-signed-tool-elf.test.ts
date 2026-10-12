import { expect, it } from "vitest";
import { parseHostedSignedToolElf } from "../adapters/hosted-signed-tool-elf";
import { parsePythonEnvelopeElf } from "../../../../host-integration/managed-launcher/dependency-full-python-envelope-TEST.ts";

// Standard ELF64 PT_LOAD/PT_DYNAMIC geometry; bytes are never executed.
function image(needed: readonly string[] = [], tagged: readonly [bigint, string][] = []): Buffer {
  const bytes = Buffer.alloc(1024); bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  bytes.writeUInt32LE(2, 120); bytes.writeBigUInt64LE(256n, 128); bytes.writeBigUInt64LE(256n, 136);
  const records: [bigint, bigint][] = [[5n, 640n], [10n, 256n]]; let offset = 1;
  for (const [tag, value] of [...needed.map(value => [1n, value] as const), ...tagged]) {
    const string = Buffer.from(value + "\0"); bytes.set(string, 640 + offset);
    records.push([tag, BigInt(offset)]); offset += string.length;
  }
  records.push([0n, 0n]); bytes.writeBigUInt64LE(BigInt(records.length * 16), 152);
  for (const [i, record] of records.entries()) { bytes.writeBigInt64LE(record[0], 256 + i * 16); bytes.writeBigUInt64LE(record[1], 264 + i * 16); }
  return bytes;
}
it("preserves existing factual decoder semantics for dependency/search-route bytes", () => {
  for (const bytes of [image(), image(["libc.so.6"]), image(["libc.so.6"], [[29n, "$ORIGIN"]]), image([], [[15n, "/usr/lib"]])]) {
    expect(parseHostedSignedToolElf(bytes)).toEqual(parsePythonEnvelopeElf(bytes));
  }
  const facts = parseHostedSignedToolElf(image(["libc.so.6"]));
  expect(Object.isFrozen(facts)).toBe(true); expect(Object.isFrozen(facts.needed)).toBe(true);
});
it.each([0x6ffffefan, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn])("rejects external audit/filter/auxiliary selector %s", tag => {
  expect(() => parseHostedSignedToolElf(image([], [[tag, "foreign.so"]]))).toThrow("ELF audit/filter/auxiliary route");
});
it("rejects a dependency path escape before any resolver can select it", () => {
  expect(() => parseHostedSignedToolElf(image(["/tmp/foreign.so"]))).toThrow("ELF dependency/soname escape");
});
it("rejects out-of-range tables and truncated dependency metadata", () => {
  const bad = image(); bad.writeBigUInt64LE(9999n, 32);
  expect(() => parseHostedSignedToolElf(bad)).toThrow("ELF range");
  expect(() => parseHostedSignedToolElf(image(["libc.so.6"]).subarray(0, 300))).toThrow("ELF range");
});
