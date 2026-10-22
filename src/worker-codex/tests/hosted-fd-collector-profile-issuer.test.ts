import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fdCollectorProfileLimitMaxima, parseFdCollectorProfile, parseFdCollectorRows } from "@vioxen/subscription-runtime/core";
import { assertRendererRoundTrip, assertSsRendererVersion, encodeFdCollectorProfile, issueFdCollectorProfile, type ProfilePorts, type RendererPorts } from "../hosted-fd-collector-profile-issuer";
import { parseIssuerCliArgs } from "../hosted-runtime-issuer-cli";
import { IssuerReceiptKind, parseIssuerReceipt, verifyIssuerReceipt } from "../hosted-runtime-stage-curator";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const operationId = "11111111-1111-4111-8111-111111111111", runtimeSha = "1".repeat(40), runtimeDirectory = "/opt/subscription-runtime/releases/" + runtimeSha;
const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", scopeSha = "5".repeat(64);

/** Rendering of a kernel inode the way the pinned ss prints it: uint32 through signed int. */
const signed = (inode: number): string => String(inode > 2147483647 ? inode - 4294967296 : inode);
const row = (local: number, peer: number) => `0 0 * ${signed(local)} * ${signed(peer)}`;
function renderer(local: number, peer: number, rows: (local: number, peer: number) => string): RendererPorts {
  return { openPair: () => ({ localInode: String(local), peerInode: String(peer), close: vi.fn() }), collect: () => parseFdCollectorRows(rows(local, peer), fdCollectorProfileLimitMaxima.maxRows) };
}
function harness(rendererPorts: RendererPorts = renderer(3_000_000_000, 5, (l, p) => `${row(l, p)}\n${row(p, l)}\n`)) {
  const store = new Map<string, Buffer>();
  const upgrade = vi.fn();
  const ports: ProfilePorts = {
    ensureDirectory: vi.fn(), publish: (path, bytes) => { if (store.has(path)) throw new Error("EEXIST"); store.set(path, Buffer.from(bytes)); }, readPrivate: path => store.get(path) ?? null,
    nodePath: "/usr/bin/node",
    measure: executable => [{ path: executable, sha256: sha(executable) }, { path: "/usr/lib/x86_64-linux-gnu/libc.so.6", sha256: sha("libc") }],
    pin: path => ({ path, sha256: sha(path) }),
    renderer: rendererPorts, ssVersion: () => "ss utility, iproute2-6.1.0\n", upgrade, bootId: () => bootId, moduleSha256: () => "3".repeat(64), sourceScopeSha256: () => scopeSha,
  };
  return { ports, store, upgrade };
}
const request = { operationId, runtimeDirectory, runtimeSha };

