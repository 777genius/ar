import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DependencyInstallArchitecture, DependencyInstallKeyError, DependencyLibcFamily, DependencyNpmLockName,
  DependencyToolRootKind, type DependencyTestNpmToolchain,
} from "../../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLocalClosureKind, DependencyLocalInstallLayout } from "../../../worker-core/dependency-environment/domain/dependency-local-closure";
import { buildTestNpmLocalDependencyInstallKey as build } from "../build-test-npm-dependency-install-key";
import { captureNpmLocalClosure, revalidateNpmLocalClosure, type QualifiedNpmLocalInputs } from "../capture-npm-local-closure";
import { NpmInputCaptureStatus as Status, NpmInputCaptureReason as Reason } from "../capture-npm-install-inputs";

// Synthetic tool facts exercise only the pure key contract. They are never
// supplied to a launcher, profile issuer or Ready receipt in this suite.
const toolchain: DependencyTestNpmToolchain = {
  nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.23.3", nodeAbi: "127", platform: "linux",
  arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js", npmSha256: "b".repeat(64), npmVersion: "10.9.9",
  npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.39", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
};
const rootPackage = { name: "test-local-root", version: "1.0.0", private: true, workspaces: ["packages/a"], dependencies: { a: "*" } };
const workspacePackage = { name: "a", version: "1.0.0", scripts: { build: "node arbitrary-linked-code.js" }, dependencies: { b: "file:../b" } };
const packedPackage = { name: "b", version: "1.0.0", files: ["dist"], main: "dist/index.js" };
const lock = { name: rootPackage.name, version: rootPackage.version, lockfileVersion: 3, requires: true, packages: {
  "": { name: rootPackage.name, version: rootPackage.version, workspaces: rootPackage.workspaces, dependencies: rootPackage.dependencies },
  "packages/a": { name: "a", version: "1.0.0", dependencies: workspacePackage.dependencies },
  "node_modules/a": { resolved: "packages/a", link: true },
  "node_modules/b": { version: "1.0.0", resolved: "file:packages/b" },
} };
const encode = (value: unknown): string => JSON.stringify(value) + "\n";
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sr-TEST-local-closure-")); roots.push(root);
  await mkdir(join(root, "packages/a"), { recursive: true });
  await mkdir(join(root, "packages/b/dist"), { recursive: true });
  await writeFile(join(root, "package.json"), encode(rootPackage), { mode: 0o644 });
  await writeFile(join(root, "package-lock.json"), encode(lock), { mode: 0o644 });
  await writeFile(join(root, "packages/a/package.json"), encode(workspacePackage), { mode: 0o644 });
  await writeFile(join(root, "packages/a/arbitrary-linked-code.js"), "module.exports = 'original linked code';\n", { mode: 0o644 });
  await writeFile(join(root, "packages/b/package.json"), encode(packedPackage), { mode: 0o644 });
  await writeFile(join(root, "packages/b/dist/index.js"), "module.exports = 'needed ignored output';\n", { mode: 0o644 });
  await writeFile(join(root, ".gitignore"), "packages/b/dist/\n", { mode: 0o644 });
  await writeFile(join(root, "source-sentinel"), "TEST authored source must survive\n", { mode: 0o644 });
  return root;
}
const request = (workspacePath: string) => ({ workspacePath, maxInputBytes: 1024 * 1024, maxEntries: 2048, maxPackages: 16, maxDurationMs: 10000 });
async function qualified(root: string): Promise<QualifiedNpmLocalInputs> {
  const capture = await captureNpmLocalClosure(request(root));
  expect(capture.status).toBe(Status.Qualified);
  if (capture.status !== Status.Qualified) throw new Error("TEST local capture refused");
  return capture;
}
const key = (capture: QualifiedNpmLocalInputs) => build({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
  lockName: capture.lockName, closure: capture.closure, toolchain, maxInputBytes: 1024 * 1024, maxCanonicalBytes: 1024 * 1024 });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("fresh TEST local npm input closure", () => {
  it("resolves a below-root declaring workspace edge and distinguishes linked code from consumed packed inputs", async () => {
    const root = await fixture(), capture = await qualified(root), before = key(capture);
    expect(capture.closure.layout).toBe(DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs);
    expect(capture.closure.edges).toContainEqual({ declaringPath: "packages/a", field: "dependencies", name: "b", spec: "file:../b",
      resolutionBase: "source_directory", targetPath: "packages/b", kind: DependencyLocalClosureKind.PackedDirectory, installedPaths: ["node_modules/b"] });
    expect(capture.closure.packages.find((local) => local.path === "packages/a")?.files).toEqual([]);
    expect(capture.closure.packages.find((local) => local.path === "packages/b")?.files.map((file) => file.path)).toContain("dist/index.js");
    await writeFile(join(root, "packages/a/arbitrary-linked-code.js"), "module.exports = 'edited linked code';\n");
    expect(revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 })).toEqual({ status: Status.Qualified });
    expect(key(await qualified(root)).installKey).toBe(before.installKey);
    await writeFile(join(root, "packages/a/package.json"), encode({ ...workspacePackage, description: "changed local manifest" }));
    expect(revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect(key(await qualified(root)).installKey).not.toBe(before.installKey);
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("keys bytes, membership and executable mode of needed ignored packed output but excludes unrelated source", async () => {
    const root = await fixture(), before = key(await qualified(root));
    await writeFile(join(root, "packages/b/unrelated-authored-source.js"), "module.exports = 'outside files selector';\n");
    expect(key(await qualified(root)).installKey).toBe(before.installKey);
    const captured = await qualified(root);
    await writeFile(join(root, "packages/b/dist/index.js"), "module.exports = 'changed consumed ignored output';\n");
    expect(revalidateNpmLocalClosure({ capture: captured, maxDurationMs: 10000 })).toMatchObject({ status: Status.Unknown, reason: Reason.Unstable });
    const bytesChanged = key(await qualified(root)); expect(bytesChanged.installKey).not.toBe(before.installKey);
    await chmod(join(root, "packages/b/dist/index.js"), 0o755);
    const modeChanged = key(await qualified(root)); expect(modeChanged.installKey).not.toBe(bytesChanged.installKey);
    const beforeMembership = await qualified(root);
    await writeFile(join(root, "packages/b/dist/new-needed.js"), "module.exports = 2;\n", { mode: 0o644 });
    expect(revalidateNpmLocalClosure({ capture: beforeMembership, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect(key(await qualified(root)).installKey).not.toBe(modeChanged.installKey);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("packages/b/dist/\n");
  });

  it("captures every original mandatory family independently of files selectors and notices a newly added licence", async () => {
    const root = await fixture();
    for (const name of ["README", "ReadMe.md", "COPYING.LESSER", "license.txt"]) await writeFile(join(root, "packages/b", name), `TEST ${name}\n`, { mode: 0o644 });
    await writeFile(join(root, "packages/b/README.md~"), "TEST unconsumed backup\n", { mode: 0o644 });
    const capture = await qualified(root), paths = capture.closure.packages.find((local) => local.path === "packages/b")!.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(["README", "ReadMe.md", "COPYING.LESSER", "license.txt", "dist/index.js"]));
    expect(paths).not.toContain("README.md~"); const before = key(capture);
    await writeFile(join(root, "packages/b/LICENCE.MD"), "TEST newly mandatory original licence\n", { mode: 0o644 });
    expect(revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect(key(await qualified(root)).installKey).not.toBe(before.installKey);
    expect(await readFile(join(root, "packages/b/README.md~"), "utf8")).toBe("TEST unconsumed backup\n");
  });

  it.each([".npmignore", "npm-shrinkwrap.json", "package-lock.json", ".npmrc"])("refuses original packed %s before hiding it in a sanitized stage", async (name) => {
    const root = await fixture(); await writeFile(join(root, "packages/b", name), "TEST unsupported config sentinel\n", { mode: 0o644 });
    const capture = await captureNpmLocalClosure(request(root)); expect(capture.status).toBe(Status.Unsupported);
    expect(await readFile(join(root, "packages/b", name), "utf8")).toBe("TEST unsupported config sentinel\n");
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it.each([
    { scripts: { prepare: "would change original sentinel" } }, { bin: "arbitrary-linked-code.js" }, { workspaces: ["nested"] },
  ])("refuses consumed workspace lifecycle/bin/nested topology %j", async (change) => {
    const root = await fixture(); await writeFile(join(root, "packages/a/package.json"), encode({ ...workspacePackage, ...change }));
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("refuses packed-declarer local edges and workspace-local installed paths before any effects", async () => {
    const root = await fixture();
    await writeFile(join(root, "packages/b/package.json"), encode({ ...packedPackage, dependencies: { c: "file:../c" } }));
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    await writeFile(join(root, "packages/b/package.json"), encode(packedPackage));
    await writeFile(join(root, "package-lock.json"), encode({ ...lock, packages: { ...lock.packages,
      "packages/a/node_modules/sample": { version: "1.0.0", resolved: "https://registry.npmjs.org/sample/-/sample-1.0.0.tgz", integrity: `sha512-${"A".repeat(86)}==` } } }));
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("keeps packed development metadata in the key without requiring noninstalled development edges", async () => {
    const root = await fixture(), before = key(await qualified(root));
    await writeFile(join(root, "packages/b/package.json"), encode({ ...packedPackage, devDependencies: { "uninstalled-build-tool": "1.0.0" } }));
    const capture = await qualified(root);
    expect(capture.closure.edges.some((edge) => edge.name === "uninstalled-build-tool")).toBe(false);
    expect(key(capture).installKey).not.toBe(before.installKey);
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(encode(lock));
  });

  it.each(["opaque", "escaped signature", "escaped credential key", "signature filename", "disguised JSON extension", "duplicate escaped value"])("refuses copied %s before returning closure/key and preserves original bytes", async (scenario) => {
    const root = await fixture(), signature = `sk-${"A".repeat(24)}`;
    const name = scenario === "signature filename" ? `README.${signature}` : scenario === "disguised JSON extension" ? "dist/data.dat" : "dist/data.json";
    const bytes = scenario === "opaque" ? Buffer.from([0xff, 0x00, 0x41]) : Buffer.from(["escaped signature", "disguised JSON extension"].includes(scenario)
      ? `{ "value": "sk-${"\\u0041".repeat(24)}" }` : scenario === "duplicate escaped value"
        ? `{ "value": "sk-${"\\u0041".repeat(24)}", "value": "safe final value" }` : scenario === "escaped credential key"
        ? '{ "\\u0073ecret": "opaque-credential-value" }' : "TEST unconsumed credential name sentinel\n");
    const path = join(root, "packages/b", name); await writeFile(path, bytes, { mode: 0o644 });
    const capture = await captureNpmLocalClosure(request(root));
    expect(capture.status).toBe(Status.Unsupported); expect(JSON.stringify(capture)).not.toContain(signature);
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("refuses hidden duplicate manifest data before copying the original manifest", async () => {
    const root = await fixture();
    const bytes = Buffer.from('{"name":"b","version":"1.0.0","files":["dist"],"author":{"\\u0073ecret":"opaque-credential-value"},"author":{}}');
    const path = join(root, "packages/b/package.json"); await writeFile(path, bytes);
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    expect(await readFile(path)).toEqual(bytes);
  });

  it("bounds metadata structure before materializing parser frames and preserves malformed/deep input", async () => {
    const root = await fixture(), path = join(root, "packages/b/package.json");
    let author: unknown = {}; for (let i = 0; i < 256; i++) author = { metadata: author };
    const deep = encode({ ...packedPackage, author }); await writeFile(path, deep);
    // Without the structural depth guard this valid, small metadata was accepted.
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    expect(await readFile(path, "utf8")).toBe(deep);
    for (const bytes of ["{".repeat(65537), encode({ ...packedPackage, keywords: Array(65537).fill(0) })]) {
      await writeFile(path, bytes);
      expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
  });

  it("vetoes source target replacement even when manifest and copied bytes are identical", async () => {
    const root = await fixture(), capture = await qualified(root);
    await rename(join(root, "packages/b"), join(root, "original-b-held"));
    await mkdir(join(root, "packages/b/dist"), { recursive: true });
    await writeFile(join(root, "packages/b/package.json"), encode(packedPackage), { mode: 0o644 });
    await writeFile(join(root, "packages/b/dist/index.js"), "module.exports = 'needed ignored output';\n", { mode: 0o644 });
    expect(revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect(await readFile(join(root, "original-b-held/dist/index.js"), "utf8")).toBe("module.exports = 'needed ignored output';\n");
  });

  it("never follows a source ancestor symlink or reads a foreign hardlinked packed input", async () => {
    const root = await fixture(), foreign = await mkdtemp(join(tmpdir(), "sr-TEST-foreign-local-")); roots.push(foreign);
    await writeFile(join(foreign, "sentinel"), "TEST foreign bytes must survive\n", { mode: 0o644 });
    await rename(join(root, "packages"), join(root, "held-packages")); await symlink(foreign, join(root, "packages"));
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unknown);
    await rm(join(root, "packages")); await rename(join(root, "held-packages"), join(root, "packages"));
    await rm(join(root, "packages/b/dist/index.js")); await link(join(foreign, "sentinel"), join(root, "packages/b/dist/index.js"));
    expect(await captureNpmLocalClosure(request(root))).toMatchObject({ status: Status.Unknown, reason: Reason.UnsafeInput });
    expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("TEST foreign bytes must survive\n");
  });

  it("preserves valid UTF-8 names and refuses invalid raw names on capture and revalidation without replacing their bytes", async () => {
    const root = await fixture(), directory = join(root, "packages/b/dist");
    const valid = join(directory, "caf\u00e9.js");
    await writeFile(valid, "TEST valid UTF-8 name\n", { mode: 0o644 });
    const capture = await qualified(root);
    expect(capture.closure.packages.find(local => local.path === "packages/b")?.files)
      .toContainEqual({ path: "dist/caf\u00e9.js", mode: 0o644, bytes: Buffer.from("TEST valid UTF-8 name\n") });
    const invalid = Buffer.concat([Buffer.from(directory + "/"), Buffer.from([0xff]), Buffer.from(".js")]);
    await writeFile(invalid, "TEST invalid raw filename must survive\n", { mode: 0o644 });
    const before = await lstat(invalid, { bigint: true });
    const names = async () => (await readdir(directory, { encoding: "buffer" })).map(name => name.toString("hex")).sort();
    const beforeNames = await names();
    expect(revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unknown);
    const after = await lstat(invalid, { bigint: true });
    expect([after.dev, after.ino, after.mode, after.size]).toEqual([before.dev, before.ino, before.mode, before.size]);
    expect(await names()).toEqual(beforeNames);
    expect(await readFile(invalid, "utf8")).toBe("TEST invalid raw filename must survive\n");
    expect(await readFile(valid, "utf8")).toBe("TEST valid UTF-8 name\n");
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("refuses default-excluded selectors, nested ignore and aggregate byte overflow without altering source", async () => {
    const root = await fixture(); await writeFile(join(root, "packages/b/package.json"), encode({ ...packedPackage, files: ["package-lock.json"] }));
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    await writeFile(join(root, "packages/b/package.json"), encode(packedPackage));
    await writeFile(join(root, "packages/b/dist/.gitignore"), "TEST nested rule\n", { mode: 0o644 });
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    await rm(join(root, "packages/b/dist/.gitignore"));
    expect(await captureNpmLocalClosure({ ...request(root), maxInputBytes: 64 })).toMatchObject({ status: Status.Unknown, reason: Reason.Bounds });
    expect(await readFile(join(root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
  });

  it("keeps lock precedence, profile/toolchain identity and logical edge validation closed", async () => {
    const root = await fixture(), first = await qualified(root);
    await writeFile(join(root, "npm-shrinkwrap.json"), encode(lock), { mode: 0o644 });
    const capture = await qualified(root); expect(capture.lockName).toBe(DependencyNpmLockName.Shrinkwrap);
    expect(key(capture).installKey).not.toBe(key(first).installKey);
    expect(revalidateNpmLocalClosure({ capture: first, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    const input = { packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, lockName: capture.lockName,
      closure: capture.closure, toolchain, maxInputBytes: 1024 * 1024, maxCanonicalBytes: 1024 * 1024 };
    expect(() => build({ ...input, toolchain: { ...toolchain, npmVersion: "10.9.8" } })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input, closure: { ...capture.closure, edges: [] } })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...input, maxCanonicalBytes: 32 })).toThrow(DependencyInstallKeyError);
    const canonical = JSON.parse(Buffer.from(key(capture).canonicalBytes).toString());
    expect(canonical.version).toBe(2); expect(canonical.argv).toContain("--workspaces=true");
    expect(canonical.environment.npm_config_userconfig).not.toBe(canonical.environment.npm_config_globalconfig);
  });
});
