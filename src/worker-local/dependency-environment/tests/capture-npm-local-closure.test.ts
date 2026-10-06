import { hostedDependencyLocalSelectionVerificationArgv, type HostedDependencyLocalStage } from "../../../worker-codex/hosted-dependency-installer-local-stage";
import { openCapturedDependencySourceLinks, closeDependencySourceLinkSession, type DependencySourceLinkSession } from "../dependency-source-binding";
import { observeDependencyTreeWithLocalRegistrySelection, assertDependencyLocalRegistrySelectionAbsent,
  captureDependencyPhysicalTreeExposure, captureDependencyLocalRootOnlySourceExposure, closeDependencySourceExposure,
  type DependencySourceExposure } from "../observe-dependency-tree";
import { DependencyTreeObservationStatus as Observed } from "../../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DependencyInstallArchitecture, DependencyInstallKeyError, DependencyLibcFamily, DependencyNpmLockName,
  DependencyToolRootKind, type DependencyTestNpmToolchain,
} from "../../../worker-core/dependency-environment/domain/dependency-install-key";
import { DependencyLocalClosureKind, DependencyLocalInstallLayout, qualifyDependencyNpmLocalClosure, type DependencyLocalPackage } from "../../../worker-core/dependency-environment/domain/dependency-local-closure";
import { buildTestNpmLocalDependencyInstallKey as build, encodeDependencyLocalInputCommitment } from "../build-test-npm-dependency-install-key";
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

// These intentionally small logical fixtures isolate npm's two metadata causes.
// They are not generated tool closure or protected profile/installation evidence.
const fseventsMetadata = {
  version: "2.3.3", resolved: "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
  integrity: "sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==",
  dev: true, hasInstallScript: true, license: "MIT", optional: true, os: ["darwin"],
  engines: { node: "^8.16.0 || ^10.6.0 || >=11.0.0" },
};
const registryMetadata = (name: string) => ({ version: "1.0.0", resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
  integrity: `sha512-${"A".repeat(86)}==` });
function logicalSelectionInput(recordChange: Record<string, unknown> = {}, rootChange: Record<string, unknown> = {}) {
  const root = { name: "selection-test", version: "1.0.0", workspaces: ["packages/local"], dependencies: { local: "*", tool: "1.0.0" }, ...rootChange };
  const local = { name: "local", version: "1.0.0" };
  const packages: DependencyLocalPackage[] = [{ path: "packages/local", kind: DependencyLocalClosureKind.PureWorkspaceLink,
    packageBytes: Buffer.from(encode(local)), directories: [], files: [] }];
  const records: Record<string, unknown> = { "": root, "packages/local": local, "node_modules/local": { resolved: "packages/local", link: true },
    "node_modules/tool": { ...registryMetadata("tool"), optionalDependencies: { fsevents: "~2.3.3" },
      peerDependencies: { esbuild: "^0.27.0 || ^0.28.0" }, peerDependenciesMeta: { esbuild: { optional: true } }, ...recordChange },
    "node_modules/fsevents": fseventsMetadata };
  return { packageBytes: Buffer.from(encode(root)), lockBytes: Buffer.from(encode({ name: root.name, version: root.version,
    lockfileVersion: 3, packages: records })), packages, selectionToolchain: toolchain };
}
function changedRecords(input: ReturnType<typeof logicalSelectionInput>, change: (records: Record<string, unknown>) => void) {
  const parsed = JSON.parse(input.lockBytes.toString()) as { packages: Record<string, unknown> }; change(parsed.packages);
  return { ...input, lockBytes: Buffer.from(encode(parsed)) };
}

