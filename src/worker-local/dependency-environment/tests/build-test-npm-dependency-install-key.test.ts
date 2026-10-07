import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DependencyInstallArchitecture as Arch, DependencyInstallKeyFailure as Failure, DependencyLibcFamily,
  DependencyNpmLockName, DependencyToolRootKind, type DependencyTestNpmToolchain,
} from "../../../worker-core/dependency-environment/domain/dependency-install-key";
import { buildTestNpmDependencyInstallKey as build, DependencyInstallKeyError } from "../build-test-npm-dependency-install-key";

const toolchain: DependencyTestNpmToolchain = {
  nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127", platform: "linux", arch: Arch.X64,
  npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js", npmSha256: "b".repeat(64), npmVersion: "10.9.3",
  npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
};
const pkg = { name: "synthetic-TEST", version: "1.0.0", dependencies: { sample: "1.0.0" } };
const lock = { name: "synthetic-TEST", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
  "": { name: "synthetic-TEST", version: "1.0.0", dependencies: { sample: "1.0.0" } },
  "node_modules/sample": { version: "1.0.0", resolved: "https://registry.npmjs.org/sample/-/sample-1.0.0.tgz", integrity: `sha512-${"A".repeat(86)}==` },
} };
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const input = () => ({ packageBytes: encode(pkg), lockBytes: encode(lock), lockName: DependencyNpmLockName.PackageLock,
  toolchain, maxInputBytes: 16384, maxCanonicalBytes: 16384 });

