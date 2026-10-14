import { describe, expect, it } from "vitest";
import { fdCollectorProfilePath, FdCollectorRenderer, FdCollectorPeerStatus, knownFdCollectorPeer, parseFdCollectorProfile,
  parseFdCollectorRows, readFdCollectorProfileField } from "../host-infrastructure/fd-collector-profile";

const sha256 = "a".repeat(64);
const file = (path: string) => ({ path, sha256 });
const executable = (path: string) => ({ ...file(path), elfFiles: [file(path), file("/usr/lib/loader.so")] });
function profile() {
  return { schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed,
    ss: executable("/usr/bin/ss"), node: executable("/runtime/node"),
    wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable("/usr/bin/" + name)),
    bootstraps: ["hosted-app-server-launcher", "hosted-dependency-installer-bootstrap",
      "hosted-readonly-host-launch-cli", "hosted-readonly-runtime-bootstrap"].map(name => file(`/runtime/${name}.js`)),
    limits: { setupTimeoutMs: 1000, collectorTimeoutMs: 500, maxOutputBytes: 4096, maxRows: 32,
      maxBufferedInputBytes: 4096, maxEventPoll: 2, maxEventFd: 2, maxPipeEndpoints: 8, maxDevNullReserves: 2 } };
}

describe("finite collector input contracts, without native qualification", () => {
  // Regression: a sidecar field silently upgrades legacy inventory authority,
  // or schema4 omits its independently authenticated fixed pin.
  it("requires the fixed profile pin only for schema4 and rejects legacy field smuggling", () => {
    for (const schemaVersion of [1, 2, 3]) {
      expect(readFdCollectorProfileField({ schemaVersion })).toBeUndefined();
      expect(() => readFdCollectorProfileField({ schemaVersion, collectorProfile: file(fdCollectorProfilePath) })).toThrow();
    }
    expect(readFdCollectorProfileField({ schemaVersion: 4, collectorProfile: file(fdCollectorProfilePath) })).toEqual(file(fdCollectorProfilePath));
    expect(() => readFdCollectorProfileField({ schemaVersion: 4 })).toThrow();
    expect(() => readFdCollectorProfileField({ schemaVersion: 4, collectorProfile: file("/tmp/profile.json") })).toThrow();
    expect(() => readFdCollectorProfileField({ schemaVersion: 4, collectorProfile: { ...file(fdCollectorProfilePath), qualified: true } })).toThrow();
  });

  // Regression: caller mutation changes the parsed closure after its digest
  // binding, or an unknown wrapper/renderer escapes the closed native recipe.
  it("detaches and freezes parsed closure data and rejects extra authority fields", () => {
    const input = profile(), parsed = parseFdCollectorProfile(input);
    input.node.elfFiles[0]!.sha256 = "b".repeat(64);
    input.bootstraps.pop(); input.limits.setupTimeoutMs = 60_000;
    expect(parsed.node.elfFiles[0]!.sha256).toBe(sha256);
    expect(parsed.bootstraps).toHaveLength(4);
    expect(parsed.limits.setupTimeoutMs).toBe(1000);
    expect(Object.isFrozen(parsed.node.elfFiles)).toBe(true);
    expect(() => parseFdCollectorProfile({ ...profile(), qualified: true })).toThrow();
    expect(() => parseFdCollectorProfile({ ...profile(), renderer: "proc-peer" })).toThrow();
    const missing = profile(); missing.wrappers[0] = executable("/usr/bin/other");
    expect(() => parseFdCollectorProfile(missing)).toThrow();
    const over = profile(); over.limits.collectorTimeoutMs = 1001;
    expect(() => parseFdCollectorProfile(over)).toThrow();
  });
});

