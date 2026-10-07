/** TEST lexical source-location observation only. Pins authenticate this
 * dictionary, never cause, current account, authority or successful selection. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import { lookupNpmPublicSourcePart0, type NpmPublicSourceRecord } from "./registration-npm-public-catalog-0.js";
import { lookupNpmPublicSourcePart1 } from "./registration-npm-public-catalog-1.js";
const freeze = Object.freeze;
const npmRoot = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/npm";
enum NpmFrameModule { Unknown = "unknown", Dispatch = "npm_dispatch", Install = "npm_install",
  Config = "npm_config", IdealTree = "arborist_ideal_tree", Reify = "arborist_reify",
  Node = "arborist_node", Fetcher = "pacote_fetcher", PackageArgument = "npm_package_argument" }
enum NpmStackChannel { Unknown = "unknown", Verbose = "npm_verbose_stack", Uncaught = "unprefixed_stack" }
enum NpmStackError { Unknown = "unknown", Error = "error_header", Type = "type_error_header",
  Range = "range_error_header", Syntax = "syntax_error_header", Reference = "reference_error_header" }
export type TestNpmFrameObservation = Readonly<{
  channel: NpmStackChannel; errorClass: NpmStackError; module: NpmFrameModule; line: number | null;
}>;
const unknownFrame: TestNpmFrameObservation = freeze({ channel: NpmStackChannel.Unknown,
  errorClass: NpmStackError.Unknown, module: NpmFrameModule.Unknown, line: null });
// Exact eight files in Node v22.23.3 commit80dc6320's bundled npm10.9.9. No path
// discovered from child output is opened. Unknown first frames are not skipped.
const pins: readonly (readonly [NpmFrameModule, string, string, number])[] = [
  [NpmFrameModule.Dispatch, "lib/npm.js", "3800acd5f01f77e2f7efa874f02c33f1c40ea7d7baca14d718540c313c23f659", 475],
  [NpmFrameModule.Install, "lib/commands/install.js", "a8fac192d66e09fdf017ff9d48cd486948785309622c895a0c790c8cf691f829", 176],
  [NpmFrameModule.Config, "node_modules/@npmcli/config/lib/index.js", "aa283456b6e3c72396b0bc8230d31072665f753d5b80e04efa556713339adbad", 931],
  [NpmFrameModule.IdealTree, "node_modules/@npmcli/arborist/lib/arborist/build-ideal-tree.js", "496a1cff821848cc5d01341a70d916b01d017a380a12553e30906a468f27a47f", 1523],
  [NpmFrameModule.Reify, "node_modules/@npmcli/arborist/lib/arborist/reify.js", "f3a2443071941e92d1dd176dc77dbc7ba669850c5d1f50bb7df8ef08b4cfb310", 1637],
  [NpmFrameModule.Node, "node_modules/@npmcli/arborist/lib/node.js", "3f67c36d6613c9bc83b1cdf94ea30a686a48759512c62fef50e0861dc3069f03", 1495],
  [NpmFrameModule.Fetcher, "node_modules/pacote/lib/fetcher.js", "1a385341f75d6c77496d30e7751012ad91489bb8c4e4e4db5e4568d2b9432a79", 497],
  [NpmFrameModule.PackageArgument, "node_modules/npm-package-arg/lib/npa.js", "36e001c155380d6114fb916519b29848da8fa4726169775159996f3d2edb11e9", 481],
];
/** Bounded fixed-path source readbacks before the command. Descriptor/named
 * identity, readonly owned ancestors and digest joins preserve the dictionary. */