describe("closed logical local registry selection", () => {
  // Red if either cause is ignored wholesale, or the caller selects absence paths.
  it("requires context for both independent metadata causes and derives their exact coordinates", () => {
    const input = logicalSelectionInput();
    const { selectionToolchain: _inputContext, ...withoutContext } = input;
    expect(() => qualifyDependencyNpmLocalClosure(withoutContext)).toThrow(DependencyInstallKeyError);
    const peerOnly = changedRecords(input, records => { records["node_modules/fsevents"] = { ...fseventsMetadata, hasInstallScript: false }; });
    const { selectionToolchain: _peerContext, ...withoutPeerContext } = peerOnly;
    expect(() => qualifyDependencyNpmLocalClosure(withoutPeerContext)).toThrow(DependencyInstallKeyError);
    const closure = qualifyDependencyNpmLocalClosure(input);
    expect(closure.version).toBe(2); if (closure.version !== 2) throw new Error("TEST selection missing");
    expect(closure.registrySelection.excludedScriptPackages).toEqual(["node_modules/fsevents"]);
    expect(closure.registrySelection.absentOptionalPeers).toEqual([{ declaringPath: "node_modules/tool", name: "esbuild", spec: "^0.27.0 || ^0.28.0",
      resolutionSearchPaths: ["node_modules/tool/node_modules/esbuild", "node_modules/node_modules/esbuild", "node_modules/esbuild"] }]);
    expect(closure.layout).toBe(DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs);
  });

  // Red if optional script metadata alone, a compatible OS, or a required incoming edge gains an exemption.
  it.each([
    { optional: false }, { optional: "true" }, { os: ["linux"] }, { os: ["!linux"] }, { os: [] }, { os: ["any"] },
    { os: "darwin" }, { hasInstallScript: "true" }, { dependencies: { required: "1.0.0" } },
  ])("refuses an unsupported excluded leaf %j", change => {
    expect(() => qualifyDependencyNpmLocalClosure(changedRecords(logicalSelectionInput(), records => {
      records["node_modules/fsevents"] = { ...fseventsMetadata, ...change };
    }))).toThrow(DependencyInstallKeyError);
  });
  it("refuses a required or development path into the excluded coordinate", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const input = logicalSelectionInput({}, { [field]: { local: "*", tool: "1.0.0", fsevents: "2.3.3" } });
      expect(() => qualifyDependencyNpmLocalClosure(input)).toThrow(DependencyInstallKeyError);
    }
  });

  // Red if missing non-peer inputs or false/forged metadata are caught as optional absence.
  it.each([undefined, { esbuild: { optional: false } }, { esbuild: { optional: "true" } },
    { esbuild: { optional: true, unknown: true } }, { stranger: { optional: true } }])("refuses missing peer without exact true metadata %j", meta => {
    expect(() => qualifyDependencyNpmLocalClosure(logicalSelectionInput({ peerDependenciesMeta: meta }))).toThrow(DependencyInstallKeyError);
  });
  it("preserves mandatory, optional dependency and root peer refusals", () => {
    for (const change of [{ dependencies: { missing: "1.0.0" } }, { optionalDependencies: { missing: "1.0.0" } }])
      expect(() => qualifyDependencyNpmLocalClosure(logicalSelectionInput(change))).toThrow(DependencyInstallKeyError);
    expect(() => qualifyDependencyNpmLocalClosure(logicalSelectionInput({}, { peerDependencies: { missing: "1.0.0" },
      peerDependenciesMeta: { missing: { optional: true } } }))).toThrow(DependencyInstallKeyError);
  });
  it("treats present optional:false peers ordinarily and never skips a selected script-bearing peer", () => {
    const present = changedRecords(logicalSelectionInput({ peerDependenciesMeta: { esbuild: { optional: false } } }), records => {
      records["node_modules/esbuild"] = { ...registryMetadata("esbuild"), version: "0.27.4", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.27.4.tgz" };
    });
    const closure = qualifyDependencyNpmLocalClosure(present);
    expect(closure.version).toBe(2); if (closure.version !== 2) throw new Error("TEST excluded leaf missing");
    expect(closure.registrySelection.absentOptionalPeers).toEqual([]);
    expect(() => qualifyDependencyNpmLocalClosure(changedRecords(present, records => {
      records["node_modules/esbuild"] = { ...registryMetadata("esbuild"), hasInstallScript: true };
    }))).toThrow(DependencyInstallKeyError);
  });

  // Red if partial/malformed/overflow range bytes acquire the new missing-peer exemption.
  it.each(["1.2", "1.x.3", "01.2.3", "1.2.3 ||", "|| 1.2.3", "1.2.3 | 2.0.0", "^", ">= 1.2.3", "1.0.0 - 2.0.0",
    "1.2.3-beta", "1.2.3+1", "* || ^1.0.0", "9007199254740991.0.0", "90071992547409901.0.0"])("denies absent optional peer syntax %s", spec => {
    expect(() => qualifyDependencyNpmLocalClosure(logicalSelectionInput({ peerDependencies: { esbuild: spec } }))).toThrow(DependencyInstallKeyError);
  });
  it.each(["*", " >=1.21.0 <2.0.0 ", "^20.19.0 || >=22.12.0", "=0.0.0", "~9007199254740990.0.0"])("preserves supported absent range bytes %s", spec => {
    const closure = qualifyDependencyNpmLocalClosure(logicalSelectionInput({ peerDependencies: { esbuild: spec } }));
    expect(closure.version).toBe(2); if (closure.version !== 2) throw new Error("TEST missing selection");
    expect(closure.registrySelection.absentOptionalPeers[0]?.spec).toBe(spec);
  });
  it("retains donor V1 metadata and present-range behavior when no new missing exemption is needed", () => {
    const input = changedRecords(logicalSelectionInput({ peerDependencies: { esbuild: "1.x.0" }, peerDependenciesMeta: { irrelevant: { future: true } } }), records => {
      records["node_modules/esbuild"] = registryMetadata("esbuild"); records["node_modules/fsevents"] = { ...fseventsMetadata, hasInstallScript: false };
    });
    const { selectionToolchain: _oldContext, ...originalInput } = input;
    const old = qualifyDependencyNpmLocalClosure(originalInput), current = qualifyDependencyNpmLocalClosure(input);
    expect(current.version).toBe(1); expect(current).toEqual(old);
    const keyed = { packageBytes: input.packageBytes, lockBytes: input.lockBytes, lockName: DependencyNpmLockName.PackageLock, toolchain,
      maxInputBytes: 1048576, maxCanonicalBytes: 1048576 };
    expect(build({ ...keyed, closure: current }).canonicalBytes).toEqual(build({ ...keyed, closure: old }).canonicalBytes);
  });

  // Red if the new logical key aliases old keys, loses metadata, or trusts a supplied selection list.
  it("binds every derived selection field and unchanged original bytes in new key and commitment domains", () => {
    const input = logicalSelectionInput(), closure = qualifyDependencyNpmLocalClosure(input);
    const buildInput = { packageBytes: input.packageBytes, lockBytes: input.lockBytes, closure,
      lockName: DependencyNpmLockName.PackageLock, toolchain, maxInputBytes: 1048576, maxCanonicalBytes: 1048576 };
    const result = build(buildInput), commitment = encodeDependencyLocalInputCommitment({ ...input, closure, lockName: buildInput.lockName });
    expect(JSON.parse(Buffer.from(result.canonicalBytes).toString()).version).toBe(3);
    const verificationArgv = ["ls", "--all", "--json", "--ignore-scripts", "--package-lock-only=false", "--install-strategy=hoisted", "--install-links=true",
      "--include=dev", "--include=optional", "--include=peer", "--strict-peer-deps=false", "--legacy-peer-deps=false", "--workspaces=true", "--include-workspace-root=true"];
    expect(JSON.parse(Buffer.from(result.canonicalBytes).toString()).verificationArgv).toEqual(verificationArgv);
    // The contained constants independently honor the same fixed wire contract.
    expect(hostedDependencyLocalSelectionVerificationArgv({ version: 1, commitment: commitment.commitment, entries: [] } as HostedDependencyLocalStage)).toEqual(verificationArgv);
    expect(commitment.commitment.version).toBe(2);
    expect(commitment.commitment.registrySelection).toEqual(closure.version === 2 ? closure.registrySelection : undefined);
    expect(() => build({ ...buildInput, closure: { ...closure, version: 1 } })).toThrow(DependencyInstallKeyError);
    if (closure.version !== 2) throw new Error("TEST selection missing");
    expect(() => build({ ...buildInput, closure: { ...closure, registrySelection: { ...closure.registrySelection, excludedScriptPackages: [] } } })).toThrow(DependencyInstallKeyError);
    expect(() => build({ ...buildInput, closure: { ...closure, registrySelection: { ...closure.registrySelection, unknown: undefined } as typeof closure.registrySelection } })).toThrow(DependencyInstallKeyError);
    const changed = { ...input, lockBytes: Buffer.concat([input.lockBytes, Buffer.from(" ")]) };
    expect(build({ ...buildInput, lockBytes: changed.lockBytes, closure: qualifyDependencyNpmLocalClosure(changed) }).installKey).not.toBe(result.installKey);
    for (const bad of [{ ...toolchain, npmVersion: "10.9.8" }, { ...toolchain, arch: DependencyInstallArchitecture.Arm64 },
      { ...toolchain, libc: { ...toolchain.libc, family: DependencyLibcFamily.Musl } }])
      expect(() => build({ ...buildInput, toolchain: bad })).toThrow(DependencyInstallKeyError);
  });
});

