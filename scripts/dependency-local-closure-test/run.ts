/** Fresh CI npm semantics only. No Ready/receipt, installer authority or cleanup. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { absent, command, commandFacts, fileHash, inventory, observeTools, sha256 } from "./common.ts";
import { captureNpmLocalClosure, revalidateNpmLocalClosure,
  type QualifiedNpmLocalInputs } from "../../dist/worker-local/dependency-environment/capture-npm-local-closure.js";
import { NpmInputCaptureStatus } from "../../dist/worker-local/dependency-environment/capture-npm-install-inputs.js";
import { buildTestNpmLocalDependencyInstallKey } from "../../dist/worker-local/dependency-environment/build-test-npm-dependency-install-key.js";
import { dependencyLocalNpmArgv, DependencyLocalInstallLayout, DependencyLocalClosureKind,
  DependencyLocalEdgeField } from "../../dist/worker-core/dependency-environment/domain/dependency-local-closure.js";
import { dependencyTestNpmConfig, dependencyTestNpmEnvironment, dependencyTestNpmUmask } from "../../dist/worker-core/dependency-environment/domain/dependency-install-key.js";

assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
assert.equal(process.env.CI, "true", "CI-only: never execute on user projects");
assert.equal(process.env.GITHUB_ACTIONS, "true", "fresh hosted CI VM required");
assert.match(await readFile("/etc/os-release", "utf8"), /VERSION_ID="24\.04"/);
const source = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
assert.equal(await realpath(process.env.GITHUB_WORKSPACE ?? ""), source);
const sourceSha = process.env.TEST_SOURCE_SHA ?? ""; assert.match(sourceSha, /^[a-f0-9]{40}$/);
process.umask(dependencyTestNpmUmask);
const evidenceDir = join(source, "dependency-local-closure-evidence"); await mkdir(evidenceDir, { mode: 0o700 });
const evidence: Record<string, unknown> = { version: 1, sourceSha, status: "pending",
  purpose: "standalone-npm-local-semantics-only", npmVersion: "10.9.9", commandFacts,
  runtimeAdmissionProven: false, containedInstallerProven: false, nativeDrainProven: false,
  sourceBindingAuthorityProven: false, evictionAndColdRestoreProven: false };
let phase = "setup";
try {
  const fixtureRoot = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP ?? ""), "dependency-local-closure-TEST-")));
  await chmod(fixtureRoot, 0o700);
  await writeFile(join(fixtureRoot, "TEST-registration.json"), JSON.stringify({ sourceSha, fixtureRoot,
    purpose: evidence.purpose, nativeAuthority: false }) + "\n", { flag: "wx", mode: 0o600 });
  evidence.fixtureRoot = fixtureRoot;
  for (const name of ["home", "cache", "tmp", "git-template"]) await mkdir(join(fixtureRoot, name), { mode: 0o700 });
  for (const name of ["npmrc", "global-npmrc"]) await writeFile(join(fixtureRoot, name), dependencyTestNpmConfig, { flag: "wx", mode: 0o600 });
  // Same fixed effective config/argv. These fresh CI transport paths are NOT the
  // managed /runtime,/cache,/home mounts bound by the production key profile.
  const env: NodeJS.ProcessEnv = { ...dependencyTestNpmEnvironment,
    PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: join(fixtureRoot, "home"), TMPDIR: join(fixtureRoot, "tmp"),
    npm_config_cache: join(fixtureRoot, "cache"), npm_config_userconfig: join(fixtureRoot, "npmrc"),
    npm_config_globalconfig: join(fixtureRoot, "global-npmrc"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
  evidence.transport = { effectiveConfigSha256: sha256(dependencyTestNpmConfig), paths: "fresh-TEST-overrides",
    userAndGlobalConfigDistinct: true, inheritedEnvironment: false, umask: dependencyTestNpmUmask };
  phase = "toolchain";
  const toolchain = await observeTools(process.env.TEST_NPM_ROOT ?? "", fixtureRoot, env); evidence.toolchain = toolchain;
  const dist: unknown = JSON.parse(await command(toolchain.nodePath, [toolchain.npmCliPath, "view", "npm@10.9.9", "dist", "--json"], fixtureRoot, env, "npm_registry_provenance"));
  assert(dist && typeof dist === "object" && "tarball" in dist && "integrity" in dist);
  assert.equal(dist.tarball, "https://registry.npmjs.org/npm/-/npm-10.9.9.tgz");
  assert(typeof dist.integrity === "string"); assert.match(dist.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  evidence.npmDistribution = { tarball: dist.tarball, integrity: dist.integrity };
  evidence.repositoryLockSha256 = await fileHash(join(source, "package-lock.json"));
  const key = (capture: QualifiedNpmLocalInputs) => buildTestNpmLocalDependencyInstallKey({
    packageBytes: capture.packageBytes, lockBytes: capture.lockBytes, lockName: capture.lockName,
    closure: capture.closure, toolchain, maxInputBytes: 1024 * 1024, maxCanonicalBytes: 1024 * 1024 });
  const capture = async (workspacePath: string): Promise<QualifiedNpmLocalInputs> => {
    const result = await captureNpmLocalClosure({ workspacePath, maxInputBytes: 1024 * 1024,
      maxEntries: 2048, maxPackages: 8, maxDurationMs: 30000 });
    assert.equal(result.status, NpmInputCaptureStatus.Qualified,
      `TEST_capture_${result.status === NpmInputCaptureStatus.Qualified ? "qualified" : result.reason}`);
    if (result.status !== NpmInputCaptureStatus.Qualified) throw new Error("TEST_capture_refused"); return result;
  };
  const records: unknown[] = []; evidence.fixtures = records;
  for (const workspaceLinks of [true, false]) {
    phase = workspaceLinks ? "workspace_fixture" : "root_only_fixture";
    const name = workspaceLinks ? "workspace" : "root-only", original = join(fixtureRoot, name), generator = join(fixtureRoot, name + "-lock-generator");
    const layout = workspaceLinks ? DependencyLocalInstallLayout.RootWithLiteralWorkspaceInputs : DependencyLocalInstallLayout.RootOnly;
    const packed = { name: "b", version: "1.0.0", files: ["dist"], main: "dist/index.js", devDependencies: { semver: "7.7.2" } };
    const manifests = { root: { name: "test-local-" + name, version: "1.0.0", private: true,
      ...(workspaceLinks ? { workspaces: ["packages/a"], dependencies: { a: "*" } } : { dependencies: { b: "file:packages/b" } }) },
      workspace: { name: "a", version: "1.0.0", main: "index.js", dependencies: { b: "file:../b" } }, packed };
    const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
    const mandatory = ["README", "ReadMe.md", "COPYING", "copying.txt", "LICENSE", "LiCeNsE.md", "LICENCE", "licence.txt"];
    const authored = new Map<string, { bytes: string; mode: number }>([
      ["package.json", { bytes: encode(manifests.root), mode: 0o644 }],
      [".gitignore", { bytes: "packages/b/dist/\n", mode: 0o644 }],
      ["packages/b/package.json", { bytes: encode(packed), mode: 0o644 }],
      ["packages/b/dist/index.js", { bytes: "module.exports = 'packed-v1';\n", mode: 0o644 }],
      ["packages/b/dist/execute.js", { bytes: "module.exports = 'executable-mode-preserved';\n", mode: 0o755 }],
      ["packages/b/src/unselected.js", { bytes: "TEST original unselected source\n", mode: 0o644 }],
      ["packages/b/README.md~", { bytes: "TEST editor backup must not be packed\n", mode: 0o644 }],
      ["packages/b/LICENCE.txt$", { bytes: "TEST backup suffix must not be packed\n", mode: 0o644 }],
      ...mandatory.map(path => ["packages/b/" + path, { bytes: `TEST mandatory ${path}\n`, mode: 0o644 }] as const),
    ]);
    if (workspaceLinks) {
      authored.set("packages/a/package.json", { bytes: encode(manifests.workspace), mode: 0o644 });
      authored.set("packages/a/index.js", { bytes: "module.exports = { code: 'pure-v1', packed: require('b') };\n", mode: 0o644 });
    }
    for (const root of [original, generator]) {
      await mkdir(root, { mode: 0o700 });
      for (const [path, file] of authored) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), file.bytes, { flag: "wx", mode: file.mode });
      }
    }
    // Genuine lock generation is isolated from the original TEST source. No
    // synthetic lock entries are filled in, normalized or silently dropped.
    const setupSnapshot = await inventory(original);
    await command(toolchain.nodePath, [toolchain.npmCliPath, "install", "--package-lock-only", ...dependencyLocalNpmArgv(layout).slice(1)],
      generator, env, name + "_generate_lock");
    assert.deepEqual(await inventory(original), setupSnapshot);
    for (const [path, file] of authored) assert.equal(await readFile(join(generator, path), "utf8"), file.bytes);
    await absent(join(generator, "node_modules"));
    const lockBytes = await readFile(join(generator, "package-lock.json"));
    await writeFile(join(original, "package-lock.json"), lockBytes, { flag: "wx", mode: 0o644 });
    await writeFile(join(evidenceDir, name + "-generated-package-lock.json"), lockBytes, { flag: "wx", mode: 0o600 });
    await command("/usr/bin/git", ["init", "--quiet", "--template=" + join(fixtureRoot, "git-template"), original], fixtureRoot, env, name + "_git_init");
    const ignored = "packages/b/dist/index.js";
    await command("/usr/bin/git", ["--no-optional-locks", "check-ignore", "--no-index", "--quiet", ignored], original, env, name + "_git_check_ignore");
    for (const leaf of ["keys", "state", "results", "source"]) {
      await mkdir(join(original, leaf), { mode: 0o700 });
      await writeFile(join(original, leaf, "sentinel.txt"), `TEST ${leaf} must survive unchanged\n`, { flag: "wx", mode: 0o600 });
    }
    await absent(join(original, "node_modules"));
    const initial = await capture(original), initialKey = key(initial);
    assert.equal(initial.closure.layout, layout);
    if (workspaceLinks) assert(initial.closure.edges.some(edge => edge.declaringPath === "packages/a" &&
      edge.field === DependencyLocalEdgeField.Dependencies && edge.spec === "file:../b" && edge.targetPath === "packages/b" &&
      edge.kind === DependencyLocalClosureKind.PackedDirectory && edge.installedPaths.length === 1 && edge.installedPaths[0] === "node_modules/b"));
    assert(!initial.closure.edges.some(edge => edge.name === "semver"));
    const packedCapture = initial.closure.packages.find(local => local.path === "packages/b"); assert(packedCapture);
    assert.deepEqual(packedCapture.files.map(file => file.path).sort(), [...mandatory, "dist/index.js", "dist/execute.js"].sort());
    const readValues = async () => JSON.parse(await command(toolchain.nodePath, ["-e",
      "const r=require('node:module').createRequire(process.argv[1]+'/package.json');process.stdout.write(JSON.stringify([r('b'),process.argv[2]==='workspace'?r('a'):null]));",
      original, name], original, env, name + "_actual_require")) as unknown;
    const assertInstall = async (expectedPacked: string, expectedCode: string): Promise<string> => {
      const rows = await inventory(join(original, "node_modules"));
      assert.deepEqual(rows.map(row => row.path).sort(), ["", ".package-lock.json", ...(workspaceLinks ? ["a"] : []),
        "b", "b/package.json", "b/dist", "b/dist/index.js", "b/dist/execute.js", ...mandatory.map(path => "b/" + path)].sort());
      for (const row of rows) {
        assert.equal(row.mode, row.kind === "directory" ? 0o755 : row.kind === "symlink" ? 0o777 : row.path === "b/dist/execute.js" ? 0o755 : 0o644);
        if (row.path === "a") { assert.equal(row.kind, "symlink"); assert.equal(row.target, "../packages/a"); }
        else assert.equal(row.kind, row.path === "" || row.path === "b" || row.path === "b/dist" ? "directory" : "file");
      }
      assert.deepEqual(await readFile(join(original, "node_modules/b/package.json")), await readFile(join(original, "packages/b/package.json")));
      for (const path of [...mandatory, "dist/index.js", "dist/execute.js"])
        assert.deepEqual(await readFile(join(original, "node_modules/b", path)), await readFile(join(original, "packages/b", path)));
      await absent(join(original, "packages/b/node_modules"));
      if (workspaceLinks) { await absent(join(original, "packages/a/node_modules")); assert.equal(await realpath(join(original, "node_modules/a")), join(original, "packages/a")); }
      assert.deepEqual(await readValues(), [expectedPacked, workspaceLinks ? { code: expectedCode, packed: expectedPacked } : null]);
      // Physical inode identities differ on a reinstall; content/modes/raw links
      // form this independent installed-output comparison only.
      return sha256(JSON.stringify(rows.map(({ dev: _dev, ino: _ino, ...row }) => row)));
    };
    const npmCi = async (label: string) => {
      const before = await inventory(original, true);
      try { await command(toolchain.nodePath, [toolchain.npmCliPath, ...dependencyLocalNpmArgv(layout)], original, env, label); }
      finally { assert.deepEqual(await inventory(original, true), before, "npm changed original source/Git/sentinel bytes, identities, modes or membership"); }
    };
    await npmCi(name + "_npm_ci_initial");
    const outputDigest = await assertInstall("packed-v1", "pure-v1");
    assert.equal(key(await capture(original)).installKey, initialKey.installKey);
    assert.deepEqual(revalidateNpmLocalClosure({ capture: initial, maxDurationMs: 30000 }), { status: NpmInputCaptureStatus.Qualified });
    const record: Record<string, unknown> = { name, layout, lockSha256: sha256(lockBytes), initialKey: initialKey.installKey,
      closureDigest: initial.closureDigest, argv: dependencyLocalNpmArgv(layout), outputDigest,
      generatedLock: true, actualGitIgnoredInput: ignored, originalsPreserved: true, packedDevelopmentDependencyInstalled: false,
      mandatoryOriginalFamilies: mandatory, installedValues: await readValues() }; records.push(record);
    if (workspaceLinks) {
      // A pure workspace source change is consumed through the original link,
      // but does not cause a dependency install-key miss.
      await writeFile(join(original, "packages/a/index.js"), "module.exports = { code: 'pure-v2', packed: require('b') };\n");
      assert.equal(key(await capture(original)).installKey, initialKey.installKey);
      assert.deepEqual(await readValues(), ["packed-v1", { code: "pure-v2", packed: "packed-v1" }]);
      await writeFile(join(original, "packages/a/package.json"), encode({ ...manifests.workspace, description: "TEST manifest change" }));
      const manifestKey = key(await capture(original)).installKey; assert.notEqual(manifestKey, initialKey.installKey);
      await writeFile(join(original, "packages/b/dist/index.js"), "module.exports = 'packed-v2';\n");
      const changed = await capture(original), changedKey = key(changed); assert.notEqual(changedKey.installKey, manifestKey);
      assert.equal(await readFile(join(original, "node_modules/b/dist/index.js"), "utf8"), "module.exports = 'packed-v1';\n");
      assert.equal(revalidateNpmLocalClosure({ capture: initial, maxDurationMs: 30000 }).status, NpmInputCaptureStatus.Unknown);
      await npmCi(name + "_npm_ci_changed_ignored_input");
      record.changedOutputDigest = await assertInstall("packed-v2", "pure-v2");
      assert.equal(key(await capture(original)).installKey, changedKey.installKey);
      record.pureCodeKeyStable = true; record.localManifestMiss = manifestKey; record.neededIgnoredMiss = changedKey.installKey;
      await writeFile(join(original, "packages/b/package.json"), encode({ ...packed, devDependencies: { semver: "7.7.1" } }));
      const metadata = await capture(original);
      assert(!metadata.closure.edges.some(edge => edge.name === "semver"));
      const metadataKey = key(metadata).installKey; assert.notEqual(metadataKey, changedKey.installKey);
      record.packedDevMetadataMiss = metadataKey;
    }
  }
  // Verify tool inputs did not drift during the observed installs.
  phase = "toolchain_recheck";
  assert.deepEqual(await observeTools(toolchain.npmRootPath, fixtureRoot, env), toolchain);
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed_or_uncertain"; evidence.failedPhase = phase;
  evidence.failureClass = error instanceof assert.AssertionError ? "assertion" : "operation";
  const location = error instanceof Error ? /\/(run|common)\.ts:(\d+):(\d+)/.exec(error.stack ?? "") : null;
  if (location) evidence.failureSource = { file: location[1] + ".ts", line: Number(location[2]), column: Number(location[3]) };
  process.exitCode = 1;
} finally {
  await writeFile(join(evidenceDir, "qualification.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
