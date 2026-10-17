/** Pure factual decoder extracted from the native Python envelope parser.
 * It neither authenticates bytes nor selects paths, tools, roles or authority. */
export interface HostedSignedToolElfFacts {
  readonly needed: readonly string[];
  readonly runpath: readonly string[];
  readonly rpath: readonly string[];
  readonly interpreter: string | null;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("hosted_signed_tool_elf_held: " + reason);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** ELF64 little-endian x86-64. Audited/filter/auxiliary selection refuses. */
export function parseHostedSignedToolElf(bytes: Buffer): HostedSignedToolElfFacts {
  check(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
    bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1 && bytes.readUInt16LE(18) === 62, "ELF target");
  const number = (value: bigint): number => {
    check(value <= BigInt(Number.MAX_SAFE_INTEGER), "ELF integer"); return Number(value);
  };
  const range = (offset: number, size: number): void => {
    check(integer(offset) && integer(size) && offset + size <= bytes.length, "ELF range");
  };
  const ph = number(bytes.readBigUInt64LE(32)), width = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  check(width === 56 && count > 0 && count !== 65535, "ELF program table"); range(ph, width * count);
  const loads: { va: number; offset: number; size: number }[] = [], dynamic: { offset: number; size: number }[] = [];
  let interpreter: string | null = null;
  const text = (offset: number, maximum: number): string => {
    range(offset, maximum); const end = bytes.indexOf(0, offset);
    check(end >= offset && end < offset + maximum, "ELF string terminator");
    const raw = bytes.subarray(offset, end); check(raw.every(byte => byte >= 0x20 && byte <= 0x7e), "ELF string encoding");
    return raw.toString("ascii");
  };
  for (let i = 0; i < count; i++) {
    const at = ph + i * width, type = bytes.readUInt32LE(at), offset = number(bytes.readBigUInt64LE(at + 8)),
      va = number(bytes.readBigUInt64LE(at + 16)), size = number(bytes.readBigUInt64LE(at + 32));
    range(offset, size);
    if (type === 1) loads.push({ va, offset, size });
    if (type === 2) dynamic.push({ offset, size });
    if (type === 3) {
      check(interpreter === null, "ELF multiple interpreters"); interpreter = text(offset, size);
      check(interpreter === "/lib64/ld-linux-x86-64.so.2", "ELF interpreter escape");
    }
  }
  check(dynamic.length <= 1, "ELF dynamic table");
  if (dynamic.length === 0) return Object.freeze({ needed: Object.freeze([]), runpath: Object.freeze([]), rpath: Object.freeze([]), interpreter });
  const table = dynamic[0]!; check(table.size % 16 === 0, "ELF dynamic size");
  let strVa: number | undefined, strSize: number | undefined, ended = false;
  const rows: { tag: bigint; value: number }[] = [];
  for (let at = table.offset; at < table.offset + table.size; at += 16) {
    const tag = bytes.readBigInt64LE(at), value = number(bytes.readBigUInt64LE(at + 8));
    if (tag === 0n) { ended = true; break; }
    if (tag === 5n) { check(strVa === undefined, "ELF duplicate strtab"); strVa = value; }
    if (tag === 10n) { check(strSize === undefined, "ELF duplicate strsize"); strSize = value; }
    check(![0x6ffffefan, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag), "ELF audit/filter/auxiliary route");
    rows.push({ tag, value });
  }
  check(ended && strVa !== undefined && strSize !== undefined && strSize > 0, "ELF dynamic completeness");
  const segments = loads.filter(segment => strVa! >= segment.va && strVa! + strSize! <= segment.va + segment.size);
  check(segments.length === 1, "ELF string mapping");
  const segment = segments[0]!, base = segment.offset + strVa - segment.va; range(base, strSize);
  const values = (tag: bigint): string[] => rows.filter(row => row.tag === tag).map(row => {
    check(row.value < strSize!, "ELF string offset"); return text(base + row.value, strSize! - row.value);
  });
  const needed = values(1n);
  for (const name of [...needed, ...values(14n)]) check(/^[A-Za-z0-9_+.-]+$/.test(name), "ELF dependency/soname escape");
  const paths = (tag: bigint): string[] => {
    const rows = values(tag); check(rows.length <= 1, "ELF duplicate search path"); return rows.length ? rows[0]!.split(":") : [];
  };
  return Object.freeze({ needed: Object.freeze(needed), runpath: Object.freeze(paths(29n)), rpath: Object.freeze(paths(15n)), interpreter });
}