describe("restricted TEST npm installation key", () => {
  it("hashes canonical complete recipe facts deterministically and includes exact input bytes", () => {
    const before = build(input());
    expect(build(input())).toEqual(before);
    expect(before.installKey).toBe(createHash("sha256").update(before.canonicalBytes).digest("hex"));
    expect(build({ ...input(), packageBytes: Buffer.from(JSON.stringify(pkg, null, 2)) }).installKey).not.toBe(before.installKey);
    expect(build({ ...input(), lockName: DependencyNpmLockName.Shrinkwrap }).installKey).not.toBe(before.installKey);
    const canonical = JSON.parse(Buffer.from(before.canonicalBytes).toString());
    // Old launcher qualification cannot collide with a Ready from numeric-drop v2.
    expect(canonical.profile).toBe("test_npm_qualification_v2");
    expect(createHash("sha256").update(JSON.stringify({ ...canonical, profile: "test_npm_qualification_v1" }) + "\n").digest("hex"))
      .not.toBe(before.installKey);
    expect(canonical.argv).toContain("--ignore-scripts");
    expect(canonical.environment.npm_config_userconfig).toBe("/runtime/npmrc");
    expect(canonical.environment.npm_config_globalconfig).not.toBe(canonical.environment.npm_config_userconfig);
    expect(createHash("sha256").update(JSON.stringify({ ...canonical, environment: { ...canonical.environment,
      npm_config_globalconfig: canonical.environment.npm_config_userconfig } }) + "\n").digest("hex")).not.toBe(before.installKey);
    expect(canonical.effectiveConfig).toMatchObject({ registry: "https://registry.npmjs.org/", workspaces: false, installLinks: true });
  });

  it.each([
    { nodeVersion: "v22.19.0" }, { nodeAbi: "128" }, { npmVersion: "10.9.4" },
    { npmSha256: "e".repeat(64) }, { npmRootSha256: "e".repeat(64) }, { nodeSha256: "e".repeat(64) },
    { nodePath: "/opt/other/bin/node" },
  ])("changes the key for an actual runtime/tool pin change %j", (change) => {
    expect(build({ ...input(), toolchain: { ...toolchain, ...change } }).installKey).not.toBe(build(input()).installKey);
  });

  it("changes on pinned library content and disregards supplied object property order", () => {
    const lib = { ...toolchain.libc, sha256: "e".repeat(64) };
    expect(build({ ...input(), toolchain: { ...toolchain, libc: lib,
      toolRoots: [{ path: lib.path, sha256: lib.sha256, kind: DependencyToolRootKind.File }] } }).installKey).not.toBe(build(input()).installKey);
    const reversed = Object.fromEntries(Object.entries(toolchain).reverse()) as DependencyTestNpmToolchain;
    expect(build({ ...input(), toolchain: reversed })).toEqual(build(input()));
    const roots: DependencyTestNpmToolchain["toolRoots"] = [
      ...toolchain.toolRoots, { path: "/usr/lib/libm.so.6", sha256: "f".repeat(64), kind: DependencyToolRootKind.File },
    ];
    expect(build({ ...input(), toolchain: { ...toolchain, toolRoots: roots } }))
      .toEqual(build({ ...input(), toolchain: { ...toolchain, toolRoots: [...roots].reverse() } }));
  });

  it.each([
    { scripts: { prepare: "reads undeclared source" } }, { workspaces: ["packages/*"] },
    { overrides: { sample: "2.0.0" } }, { packageManager: "npm@10.9.3" },
    { dependencies: { sample: "file:../private" } }, { config: { token: "TEST-credential-sentinel" } },
    { repository: { type: "git", url: "https://TEST-credential-sentinel@private.example/repo.git" } },
  ])("rejects unsupported closure %j without emitting supplied contents", (unsupported) => {
    try { build({ ...input(), packageBytes: encode({ ...pkg, ...unsupported }) }); throw new Error("TEST expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(DependencyInstallKeyError);
      expect(error).toMatchObject({ reason: Failure.UnsupportedClosure });
      expect(String(error)).not.toContain("TEST-credential-sentinel");
    }
  });

  it.each([
    { resolved: "https://TEST-secret@registry.npmjs.org/sample/-/sample.tgz" },
    { resolved: "https://registry.npmjs.org/sample/-/sample.tgz?token=TEST-secret" },
    { resolved: "https://external.example/sample.tgz" }, { hasInstallScript: true }, { link: true },
  ])("refuses auth/external/script/local lock inputs %j", (unsupported) => {
    const packages = { ...lock.packages, "node_modules/sample": { ...lock.packages["node_modules/sample"], ...unsupported } };
    expect(() => build({ ...input(), lockBytes: encode({ ...lock, packages }) })).toThrow(DependencyInstallKeyError);
  });

  it.each(["escaped signature", "nested credential assignment"])("rejects decoded %s before returning a key", (scenario) => {
    const token = scenario === "escaped signature" ? `sk-${"A".repeat(24)}` : "opaque-credential-value";
    const candidate = scenario === "escaped signature" ? { ...pkg, description: token } : { ...pkg, author: { secret: token } };
    const packageBytes = Buffer.from(scenario === "escaped signature"
      ? JSON.stringify(candidate).replace(token, `sk-${"\\u0041".repeat(24)}`) : JSON.stringify(candidate));
    let returnedKey: ReturnType<typeof build> | undefined;
    let failure: unknown;
    try { returnedKey = build({ ...input(), packageBytes }); } catch (error) { failure = error; }
    expect(returnedKey).toBeUndefined();
    expect(failure).toBeInstanceOf(DependencyInstallKeyError);
    expect(failure).toMatchObject({ reason: Failure.UnsupportedClosure });
    expect(String(failure)).toBe("Error: dependency_install_key:unsupported_closure");
    expect(String(failure)).not.toContain(token);
  });

  it("treats dependency names as names while rejecting disguised metadata credentials", () => {
    const packages = { "": { ...lock.packages[""], dependencies: { token: "1.0.0" } },
      "node_modules/token": { ...lock.packages["node_modules/sample"], resolved: "https://registry.npmjs.org/token/-/token-1.0.0.tgz" } };
    expect(() => build({ ...input(), packageBytes: encode({ ...pkg, dependencies: { token: "1.0.0" } }),
      lockBytes: encode({ ...lock, packages }) })).not.toThrow();
    expect(() => build({ ...input(), packageBytes: encode({ ...pkg, author: { dependencies: { secret: "opaque-credential-value" } } }) }))
      .toThrow(DependencyInstallKeyError);
  });

  it("refuses arbitrary hidden config/environment claims and explicit input bounds", () => {
    expect(() => build({ ...input(), toolchain: { ...toolchain, arch: Arch.Arm64 } })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input(), toolchain: { ...toolchain, env: { NPM_TOKEN: "TEST-secret" } } as DependencyTestNpmToolchain }))
      .toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input(), maxInputBytes: 1 })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input(), maxCanonicalBytes: 1 })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input(), config: { authToken: "TEST-secret" } } as ReturnType<typeof input>))
      .toThrow(DependencyInstallKeyError);
  });
});
