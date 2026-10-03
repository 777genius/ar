import { beforeEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { assertHostedReadonlyPolicyBinding, hostedReadonlyPolicyRoot, parseHostedReadonlyPolicy, readHostedReadonlyPolicy } from
  "../hosted-readonly-inputs";

const fs = vi.hoisted(() => ({
  lstatSync: vi.fn(), openSync: vi.fn(), fstatSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn(),
}));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(), ...fs,
}));
const policy = {
  schemaVersion: 1, jobId: "fixture", jobRootDir: "/fixture/job", workspacePath: "/fixture/workspace",
  runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
  issuerDeploymentDigest: "c".repeat(64), readonlyPaths: ["/fixture/workspace/input"],
};
const fileStat = (size: number) => ({
  isFile: () => true, uid: 0, nlink: 1, mode: 0o100600, size, mtimeMs: 1, ctimeMs: 1,
});
function inputBytes(bytes: Buffer) {
  fs.fstatSync.mockReturnValue(fileStat(bytes.length));
  fs.readSync.mockImplementation((_fd, target: Buffer, offset: number, length: number, position: number) =>
    bytes.copy(target, offset, position, position + length));
}
beforeEach(() => {
  vi.resetAllMocks();
  fs.lstatSync.mockReturnValue({ isDirectory: () => true, uid: 0, mode: 0o40700 });
  fs.openSync.mockReturnValue(42);
  inputBytes(Buffer.from(JSON.stringify(policy)));
});

describe("readonly policy closed parsing (not admission authority)", () => {
  it.each([
    { jobId: "other-job" }, { jobRootDir: "/fixture/other-job" },
    { workspacePath: "/fixture", readonlyPaths: ["/fixture/workspace/input"] },
    { runtimeSha: "d".repeat(40) }, { runtimeManifestSha256: "e".repeat(64) },
    { issuerDeploymentDigest: "f".repeat(64) },
    { readonlyPaths: ["/fixture/workspace/other-input"] },
  ])("rejects each independent identity/projection mismatch %j", change => {
    expect(() => assertHostedReadonlyPolicyBinding(
      parseHostedReadonlyPolicy({ ...policy, ...change }), parseHostedReadonlyPolicy(policy),
    )).toThrow("hosted_readonly_policy_binding_mismatch");
  });
  it("compares normalized closed fields, not JSON property insertion order", () => {
    const same = Object.fromEntries(Object.entries(policy).reverse());
    expect(() => assertHostedReadonlyPolicyBinding(
      parseHostedReadonlyPolicy(same), parseHostedReadonlyPolicy(policy),
    )).not.toThrow();
  });
  it("copies and freezes a valid closed policy", () => {
    const input = { ...policy, readonlyPaths: [...policy.readonlyPaths] };
    const parsed = parseHostedReadonlyPolicy(input);
    input.readonlyPaths[0] = "/fixture/workspace/other";
    expect(parsed.readonlyPaths).toEqual(policy.readonlyPaths);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.readonlyPaths)).toBe(true);
  });
  it.each([
    null, [], { ...policy, schemaVersion: "1" }, { ...policy, extra: true },
    { ...policy, jobId: " " }, { ...policy, jobId: "a".repeat(257) },
    { ...policy, jobId: "a\n" }, { ...policy, jobRootDir: "/a/../b" },
    { ...policy, runtimeSha: "a".repeat(39) }, { ...policy, runtimeSha: "A".repeat(40) },
    { ...policy, runtimeManifestSha256: 123 }, { ...policy, issuerDeploymentDigest: "claimed-approved" },
    { ...policy, readonlyPaths: [] }, { ...policy, readonlyPaths: "input" },
    { ...policy, readonlyPaths: [123] }, { ...policy, readonlyPaths: ["/outside"] },
    { ...policy, readonlyPaths: ["/fixture/workspace/input", "/fixture/workspace/input/a"] },
  ])("rejects malformed data %j", value => {
    expect(() => parseHostedReadonlyPolicy(value)).toThrow();
  });
});

describe("fixed private policy reader", () => {
  it("walks root-owned parents top down before bounded no-follow open and always closes", () => {
    expect(readHostedReadonlyPolicy("fixture")?.policy).toEqual(policy);
    expect(fs.lstatSync.mock.calls.map(call => call[0])).toEqual([
      "/", "/run", "/run/user", "/run/user/0", "/run/user/0/subscription-runtime-host-policy",
      hostedReadonlyPolicyRoot,
    ]);
    expect(fs.openSync).toHaveBeenCalledWith(expect.stringMatching(/codex-readonly\/[a-f0-9]{64}\.json$/),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });
  it("returns absence only for ENOENT and rejects inaccessible state", () => {
    fs.openSync.mockImplementation(() => { throw Object.assign(new Error(), { code: "ENOENT" }); });
    expect(readHostedReadonlyPolicy("fixture")).toBeNull();
    fs.openSync.mockImplementation(() => { throw Object.assign(new Error(), { code: "EACCES" }); });
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow("hosted_readonly_policy_invalid");
  });
  it.each([
    { isDirectory: () => false, uid: 0, mode: 0o40700 },
    { isDirectory: () => true, uid: 65532, mode: 0o40700 },
    { isDirectory: () => true, uid: 0, mode: 0o40722 },
  ])("rejects symlink/non-directory, wrong owner and writable ancestors before open", stat => {
    fs.lstatSync.mockReturnValueOnce(stat);
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it.each([
    { isFile: () => false }, { uid: 65532 }, { nlink: 2 }, { mode: 0o100644 }, { size: 65537 },
  ])("rejects unsafe final inode %j without reading bytes", change => {
    fs.fstatSync.mockReturnValue({ ...fileStat(1), ...change });
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });
  it("bounds the read even if a trusted file changes after its first stat", () => {
    inputBytes(Buffer.alloc(65537, 32));
    fs.fstatSync.mockReturnValueOnce(fileStat(100));
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    expect(fs.readSync.mock.calls[0]?.[3]).toBe(65537);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });
  it("accepts exactly 64 KiB and rejects extra bytes, invalid UTF-8 and wrong job", () => {
    const json = JSON.stringify(policy);
    inputBytes(Buffer.from(json.padEnd(65536, " ")));
    expect(readHostedReadonlyPolicy("fixture")?.bytes.length).toBe(65536);
    inputBytes(Buffer.from([255]));
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    inputBytes(Buffer.from(JSON.stringify({ ...policy, jobId: "other" })));
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
  });
  it("rejects a same-length concurrent edit rather than accepting its parsed content", () => {
    const size = Buffer.byteLength(JSON.stringify(policy));
    fs.fstatSync.mockReturnValueOnce(fileStat(size)).mockReturnValueOnce({ ...fileStat(size), ctimeMs: 2 });
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
  });
});
