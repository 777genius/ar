import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyNpmLockName, DependencyToolRootKind, type DependencyTestNpmToolchain } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import { captureNpmLocalClosure } from "../../worker-local/dependency-environment/capture-npm-local-closure";
import { NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";
import { qualifyHostedDependencyLocalInstallerInputs } from "../hosted-dependency-installer-inputs";
import { observeHostedDependencyLocalStage, writeHostedDependencyLocalStage } from "../hosted-dependency-installer-local-stage";

// Synthetic tool facts exercise only the key/qualification contract. No launch,
// mounted namespace, real npm installation, profile coverage or Ready is claimed.
const tools: DependencyTestNpmToolchain = { nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.23.3", nodeAbi: "127",
  platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js", npmSha256: "b".repeat(64), npmVersion: "10.9.9",
  npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.39", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }] };
const json = (value: unknown) => JSON.stringify(value) + "\n";
const roots: string[] = [];
async function fixture(lockName = DependencyNpmLockName.PackageLock) {
  const parent = await mkdtemp(join(tmpdir(), "sr-TEST-local-installer-")); roots.push(parent);
  const root = join(parent, "original"), stagePath = join(parent, "stage"), uid = process.geteuid!();
  await mkdir(join(root, "packages/a"), { recursive: true }); await mkdir(join(root, "packages/b/dist/empty"), { recursive: true });
  await mkdir(join(root, "packages/b/bin")); await mkdir(join(root, ".git"));
  const pkg = { name: "test-local-stage", version: "1.0.0", private: true, workspaces: ["packages/a"], dependencies: { a: "*" } };
  const a = { name: "a", version: "1.0.0", dependencies: { b: "file:../b" } };
  const b = { name: "b", version: "1.0.0", files: ["dist", "bin"], main: "dist/index.js", bin: { b: "bin/cli.js" } };
  await writeFile(join(root, "package.json"), json(pkg));
  await writeFile(join(root, lockName), json({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    "": { name: pkg.name, version: pkg.version, workspaces: pkg.workspaces, dependencies: pkg.dependencies },
    "packages/a": a, "node_modules/a": { resolved: "packages/a", link: true },
    "node_modules/b": { version: "1.0.0", resolved: "file:packages/b", bin: b.bin },
  } }));
  await writeFile(join(root, "packages/a/package.json"), json(a));
  await writeFile(join(root, "packages/a/source.js"), "module.exports = 'linked code';\n");
  await writeFile(join(root, "packages/b/package.json"), json(b));
  await writeFile(join(root, "packages/b/dist/index.js"), "module.exports = 'needed ignored bytes';\n");
  await writeFile(join(root, "packages/b/dist/данные.txt"), "TEST UTF-8 inventory\n");
  await writeFile(join(root, "packages/b/bin/cli.js"), "#!/usr/bin/env node\nconsole.log('TEST bin');\n", { mode: 0o755 });
  await chmod(join(root, "packages/b/bin/cli.js"), 0o755);
  await writeFile(join(root, ".gitignore"), "packages/b/dist/\n");
  await writeFile(join(root, ".git/TEST-sentinel"), "TEST source recovery\n");
  await writeFile(join(root, "authored-sentinel"), "TEST authored bytes\n");
  const capture = await captureNpmLocalClosure({ workspacePath: root, maxInputBytes: 1024 * 1024, maxEntries: 2048, maxPackages: 16, maxDurationMs: 10000 });
  if (capture.status !== NpmInputCaptureStatus.Qualified) throw new Error("TEST local stage capture refused");
  const inputs = qualifyHostedDependencyLocalInstallerInputs(capture, tools);
  await mkdir(stagePath, { mode: 0o755 }); await chmod(stagePath, 0o755);
  await mkdir(join(stagePath, "node_modules"), { mode: 0o755 }); await chmod(join(stagePath, "node_modules"), 0o755);
  writeHostedDependencyLocalStage(stagePath, inputs.stage, inputs.files);
  const observe = () => observeHostedDependencyLocalStage(stagePath, inputs.stage, inputs.sha256, uid, uid);
  return { root, stagePath, capture, inputs, observe };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("finite actual TEST local installer stage", () => {
  // Red if stage copies a whole source tree, misses needed ignored input or loses
  // npm bin mode. This literal physical inventory is independent of DTO entries.
  it("copies only root/selected lock/manifests and needed packed bytes at original coordinates", async () => {
    const f = await fixture(DependencyNpmLockName.Shrinkwrap);
    const walk = async (root: string, prefix = ""): Promise<string[]> => {
      const found: string[] = []; for (const name of (await readdir(join(root, prefix))).sort()) {
        const path = prefix ? prefix + "/" + name : name, stat = await lstat(join(root, path)); found.push(path);
        if (stat.isDirectory()) found.push(...await walk(root, path));
      } return found;
    };
    expect(await walk(f.stagePath)).toEqual(["node_modules", "npm-shrinkwrap.json", "package.json", "packages", "packages/a", "packages/a/package.json",
      "packages/b", "packages/b/bin", "packages/b/bin/cli.js", "packages/b/dist", "packages/b/dist/empty", "packages/b/dist/index.js",
      "packages/b/dist/данные.txt", "packages/b/package.json"]);
    expect(await readFile(join(f.stagePath, "packages/b/dist/index.js"), "utf8")).toBe("module.exports = 'needed ignored bytes';\n");
    expect((await lstat(join(f.stagePath, "packages/b/bin/cli.js"))).mode & 0o7777).toBe(0o755);
    expect((await lstat(join(f.stagePath, "packages/a"))).mode & 0o7777).toBe(0o755);
    expect((await lstat(join(f.stagePath, "packages/b/dist/index.js"))).ino).not.toBe((await lstat(join(f.root, "packages/b/dist/index.js"))).ino);
    expect(f.observe()).toBeTruthy();
    expect(await readFile(join(f.root, ".git/TEST-sentinel"), "utf8")).toBe("TEST source recovery\n");
    expect(await readFile(join(f.root, "authored-sentinel"), "utf8")).toBe("TEST authored bytes\n");
  });
  // Red if a matching hex label can replace the independently captured digest,
  // or a tool-version label bypasses the closed exact npm qualification.
  it("rejects a substituted closure digest and unqualified npm before any new stage", async () => {
    const f = await fixture();
    expect(() => qualifyHostedDependencyLocalInstallerInputs({ ...f.capture, closureDigest: "0".repeat(64) }, tools)).toThrow("inputs_unsupported");
    expect(() => qualifyHostedDependencyLocalInstallerInputs(f.capture, { ...tools, npmVersion: "10.9.8" })).toThrow();
    expect(f.observe()).toBeTruthy();
  });
  // Red if caller-side captured-byte mutation changes accepted stage input, or
  // an edit to a consumed ignored file is missed by the genuine revalidation.
  it("distinguishes unconsumed linked code from changed captured packed bytes", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "packages/a/source.js"), "module.exports = 'edited linked code';\n");
    expect(qualifyHostedDependencyLocalInstallerInputs(f.capture, tools).installKey).toBe(f.inputs.installKey);
    f.capture.packageBytes.fill(0);
    expect(f.observe()).toBeTruthy(); // The stage/input bytes were detached.
    expect(() => qualifyHostedDependencyLocalInstallerInputs(f.capture, tools)).toThrow("inputs_unsupported");
    await writeFile(join(f.root, "packages/b/dist/index.js"), "module.exports = 'changed packed bytes';\n");
    expect(() => qualifyHostedDependencyLocalInstallerInputs(f.inputs.capture, tools)).toThrow("inputs_unsupported");
  });
  // Red if an added config input or omitted empty pack selector is silently
  // ignored. Generated output under the precreated root remains a separate fact.
  it("permits output children while denying any input membership drift", async () => {
    const f = await fixture(), before = f.observe();
    await mkdir(join(f.stagePath, "node_modules/TEST-output")); await writeFile(join(f.stagePath, "node_modules/TEST-output/generated"), "TEST generated\n");
    expect(f.observe()).toBe(before);
    await writeFile(join(f.stagePath, ".npmrc"), "TEST unexpected config\n");
    expect(f.observe).toThrow("local_stage_changed"); await rm(join(f.stagePath, ".npmrc"));
    await rm(join(f.stagePath, "packages/b/dist/empty")); expect(f.observe).toThrow();
  });
  // Red if plan observation records only matching content and misses physical
  // inode replacement. The real private plan compares these observations.
  it("reports an identical-byte physical substitution as a changed plan snapshot", async () => {
    const f = await fixture(), before = f.observe(), path = join(f.stagePath, "packages/b/dist/index.js"), original = await lstat(path);
    await rename(path, join(f.stagePath, "node_modules/TEST-retained-old"));
    await writeFile(path, "module.exports = 'needed ignored bytes';\n", { mode: 0o644 });
    expect((await lstat(path)).ino).not.toBe(original.ino); expect(f.observe()).not.toBe(before);
  });
  // Red if chmod, hardlinks or a symlink to original bytes evade finite input
  // checks. External bytes must remain readable and unchanged after refusal.
  it("denies mode changes, hardlinks and source substitutions without following them", async () => {
    const f = await fixture(), path = join(f.stagePath, "packages/b/bin/cli.js"), external = join(f.root, "packages/b/bin/cli.js"), bytes = await readFile(external);
    await chmod(path, 0o644); expect(f.observe).toThrow("local_stage_changed"); await chmod(path, 0o755);
    await link(path, join(f.stagePath, "node_modules/TEST-hardlink")); expect(f.observe).toThrow("local_stage_changed");
    await rm(join(f.stagePath, "node_modules/TEST-hardlink")); await rm(path); await symlink(external, path);
    expect(f.observe).toThrow("local_stage_changed"); expect(await readFile(external)).toEqual(bytes);
  });
});