describe("collector profile issuer: published bytes", () => {
  // Regression: the issuer measures its own limits (a measured zero is invalid) or writes bytes the product parser/upgrade validator reads differently.
  it("publishes canonical bytes with the contract maxima, validates exactly them and writes a closed receipt", () => {
    const h = harness(), out = issueFdCollectorProfile(request, h.ports);
    const bytes = h.store.get(out.preparedPath) as Buffer;
    expect(out.preparedPath).toBe(`/var/lib/subscription-runtime-host-policy/ordinary-installations/${operationId}.profile.json`);
    expect(sha(bytes)).toBe(out.profileSha256);
    const profile = parseFdCollectorProfile(JSON.parse(bytes.toString("utf8")));
    expect(profile.limits).toEqual(fdCollectorProfileLimitMaxima);
    expect(encodeFdCollectorProfile(profile).equals(bytes)).toBe(true);
    expect(h.upgrade).toHaveBeenCalledOnce();
    expect(h.upgrade.mock.calls[0]?.[0]).toEqual({ path: out.preparedPath, sha256: out.profileSha256 });
    const receipt = parseIssuerReceipt(h.store.get(out.receiptPath) as Buffer);
    expect(receipt).toMatchObject({ kind: IssuerReceiptKind.FdCollectorProfile, operationId, outputPath: out.preparedPath, outputSha256: out.profileSha256, sourceScopeSha256: scopeSha, bootId, issuerModuleSha256: "3".repeat(64) });
    const expected = { kind: IssuerReceiptKind.FdCollectorProfile, bootId, issuerModuleSha256: "3".repeat(64), outputPath: out.preparedPath, outputSha256: out.profileSha256, sourceScopeSha256: scopeSha,
      runtimeDirectory, runtimeSha, operationId };
    expect(verifyIssuerReceipt(h.store.get(out.receiptPath) as Buffer, expected).operationId).toBe(operationId);
    // a receipt of another funded operation / path is not this operation's receipt
    expect(() => verifyIssuerReceipt(h.store.get(out.receiptPath) as Buffer, { ...expected, operationId: "22222222-2222-4222-8222-222222222222" })).toThrow();
    expect(() => verifyIssuerReceipt(h.store.get(out.receiptPath) as Buffer, { ...expected, outputPath: out.preparedPath.replace(operationId, "22222222-2222-4222-8222-222222222222") })).toThrow();
  });
  // Regression: a replay writes a different profile next to the first one.
  it("is idempotent and refuses a conflicting prepared profile without touching it", () => {
    const h = harness(), out = issueFdCollectorProfile(request, h.ports);
    expect(issueFdCollectorProfile(request, h.ports)).toEqual(out);
    const other = harness(); other.store.set(out.preparedPath, Buffer.from("{}\n"));
    expect(() => issueFdCollectorProfile(request, other.ports)).toThrow("hosted_runtime_issuer_conflicting_record");
    expect(other.store.get(out.preparedPath)?.toString("utf8")).toBe("{}\n");
    expect(other.upgrade).not.toHaveBeenCalled();
  });
  // Regression (F1): the prepared profile is persistent, so after a reboot the same operation is reissued with the SAME profile bytes and a new boot: the receipt must be a new file, not a collision.
  it("reissues the same profile on a second boot with a boot-named receipt", () => {
    const h = harness(), first = issueFdCollectorProfile(request, h.ports);
    const second = issueFdCollectorProfile(request, { ...h.ports, bootId: () => "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    expect(second.profileSha256).toBe(first.profileSha256);
    expect(second.receiptPath).not.toBe(first.receiptPath);
    expect(parseIssuerReceipt(h.store.get(second.receiptPath) as Buffer).bootId).toBe("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(parseIssuerReceipt(h.store.get(first.receiptPath) as Buffer).bootId).toBe(bootId);
  });
  // Regression (F5): the reciprocal round trip passes on small inodes with ANY ss, so the signed-int32 label was an unchecked claim.
  it.each(["ss utility, iproute2-6.2.0\n", "ss utility, iproute2-5.15.0\n", "ss utility, iproute2-6.10.0\n", "ss utility, iproute2-6.1\n", "\n", "BusyBox v1.36 ss\n", "iproute2-6.1.0\n"])("refuses the ss version output %j before writing anything", output => {
    const h = harness(); h.ports = { ...h.ports, ssVersion: () => output };
    expect(() => issueFdCollectorProfile(request, h.ports)).toThrow("hosted_runtime_issuer_invalid");
    expect(h.store.size).toBe(0);
    expect(h.upgrade).not.toHaveBeenCalled();
  });
  it("accepts iproute2 6.1.x version lines", () => {
    for (const output of ["ss utility, iproute2-6.1.0\n", "ss utility, iproute2-6.1.0, libbpf 1.3.0\n", "\nss utility, iproute2-6.1.12\n"]) expect(() => assertSsRendererVersion(output)).not.toThrow();
  });
  // Regression: a closure without the executable itself or an unbounded closure is pinned.
  it("refuses an ELF closure that lacks the executable", () => {
    const h = harness(); h.ports = { ...h.ports, measure: () => [{ path: "/usr/lib/other.so", sha256: sha("x") }] };
    expect(() => issueFdCollectorProfile(request, h.ports)).toThrow("hosted_runtime_issuer_invalid");
    expect(h.store.size).toBe(0);
  });
  // Regression: the upgrade validator fails after the profile is published and the failure is swallowed (no receipt must exist then).
  it("writes no receipt when the product upgrade validator refuses", () => {
    const h = harness(); h.upgrade.mockImplementation(() => { throw new Error("ordinary_launcher_qualification_held"); });
    expect(() => issueFdCollectorProfile(request, h.ports)).toThrow("ordinary_launcher_qualification_held");
    expect([...h.store.keys()].some(path => path.includes("issuer-receipts"))).toBe(false);
  });
  it.each([["operation id", { ...request, operationId: "x" }], ["sha", { ...request, runtimeSha: "abc" }], ["relative directory", { ...request, runtimeDirectory: "opt/x" }]])("refuses a malformed %s", (_name, bad) => {
    const h = harness();
    expect(() => issueFdCollectorProfile(bad, h.ports)).toThrow();
    expect(h.store.size).toBe(0);
  });
});

describe("collector renderer qualification (signed int32 bytes)", () => {
  const profile = () => {
    const h = harness();
    issueFdCollectorProfile(request, h.ports);
    return parseFdCollectorProfile(JSON.parse(([...h.store.values()][0] as Buffer).toString("utf8")));
  };
  // Regression: inodes above 2^31 are rendered negative by the pinned ss; an unsigned reading (or a lost sign) breaks the reciprocal lookup.
  it("accepts reciprocal rows whose inodes print as negative signed ints, up to -2147483648", () => {
    expect(row(3_000_000_000, 5)).toBe("0 0 * -1294967296 * 5");
    expect(() => assertRendererRoundTrip(renderer(3_000_000_000, 5, (l, p) => `${row(l, p)}\n${row(p, l)}\n`), profile())).not.toThrow();
    expect(() => assertRendererRoundTrip(renderer(2_147_483_648, 4_294_967_295, (l, p) => `${row(l, p)}\n${row(p, l)}\n`), profile())).not.toThrow();
    expect(row(2_147_483_648, 4_294_967_295)).toBe("0 0 * -2147483648 * -1");
  });
  // Regression: the renderer prints unsigned numbers (a different ss) and the issuer qualifies it anyway; or one direction is missing.
  it("refuses an unsigned rendering, a missing or non-reciprocal direction and a wrong peer", () => {
    expect(() => assertRendererRoundTrip(renderer(3_000_000_000, 5, (l, p) => `0 0 * ${l} * ${p}\n0 0 * ${p} * ${l}\n`), profile())).toThrow();
    expect(() => assertRendererRoundTrip(renderer(3_000_000_000, 5, (l, p) => `${row(l, p)}\n`), profile())).toThrow("hosted_runtime_issuer_invalid");
    expect(() => assertRendererRoundTrip(renderer(7, 9, (l, p) => `${row(l, p)}\n${row(p, 11)}\n`), profile())).toThrow("hosted_runtime_issuer_invalid");
    expect(() => assertRendererRoundTrip(renderer(7, 9, () => ""), profile())).toThrow("hosted_runtime_issuer_invalid");
  });
  // Regression: the pair is leaked when the comparison throws.
  it("always closes the socket pair", () => {
    const close = vi.fn(), ports: RendererPorts = { openPair: () => ({ localInode: "7", peerInode: "9", close }), collect: () => parseFdCollectorRows("", 10) };
    expect(() => assertRendererRoundTrip(ports, profile())).toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
  // Regression: the parser's bounds are copied by hand and rows beyond maxRows pass.
  it("refuses more rows than the shared maximum", () => {
    const many = Array.from({ length: fdCollectorProfileLimitMaxima.maxRows + 1 }, (_value, index) => row(index + 1, index + 2)).join("\n");
    expect(() => parseFdCollectorRows(many, fdCollectorProfileLimitMaxima.maxRows)).toThrow();
  });
});

describe("issuer CLI arguments", () => {
  // Regression: the operator entry accepts a relative path, a malformed id or trailing arguments, so a typo selects another output.
  it("accepts exactly the two documented command shapes", () => {
    expect(parseIssuerCliArgs(["curate-stage", runtimeDirectory, runtimeSha, "2".repeat(64)])).toEqual({ command: "curate-stage", runtimeDirectory, runtimeSha, archiveSha256: "2".repeat(64) });
    expect(parseIssuerCliArgs(["issue-profile", operationId, runtimeDirectory, runtimeSha, "absent"])).toMatchObject({ command: "issue-profile", prior: "absent" });
    for (const bad of [[], ["curate-stage"], ["curate-stage", "rel/dir", runtimeSha, "2".repeat(64)], ["curate-stage", runtimeDirectory, runtimeSha, "2".repeat(64), "x"],
      ["issue-profile", "nope", runtimeDirectory, runtimeSha, "absent"], ["issue-profile", operationId, runtimeDirectory, runtimeSha], ["unknown", "a"]]) {
      expect(() => parseIssuerCliArgs(bad)).toThrow("hosted_runtime_issuer_usage");
    }
  });
});