export function verifyPinnedTestNpmFrameSources(): void {
  for (const [, relative, expected] of pins) {
    const path = npmRoot + "/" + relative;
    let parent = "/";
    for (const component of path.split("/").slice(1, -1)) {
      parent += (parent === "/" ? "" : "/") + component;
      const stat = lstatSync(parent); assert(stat.isDirectory() && !stat.isSymbolicLink() &&
        stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
    }
    assert.equal(realpathSync(path), path);
    const named = lstatSync(path, { bigint: true });
    assert(named.isFile() && !named.isSymbolicLink() && named.uid === 0n && named.gid === 0n &&
      named.nlink === 1n && !(named.mode & 0o022n) && named.size > 0n && named.size <= 262144n);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      assert(before.isFile() && before.dev === named.dev && before.ino === named.ino &&
        before.size === named.size && before.mode === named.mode && before.uid === named.uid &&
        before.gid === named.gid && before.nlink === named.nlink &&
        before.mtimeNs === named.mtimeNs && before.ctimeNs === named.ctimeNs);
      const bytes = Buffer.alloc(Number(before.size));
      assert.equal(readSync(fd, bytes, 0, bytes.length, 0), bytes.length);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
      for (const after of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
        assert(after.isFile() && after.dev === before.dev && after.ino === before.ino &&
          after.size === before.size && after.mode === before.mode && after.uid === before.uid &&
          after.gid === before.gid && after.nlink === before.nlink &&
          after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs);
    } finally { closeSync(fd); }
  }
}
/** One header and its immediate FIRST frame only, at most4MiB. This is lexical
 * membership. No message/function/path/column/errno/cause is returned. */
type FirstNpmFrame = Readonly<{ channel: NpmStackChannel; errorClass: NpmStackError;
  path?: string; line?: number; column?: number }>;
function firstNpmFrame(stderr: unknown): FirstNpmFrame | undefined {
  if (typeof stderr !== "string" || stderr.length > 4 * 1024 * 1024) return undefined;
  // Select the FIRST complete stack/raw record before validating its class.
  // No malformed, oversized or arbitrary first header can be skipped.
  const records = /^(?:npm verbose stack[^\r\n]*|(?!(?:npm |[ \t\r\n]))[^\r\n]+)\r?$/gm;
  const selected = records.exec(stderr); if (!selected) return undefined;
  const first = /^(npm verbose stack )?(Error|TypeError|RangeError|SyntaxError|ReferenceError):[^\r\n]*\r?$/.exec(selected[0]);
  if (!first) return undefined;
  const later = /^(?:npm verbose stack(?!     at )[^\r\n]*|(?!(?:npm |[ \t\r\n]))[^\r\n]+)\r?$/gm;
  later.lastIndex = selected.index + selected[0].length;
  if (later.exec(stderr)) return undefined;
  const channel = first[1] ? NpmStackChannel.Verbose : NpmStackChannel.Uncaught;
  let errorClass = NpmStackError.Unknown;
  switch (first[2]) {
    case "Error": errorClass = NpmStackError.Error; break;
    case "TypeError": errorClass = NpmStackError.Type; break;
    case "RangeError": errorClass = NpmStackError.Range; break;
    case "SyntaxError": errorClass = NpmStackError.Syntax; break;
    case "ReferenceError": errorClass = NpmStackError.Reference; break;
    default: return undefined;
  }
  const start = selected.index + selected[0].length;
  if (stderr[start] !== "\n") return undefined;
  const end = stderr.indexOf("\n", start + 1), line = stderr.slice(start + 1, end < 0 ? undefined : end).replace(/\r$/, "");
  const prefix = first[1] ?? "";
  if (!line.startsWith(prefix + "    at ")) return undefined;
  const frame = line.slice(prefix.length + 7);
  // The function label is examined only for syntax and is never persisted.
  const match = /^(?:[^()\r\n]{1,128} \()?([^()\r\n]{1,256}):([1-9][0-9]{0,3}):([1-9][0-9]{0,3})(\))?$/.exec(frame);
  if (!match || typeof match[1] !== "string" || frame.includes("(") !== (match[4] === ")"))
    return { channel, errorClass };
  return { channel, errorClass, path: match[1], line: Number(match[2]), column: Number(match[3]) };
}
export function observePinnedTestNpmFrame(stderr: unknown): TestNpmFrameObservation {
  const first = firstNpmFrame(stderr); if (!first) return unknownFrame;
  const { channel, errorClass } = first;
  for (const [module, relative, , maximumLine] of pins) {
    if (first.path === npmRoot + "/" + relative && first.line !== undefined && first.line <= maximumLine &&
        first.column !== undefined && first.column <= 4096)
      return freeze({ channel, errorClass, module, line: first.line });
  }
  return freeze({ channel, errorClass, module: NpmFrameModule.Unknown, line: null });
}


enum PublicNpmFrameKind { Unknown = "unknown", PinnedVendorSource = "pinned_public_vendor_source" }
export type TestNpmPublicFrameObservation = Readonly<{ sourceKind: PublicNpmFrameKind;
  catalogId: number | null; sourceSha256: string | null; line: number | null;
  channel: NpmStackChannel; errorClass: NpmStackError }>;
const unknownPublicFrame: TestNpmPublicFrameObservation = freeze({ sourceKind: PublicNpmFrameKind.Unknown,
  catalogId: null, sourceSha256: null, line: null, channel: NpmStackChannel.Unknown, errorClass: NpmStackError.Unknown });
/** Reads only a generated PUBLIC catalog entry after exact lexical membership.
 * Never opens a path from stderr. Credential/config/non-JS/unlisted files have
 * no catalog membership. Exact public Git blob is required before SHA256 emits. */
function readPublicNpmSource(entry: NpmPublicSourceRecord): Buffer {
  const path = npmRoot + "/" + entry.path;
  let parent = "/";
  for (const component of path.split("/").slice(1, -1)) {
    parent += (parent === "/" ? "" : "/") + component;
    const stat = lstatSync(parent); assert(stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
  }
  assert.equal(realpathSync(path), path);
  const named = lstatSync(path, { bigint: true });
  assert(named.isFile() && !named.isSymbolicLink() && named.uid === 0n && named.gid === 0n &&
    named.nlink === 1n && !(named.mode & 0o022n) && named.size === BigInt(entry.bytes) &&
    named.size > 0n && named.size <= 147869n);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    for (const stat of [before]) assert(stat.isFile() && stat.dev === named.dev && stat.ino === named.ino &&
      stat.size === named.size && stat.mode === named.mode && stat.uid === named.uid && stat.gid === named.gid &&
      stat.nlink === named.nlink && stat.mtimeNs === named.mtimeNs && stat.ctimeNs === named.ctimeNs);
    const bytes = Buffer.alloc(entry.bytes); assert.equal(readSync(fd, bytes, 0, bytes.length, 0), bytes.length);
    for (const stat of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
      assert(stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
        stat.mode === before.mode && stat.uid === before.uid && stat.gid === before.gid &&
        stat.nlink === before.nlink && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs);
    assert.equal(createHash("sha1").update("blob " + entry.bytes + "\0").update(bytes).digest("hex"), entry.gitBlob);
    return bytes;
  } finally { closeSync(fd); }
}
/** Public source identity only. A hash cannot grant custody, permission, retry,
 * model availability, success, cause or general runtime attestation. Mutation,
 * unknown/builtin/malformed FIRST frame or any pin/IO failure stays Unknown. */
export function observePublicTestNpmFrame(stderr: unknown): TestNpmPublicFrameObservation {
  const first = firstNpmFrame(stderr);
  if (!first || typeof first.path !== "string" || !first.path.startsWith(npmRoot + "/") ||
      first.line === undefined || first.column === undefined || first.column > 4096) return unknownPublicFrame;
  const relative = first.path.slice(npmRoot.length + 1);
  const entry = lookupNpmPublicSourcePart0(relative) ?? lookupNpmPublicSourcePart1(relative);
  if (!entry) return unknownPublicFrame;
  try {
    const bytes = readPublicNpmSource(entry);
    let lines = bytes[bytes.length - 1] === 10 ? 0 : 1;
    for (const byte of bytes) if (byte === 10) ++lines;
    if (first.line > lines) return unknownPublicFrame;
    return freeze({ sourceKind: PublicNpmFrameKind.PinnedVendorSource, catalogId: entry.id,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"), line: first.line,
      channel: first.channel, errorClass: first.errorClass });
  } catch { return unknownPublicFrame; }
}