describe.skipIf(process.platform !== "linux")("actual original selection/source facts on disposable TEST inputs", () => {
  async function selectedFixture() {
    const root = await fixture(), logical = logicalSelectionInput();
    const registry = JSON.parse(logical.lockBytes.toString()).packages as Record<string, unknown>;
    const sourcePackage = { ...rootPackage, dependencies: { ...rootPackage.dependencies, tool: "1.0.0" } };
    const sourceLock = { ...lock, packages: { ...lock.packages, "": { ...lock.packages[""], dependencies: sourcePackage.dependencies },
      "node_modules/tool": registry["node_modules/tool"], "node_modules/fsevents": fseventsMetadata } };
    await writeFile(join(root, "package.json"), encode(sourcePackage)); await writeFile(join(root, "package-lock.json"), encode(sourceLock));
    const capture = await captureNpmLocalClosure({ ...request(root), selectionToolchain: toolchain });
    if (capture.status !== Status.Qualified) throw new Error("TEST isolated selection capture refused");
    await mkdir(join(root, "node_modules")); await symlink("../packages/a", join(root, "node_modules/a"));
    await mkdir(join(root, "node_modules/b")); await mkdir(join(root, "node_modules/tool"));
    const tree = await lstat(join(root, "node_modules"), { bigint: true });
    return { root, capture, tree: { dev: String(tree.dev), ino: String(tree.ino) } };
  }
  const observationLimits = { maxEntries: 2048, maxTotalBytes: 1048576, maxManifestBytes: 1048576, maxDurationMs: 30000 };

  // Red if a structural envelope/DTO or closed/foreign session can assert real absence.
  it("keeps same-walk canonical bytes with genuine private baseline and rejects forgery, close and later membership", async () => {
    const f = await selectedFixture(), session = openCapturedDependencySourceLinks(f.capture);
    let exposure: DependencySourceExposure | undefined;
    try {
      const observed = await observeDependencyTreeWithLocalRegistrySelection({ workspacePath: f.root, expectedWorkspace: f.capture.workspace,
        treeName: "node_modules", expectedTree: f.tree, sourceLinkSession: session, limits: observationLimits });
      expect(observed.status).toBe(Observed.Complete); if (observed.status !== Observed.Complete) throw new Error("TEST observer refused");
      exposure = observed.exposure;
      expect(() => assertDependencyLocalRegistrySelectionAbsent(exposure!, session, f.capture.workspace, f.tree)).not.toThrow();
      expect(() => assertDependencyLocalRegistrySelectionAbsent({} as DependencySourceExposure, session, f.capture.workspace, f.tree)).toThrow();
      expect(() => assertDependencyLocalRegistrySelectionAbsent(exposure!, {} as DependencySourceLinkSession, f.capture.workspace, f.tree)).toThrow();
      expect(() => assertDependencyLocalRegistrySelectionAbsent(exposure!, session, f.capture.workspace, { ...f.tree, ino: "1" })).toThrow();
      await mkdir(join(f.root, "node_modules/new-package"));
      expect(() => assertDependencyLocalRegistrySelectionAbsent(exposure!, session, f.capture.workspace, f.tree)).toThrow();
      expect(await readFile(join(f.root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
    } finally { if (exposure) closeDependencySourceExposure(exposure); closeDependencySourceLinkSession(session); }
    expect(() => assertDependencyLocalRegistrySelectionAbsent(exposure!, session, f.capture.workspace, f.tree)).toThrow();
  });

  // Red if raw membership only checks the root or treats a symlink/file as absent.
  it.each(["root", "nested", "symlink", "peer"])("denies actual %s output shadow using the original physical baseline", async kind => {
    const f = await selectedFixture();
    const destination = kind === "nested" ? "node_modules/tool/node_modules/fsevents" : kind === "peer" ? "node_modules/esbuild" : "node_modules/fsevents";
    await mkdir(join(f.root, destination.substring(0, destination.lastIndexOf("/"))), { recursive: true });
    if (kind === "symlink") await symlink("tool", join(f.root, destination)); else await writeFile(join(f.root, destination), "TEST forbidden output sentinel\n");
    const baseline = await captureDependencyPhysicalTreeExposure({ workspace: f.capture.workspace, expectedTree: f.tree, limits: observationLimits });
    expect(baseline.status).toBe(Observed.Complete); if (baseline.status !== Observed.Complete) throw new Error("TEST physical facts refused");
    const session = openCapturedDependencySourceLinks(f.capture);
    try {
      expect(() => assertDependencyLocalRegistrySelectionAbsent(baseline.exposure, session, f.capture.workspace, f.tree)).toThrow();
      if (kind !== "symlink") expect(await readFile(join(f.root, destination), "utf8")).toBe("TEST forbidden output sentinel\n");
    } finally { closeDependencySourceExposure(baseline.exposure); closeDependencySourceLinkSession(session); }
  });

  it("withholds a canonical envelope when the real walk contains an excluded leaf", async () => {
    const f = await selectedFixture(), session = openCapturedDependencySourceLinks(f.capture);
    await mkdir(join(f.root, "node_modules/fsevents"));
    try {
      const result = await observeDependencyTreeWithLocalRegistrySelection({ workspacePath: f.root, expectedWorkspace: f.capture.workspace,
        treeName: "node_modules", expectedTree: f.tree, sourceLinkSession: session, limits: observationLimits });
      expect(result.status).toBe(Observed.Incomplete);
      expect(result).not.toHaveProperty("exposure"); expect(result).not.toHaveProperty("canonicalBytes");
      expect(await readFile(join(f.root, "source-sentinel"), "utf8")).toBe("TEST authored source must survive\n");
    } finally { closeDependencySourceLinkSession(session); }
  });

  // Red if input capture traverses a shadow tree or revalidation accepts an endpoint inserted after the frame.
  it.each(["packages/a/node_modules", "packages/node_modules"])("refuses target/ancestor %s while preserving unknown bytes", async coordinate => {
    const root = await fixture(), captured = await qualified(root);
    expect(captured.absentPaths).toContain(coordinate);
    await mkdir(join(root, coordinate)); await writeFile(join(root, coordinate, "sentinel"), "TEST unknown shadow must survive\n");
    expect(revalidateNpmLocalClosure({ capture: captured, maxDurationMs: 10000 }).status).toBe(Status.Unknown);
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    expect(await readFile(join(root, coordinate, "sentinel"), "utf8")).toBe("TEST unknown shadow must survive\n");
  });
  it.each(["file", "symlink"])("denies %s target endpoints without following unknown source contents", async kind => {
    const root = await fixture(), foreign = await mkdtemp(join(tmpdir(), "sr-TEST-shadow-sentinel-")); roots.push(foreign);
    const sentinel = join(foreign, "sentinel"); await writeFile(sentinel, "TEST foreign shadow stays unchanged\n");
    const endpoint = join(root, "packages/a/node_modules");
    if (kind === "symlink") await symlink(foreign, endpoint); else await writeFile(endpoint, "TEST file shadow stays unchanged\n");
    const before = await lstat(endpoint, { bigint: true });
    expect((await captureNpmLocalClosure(request(root))).status).toBe(Status.Unsupported);
    const after = await lstat(endpoint, { bigint: true });
    expect([after.dev, after.ino, after.mode, after.size]).toEqual([before.dev, before.ino, before.mode, before.size]);
    expect(await readFile(sentinel, "utf8")).toBe("TEST foreign shadow stays unchanged\n");
  });
  it("refuses descendant node_modules before hashing unknown linked source and preserves the ordinary capture boundary", async () => {
    const root = await fixture(); await mkdir(join(root, "packages/a/nested/node_modules"), { recursive: true });
    const sentinel = join(root, "packages/a/nested/node_modules/unknown"); await writeFile(sentinel, Buffer.from([255, 0, 1]));
    const captured = await qualified(root), stat = await lstat(join(root, "packages/a"), { bigint: true });
    const result = await captureDependencyLocalRootOnlySourceExposure({ roots: [{ parentPath: join(root, "packages"), name: "a",
      expectedTree: { dev: String(stat.dev), ino: String(stat.ino) } }], limits: observationLimits });
    expect(result.status).toBe(Observed.Incomplete);
    expect(revalidateNpmLocalClosure({ capture: captured, maxDurationMs: 10000 }).status).toBe(Status.Qualified);
    expect(await readFile(sentinel)).toEqual(Buffer.from([255, 0, 1]));
  });

  // Red if either old digest bytes or version domains change for already supported inputs.
  it("preserves the independent frozen v1 commitment of the original supported fixture", async () => {
    const root = await fixture(), capture = await qualified(root);
    const encoded = encodeDependencyLocalInputCommitment({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
      lockName: capture.lockName, closure: capture.closure });
    expect(encoded.sha256).toBe("bbf088894ae97985a8a6b539e108297b56719f3a6b67fc69096661438ca4d508");
    expect(capture.closureDigest).toBe(encoded.sha256); expect(encoded.commitment.version).toBe(1);
    expect(capture.closure.version).toBe(1); expect(JSON.parse(Buffer.from(key(capture).canonicalBytes).toString()).version).toBe(2);
    expect(key(capture).installKey).toBe("54ee4d12a22e30fce9c90ae89266669071c3577e94b5865118ee2b9d76b363ec");
  });
});
