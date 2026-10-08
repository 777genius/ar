import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { assertHostedReadonlyPolicyBinding, hostedReadonlyAuthorityBasesAbsent, hostedReadonlyPolicyRoot, parseHostedReadonlyPolicy, readHostedReadonlyPolicy, readHostedPrivateBytes } from
  "../hosted-readonly-inputs";

const file = vi.hoisted(() => ({ stat: vi.fn() }));
const directoryStat = () => ({ isDirectory: () => true, uid: 0, mode: 0o40700, dev: 1, ino: 2 });
const fs = vi.hoisted(() => ({
  lstatSync: vi.fn(), statSync: vi.fn(), openSync: vi.fn(), fstatSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn(),
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
  file.stat.mockReturnValue(fileStat(bytes.length));
  fs.readSync.mockImplementation((_fd, target: Buffer, offset: number, length: number, position: number) =>
    bytes.copy(target, offset, position, position + length));
}
beforeEach(() => {
  vi.resetAllMocks();
  fs.lstatSync.mockReturnValue(directoryStat());
  fs.statSync.mockReturnValue(directoryStat());
  fs.openSync.mockImplementation((_path, flags) => flags & constants.O_DIRECTORY ? 41 : 42);
  fs.fstatSync.mockImplementation(fd => fd === 41 ? directoryStat() : file.stat());
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
    expect(fs.lstatSync.mock.calls.slice(0, 6).map(call => call[0])).toEqual([
      "/", "/run", "/run/user", "/run/user/0", "/run/user/0/subscription-runtime-host-policy",
      hostedReadonlyPolicyRoot,
    ]);
    expect(fs.openSync).toHaveBeenCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/41\/[a-f0-9]{64}\.json$/),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(fs.closeSync.mock.calls.map(call => call[0])).toEqual([42, 41]);
  });
  it("returns absence only for ENOENT and rejects inaccessible state", () => {
    fs.openSync.mockImplementation((_path, flags) => { if (flags & constants.O_DIRECTORY) return 41; throw Object.assign(new Error(), { code: "ENOENT" }); });
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
    file.stat.mockReturnValue({ ...fileStat(1), ...change });
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync.mock.calls.map(call => call[0])).toEqual([42, 41]);
  });
  it("bounds the read even if a trusted file changes after its first stat", () => {
    inputBytes(Buffer.alloc(65537, 32));
    file.stat.mockReturnValueOnce(fileStat(100));
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
    expect(fs.readSync.mock.calls[0]?.[3]).toBe(65537);
    expect(fs.closeSync.mock.calls.map(call => call[0])).toEqual([42, 41]);
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
    file.stat.mockReturnValueOnce(fileStat(size)).mockReturnValueOnce({ ...fileStat(size), ctimeMs: 2 });
    expect(() => readHostedReadonlyPolicy("fixture")).toThrow();
  });
});

it.each(["ancestor", "anchor", "read", "stat", "close"])("ENOENT during %s is not final target absence", stage => {
  const missing = () => { throw Object.assign(new Error("TEST missing ancestry/inode"), { code: "ENOENT" }); };
  if (stage === "ancestor") fs.lstatSync.mockImplementationOnce(missing);
  if (stage === "anchor") fs.statSync.mockImplementationOnce(missing);
  if (stage === "read") fs.readSync.mockImplementationOnce(missing);
  if (stage === "stat") fs.fstatSync.mockImplementationOnce(missing);
  if (stage === "close") fs.closeSync.mockImplementationOnce(missing);
  expect(() => readHostedReadonlyPolicy("fixture")).toThrow("hosted_readonly_policy_invalid");
  if (stage === "ancestor") expect(fs.openSync).not.toHaveBeenCalled();
});