describe("pinned ss six-field numeric renderer", () => {
  // Regression: signed uint32 kernel inodes are rejected, normalized as queue
  // values, or fail reciprocal equality with actual /proc socket inode strings.
  it("normalizes signed inode columns while retaining unsigned queue grammar", () => {
    const rows = parseFdCollectorRows("0 4294967295 * -2147483648 * -1\n0 0 * -1 * -2147483648\n", 2);
    expect([...rows]).toEqual([
      ["2147483648", { status: FdCollectorPeerStatus.Known, inode: "4294967295" }],
      ["4294967295", { status: FdCollectorPeerStatus.Known, inode: "2147483648" }],
    ]);
    expect(knownFdCollectorPeer(rows, "2147483648")).toBe("4294967295");
    expect(knownFdCollectorPeer(rows, "4294967295")).toBe("2147483648");
  });
  // Regression: an unresolved background row denies unrelated known pairs,
  // or is dropped from membership/accounting and promoted to peer authority.
  it("retains unresolved peers alongside known reciprocal endpoints", () => {
    const rows = parseFdCollectorRows("0 0 * 12 * 0\n0 0 * 10 * 11\n0 0 * 11 * 10\n", 3);
    expect([...rows.keys()]).toEqual(["12", "10", "11"]);
    expect(rows.size).toBe(3);
    expect(rows.has("12")).toBe(true);
    expect(rows.has("0")).toBe(false);
    expect(rows.get("12")).toEqual({ status: FdCollectorPeerStatus.Unresolved });
    expect(Object.isFrozen(rows.get("12"))).toBe(true);
    expect(Object.isFrozen(rows.get("10"))).toBe(true);
    expect(knownFdCollectorPeer(rows, "12")).toBeUndefined();
    expect(knownFdCollectorPeer(rows, "missing")).toBeUndefined();
    expect(knownFdCollectorPeer(rows, "10")).toBe("11");
    expect(knownFdCollectorPeer(rows, "11")).toBe("10");
  });
  // Regression: missing/zero forward or reverse facts become a usable endpoint.
  // These are parser/lookup facts, not a manufactured host release permit.
  it("withholds known peers for unresolved and incomplete endpoint observations", () => {
    const cases: Array<[string, string | undefined, string | undefined]> = [
      ["0 0 * 10 * 0\n", undefined, undefined],
      ["0 0 * 10 * 11\n0 0 * 11 * 0\n", "11", undefined],
      ["0 0 * 10 * 11\n", "11", undefined],
      ["0 0 * 10 * 11\n0 0 * 11 * 12\n", "11", "12"],
      ["0 0 * 10 * 0\n0 0 * 11 * 0\n", undefined, undefined],
    ];
    for (const [text, forward, reverse] of cases) {
      const rows = parseFdCollectorRows(text, 2);
      expect(knownFdCollectorPeer(rows, "10")).toBe(forward);
      expect(knownFdCollectorPeer(rows, "11")).toBe(reverse);
    }
  });
  // Regression: a hostile rendered path, invalid local identity, duplicate local,
  // queue overflow or noncanonical signed value is mistaken for kernel proof.
  it.each(["0 0 /named 10 * 11\n", "0 0 * 0 * 11\n", "0 0 * 10 * 11\n0 0 * 10 * 12\n",
    "0 0 * 10 * 0\n0 0 * 10 * 11\n", "0 0 * 10 * 11\n0 0 * 10 * 0\n",
    "-1 0 * 10 * 11\n", "4294967296 0 * 10 * 11\n", "0 0 * 2147483648 * 11\n",
    "0 0 * -2147483649 * 11\n", "0 0 * -0 * 11\n", "0 0 * +10 * 11\n",
    "0 0 * 010 * 11\n", "0 0 * 10 * -0\n", "0 0 * 10 * 00\n", "0 0 * 10 * +11\n",
    "0 0 * 10 * 2147483648\n", "0 0 * 10 * -2147483649\n",
    "0 0 * 10 * 11 extra\n", "0 0 * 10 * 11\u0000\n"])("rejects malformed row %j", text => {
      expect(() => parseFdCollectorRows(text, 32)).toThrow();
    });
  it("enforces the qualified output row bound", () => {
    expect(() => parseFdCollectorRows("0 0 * 10 * 11\n0 0 * 11 * 10\n", 1)).toThrow();
    expect(() => parseFdCollectorRows("0 0 * 12 * 0\n0 0 * 10 * 11\n0 0 * 11 * 10\n", 2)).toThrow();
  });
});