describe("anchored private reader TEST filesystem interleavings", () => {
  let root: string;
  let real: typeof import("node:fs");
  beforeEach(async () => {
    real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { tmpdir } = await import("node:os");
    root = real.mkdtempSync(tmpdir() + "/TEST-private-reader-");
    real.mkdirSync(root + "/parent", { mode: 0o700 });
    // Simulate host ancestry and ownership; actual opens/reads/renames use only TEST files.
    fs.lstatSync.mockImplementation((path: string) => Object.assign(
      real.lstatSync(path.startsWith(root + "/") ? path : root), { uid: 0 }));
    fs.statSync.mockImplementation((path: string) => real.statSync(path));
    fs.openSync.mockImplementation((path: string, flags: number) => real.openSync(path, flags));
    fs.fstatSync.mockImplementation((fd: number) => Object.assign(real.fstatSync(fd), { uid: 0 }));
    fs.readSync.mockImplementation(real.readSync);
    fs.closeSync.mockImplementation(real.closeSync);
  });
  afterEach(() => { real.rmSync(root, { recursive: true, force: true }); });
  it.each(["present", "missing", "replacement"])("parent moved at final open rejects %s target with no FD leak", target => {
    if (target !== "missing") real.writeFileSync(root + "/parent/pending", "TEST-pending-bytes", { mode: 0o600 });
    let moved = false;
    fs.openSync.mockImplementation((path: string, flags: number) => {
      if (!(flags & constants.O_DIRECTORY)) {
        moved = true; real.renameSync(root + "/parent", root + "/retained");
        if (target === "replacement") real.mkdirSync(root + "/parent", { mode: 0o700 });
      }
      return real.openSync(path, flags);
    });
    expect(() => readHostedPrivateBytes(root + "/parent/pending", 64)).toThrow("hosted_readonly_policy_invalid");
    expect(moved).toBe(true);
    if (target !== "missing") expect(real.readFileSync(root + "/retained/pending", "utf8")).toBe("TEST-pending-bytes");
    const opened = fs.openSync.mock.results.filter(result => result.type === "return").map(result => result.value);
    expect(opened.length).toBeGreaterThan(0);
    expect(fs.closeSync.mock.calls.map(call => call[0]).sort()).toEqual(opened.sort());
  });
  it("missing final component under unchanged ancestry returns null and closes parent", () => {
    expect(readHostedPrivateBytes(root + "/parent/empty", 64)).toBeNull();
    expect(fs.openSync.mock.calls[0]?.[1] & constants.O_DIRECTORY).toBeTruthy();
    expect(fs.openSync.mock.calls[1]?.[0]).toMatch(/^\/proc\/self\/fd\/[0-9]+\/empty$/);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fs.openSync.mock.results[0]!.value);
  });
  it("opened parent substitution is rejected before final component open", () => {
    real.mkdirSync(root + "/other", { mode: 0o700 });
    fs.openSync.mockImplementation((path: string, flags: number) => real.openSync(
      flags & constants.O_DIRECTORY ? root + "/other" : path, flags));
    expect(() => readHostedPrivateBytes(root + "/parent/empty", 64)).toThrow("hosted_readonly_policy_invalid");
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fs.openSync.mock.results[0]!.value);
  });
});

describe("fixed authority bases absence proof", () => {
  const child = "/subscription-runtime-host-policy";
  const missing = () => { throw Object.assign(new Error("TEST absent"), { code: "ENOENT" }); };
  beforeEach(() => {
    fs.openSync.mockImplementation(path => path === "/run/user/0" ? 41 : 43);
    fs.fstatSync.mockReturnValue(directoryStat());
    fs.lstatSync.mockImplementation((path: string) => path.endsWith(child) ? missing() : directoryStat());
  });
  it("requires both absent bases, permits public non-writable var/lib and closes both anchors", () => {
    fs.lstatSync.mockImplementation((path: string) => path.endsWith(child) ? missing() :
      { ...directoryStat(), mode: path === "/var/lib" ? 0o40755 : 0o40700 });
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(true);
    expect(fs.closeSync.mock.calls.map(call => call[0])).toEqual([43, 41]);
    expect(fs.readSync).not.toHaveBeenCalled();
  });
  it.each([41, 43])("presence including a dangling symlink at anchor fd %s retains strict admission", fd => {
    fs.lstatSync.mockImplementation((path: string) => path === `/proc/self/fd/${fd}${child}` ?
      { isDirectory: () => false } : path.endsWith(child) ? missing() : directoryStat());
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
  });
  it.each(["ENOENT", "EACCES", "ENOTDIR", "ELOOP"])("an unavailable anchor (%s) is not child absence", code => {
    fs.lstatSync.mockImplementation((path: string) => {
      if (path === "/var/lib") throw Object.assign(new Error("TEST anchor unavailable"), { code });
      return path.endsWith(child) ? missing() : directoryStat();
    });
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(41);
  });
  it.each(["EACCES", "ENOTDIR", "ELOOP"])("an uncertain child observation (%s) denies", code => {
    fs.lstatSync.mockImplementation((path: string) => {
      if (path.endsWith(child)) throw Object.assign(new Error("TEST uncertain child"), { code });
      return directoryStat();
    });
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
  });
  it.each([
    { uid: 1000 }, { mode: 0o40777 }, { isDirectory: () => false }, { mode: 0o40755 },
  ])("rejects an unsafe/private anchor %j", change => {
    fs.lstatSync.mockImplementation((path: string) => path === "/run/user/0" ?
      { ...directoryStat(), ...change } : directoryStat());
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it.each(["replacement", "disappearance", "proc-anchor", "appearing-base"])("rejects concurrent %s", race => {
    let childReads = 0;
    fs.lstatSync.mockImplementation((path: string) => {
      if (path.endsWith(child)) {
        childReads++;
        return race === "appearing-base" && childReads > 2 ? directoryStat() : missing();
      }
      if (childReads > 0 && path === "/run/user/0") {
        if (race === "disappearance") return missing();
        if (race === "replacement") return { ...directoryStat(), ino: 999 };
      }
      return directoryStat();
    });
    if (race === "proc-anchor") fs.statSync.mockReturnValue({ ...directoryStat(), ino: 999 });
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.closeSync).toHaveBeenCalledTimes(2);
  });
  it("attempts both closes and denies when one close fails", () => {
    fs.closeSync.mockImplementationOnce(() => { throw new Error("TEST close failed"); });
    expect(hostedReadonlyAuthorityBasesAbsent()).toBe(false);
    expect(fs.closeSync.mock.calls.map(call => call[0])).toEqual([43, 41]);
  });
});
