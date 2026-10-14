import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inside, object, pins, profile, readObject, sentinelNames, sha256, snapshot, snapshotBounds,
  SnapshotBoundError, type Registration } from "./common.ts";

const exec = promisify(execFile);
const source = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
assert.equal(process.platform, "linux");
assert.equal(process.env.CI, "true", "do not run qualification on a user workstation");
assert.equal(process.env.GITHUB_ACTIONS, "true", "fresh hosted CI runner required");
assert.equal(await realpath(process.env.GITHUB_WORKSPACE ?? ""), source);
assert.match(await readFile("/etc/os-release", "utf8"), /VERSION_ID="24\.04"/);
const sourceSha = process.env.TEST_SOURCE_SHA ?? "";
assert.match(sourceSha, /^[a-f0-9]{40}$/);
const evidenceDir = join(source, "dependency-tool-cache-evidence");
await mkdir(evidenceDir, { mode: 0o700 });
const evidence: Record<string, unknown> = { sourceSha, profile, node: process.versions.node,
  status: "pending", runtimeAdmissionProven: false, nativeDrainProven: false, hotInstallCountProven: false,
  observationBounds: snapshotBounds };
try {
  const lockBytes = await readFile(join(source, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8")) as { packages: Record<string, unknown> };
  evidence.sourceLockSha256 = sha256(lockBytes);
  const provenance: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(pins)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(object(entry)); assert.equal(entry.version, version);
    assert.equal(typeof entry.integrity, "string"); assert.match(entry.integrity as string, /^sha512-/);
    assert.equal(typeof entry.resolved, "string");
    provenance[name] = { version, integrity: entry.integrity, resolved: entry.resolved };
  }
  evidence.distributions = provenance;
  const fixtureRoot = await realpath(await mkdtemp(join(await realpath(process.env.RUNNER_TEMP ?? ""), "dependency-tool-cache-TEST-")));
  const workspace = join(fixtureRoot, "workspace"), nodeModules = join(workspace, "node_modules");
  const registration: Registration = { version: 1, purpose: "standalone-tool-qualification-only", profile,
    fixtureRoot, workspace, nodeModules, viteCache: join(fixtureRoot, "vite-cache"), transformCache: join(fixtureRoot, "transform-cache"),
    tmp: join(fixtureRoot, "tmp"), trace: join(fixtureRoot, "tool-import.trace"), requestedConfig: false,
    sourceLockSha256: sha256(lockBytes), sourceSha };
  for (const directory of [workspace, registration.viteCache, registration.transformCache, registration.tmp,
    join(fixtureRoot, "home"), join(fixtureRoot, "harness"), join(workspace, "src")]) await mkdir(directory, { mode: 0o700 });
  // npm ci happened only in this new hosted checkout. Copy bytes into a new physical
  // TEST tree, including dereferenced local workspace/bin links, never shared hardlinks.
  await cp(join(source, "node_modules"), nodeModules, { recursive: true, dereference: true, preserveTimestamps: true });
  const sourceIdentity = await lstat(join(source, "node_modules", "vite", "package.json"), { bigint: true });
  const copiedIdentity = await lstat(join(nodeModules, "vite", "package.json"), { bigint: true });
  assert.notEqual(`${sourceIdentity.dev}:${sourceIdentity.ino}`, `${copiedIdentity.dev}:${copiedIdentity.ino}`);
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "dependency-tool-cache-TEST", version: "1.0.0",
    private: true, type: "module", dependencies: pins }));
  await copyFile(join(source, "package-lock.json"), join(workspace, "package-lock.json"));
  await writeFile(join(workspace, "src", "value.ts"),
    'export const qualificationValue: string = "TEST-transform-payload-8349";\nexport function add(a: number, b: number): number { return a + b; }\n');
  await writeFile(join(workspace, "fixture.test.ts"),
    'import { expect, test } from "vitest";\nimport { add, qualificationValue } from "./src/value.ts";\ntest("actual relocated tool behavior", () => { expect(add(19, 23)).toBe(42); expect(qualificationValue).toBe("TEST-transform-payload-8349"); });\n');
  for (const name of sentinelNames) {
    await mkdir(join(nodeModules, name), { mode: 0o750 });
    const path = join(nodeModules, name, "authored-sentinel.txt");
    await writeFile(path, `TEST authored ${name} must remain unchanged\n`); await chmod(path, 0o640);
  }
  for (const name of ["common.ts", "profile.ts"]) await copyFile(join(source, "scripts", "dependency-tool-cache-test", name), join(fixtureRoot, "harness", name));
  const registrationPath = join(fixtureRoot, "TEST-registration.json");
  const publish = () => writeFile(registrationPath, JSON.stringify(registration, null, 2), { mode: 0o600 });
  await publish(); evidence.registration = registration;
  const launch = (iteration: string) => exec(process.execPath, ["--experimental-strip-types", join(fixtureRoot, "harness", "profile.ts"), registrationPath, iteration], {
    cwd: workspace, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", HOME: join(fixtureRoot, "home"), TMPDIR: registration.tmp,
      LANG: "C.UTF-8", CI: "true", GITHUB_ACTIONS: "true", TEST_REGISTERED_ROOT: fixtureRoot },
  });

  // Plausible regression: mismatch/custom config reaches imports before validation.
  const baseline = await snapshot(nodeModules);
  evidence.baselineInventory = { digest: baseline.digest, entries: baseline.entries.length, logicalFileBytes: baseline.fileBytes,
    largestFile: baseline.largestFile, observedInventoryDurationMs: baseline.durationMs };
  const vitePackage = join(nodeModules, "vite", "package.json"), original = await readFile(vitePackage);
  const installed = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
  await writeFile(vitePackage, JSON.stringify({ ...installed, version: "0.0.0-TEST-unsupported" }));
  const unsupported = await snapshot(nodeModules);
  try {
    await assert.rejects(launch("first"), /unsupported_installed_vite/);
    assert.equal((await snapshot(nodeModules)).digest, unsupported.digest);
  } finally { await writeFile(vitePackage, original); }
  assert.equal((await snapshot(nodeModules)).digest, baseline.digest);
  const configMarker = join(fixtureRoot, "unqualified-config-executed");
  const unqualifiedConfig = join(workspace, "unqualified.config.mts");
  await writeFile(unqualifiedConfig, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(configMarker)}, "executed");\nexport default {};\n`);
  registration.requestedConfig = unqualifiedConfig; await publish();
  await assert.rejects(launch("first"), /unsupported_custom_configuration/);
  await assert.rejects(lstat(configMarker), { code: "ENOENT" });
  await assert.rejects(lstat(registration.trace), { code: "ENOENT" });
  assert.deepEqual(await readdir(registration.viteCache), []);
  assert.deepEqual(await readdir(registration.transformCache), []);
  assert.deepEqual(await readdir(registration.tmp), []);
  assert.equal((await snapshot(nodeModules)).digest, baseline.digest);
  registration.requestedConfig = false; await publish();
  evidence.negativeQualification = "passed_before_tool_import_or_cache_effects";

  // Plausible regressions: optimizer no-op, swallowed result-cache error, fs cache
  // still disabled/defaulted inside dependencies, or a cache-named tree exclusion.
  const iterations: Record<string, unknown>[] = [];
  for (const iteration of ["first", "second"]) {
    await launch(iteration); // Separate foreground process, fresh module/worker state.
    const result = await readObject(join(fixtureRoot, `tool-result-${iteration}.json`));
    assert.equal(result.result, "passed"); assert.equal(result.vite, pins.vite); assert.equal(result.vitest, pins.vitest);
    const optimizer = await readObject(join(registration.viteCache, "deps", "_metadata.json"));
    assert.ok(object(optimizer.optimized)); assert.ok(object(optimizer.optimized.picocolors));
    const resultPath = join(registration.viteCache, "vitest", "da39a3ee5e6b4b0d3255bfef95601890afd80709", "results.json");
    const cache = await readObject(resultPath);
    assert.equal(cache.version, pins.vitest); assert.ok(Array.isArray(cache.results));
    const cachedTest = cache.results.find((entry: unknown) => Array.isArray(entry) && entry[0] === ":fixture.test.ts");
    assert.ok(Array.isArray(cachedTest) && object(cachedTest[1])); assert.equal(cachedTest[1].failed, false);
    assert.equal(typeof cachedTest[1].duration, "number");
    const transformMetadata = await readObject(join(registration.transformCache, "_metadata.json"));
    assert.equal(typeof transformMetadata.lockfileHash, "string");
    const cacheFiles = (await readdir(registration.transformCache)).filter((name) => /^[a-f0-9]{40}$/.test(name));
    assert.ok(cacheFiles.length > 0, "actual persistent transformed files required");
    let transformedSource: string | null = null;
    for (const name of cacheFiles) {
      const code = await readFile(join(registration.transformCache, name), "utf8");
      const index = code.lastIndexOf("\n//# vitestCache=");
      if (index < 0 || !code.includes("TEST-transform-payload-8349")) continue;
      const metadataText = Buffer.from(code.slice(index + "\n//# vitestCache=".length), "base64").toString("utf8");
      if (metadataText.includes(join(workspace, "src", "value.ts"))) transformedSource = name;
    }
    assert.ok(transformedSource, "persistent cache must contain the transformed actual TS source");
    const after = await snapshot(nodeModules);
    assert.equal(after.digest, baseline.digest, "full type/mode/content/membership changed; no cache-name exclusions");
    for (const name of sentinelNames) {
      assert.equal(await readFile(join(nodeModules, name, "authored-sentinel.txt"), "utf8"), `TEST authored ${name} must remain unchanged\n`);
      assert.equal((await lstat(join(nodeModules, name, "authored-sentinel.txt"))).mode & 0o7777, 0o640);
    }
    assert.ok(inside(fixtureRoot, resultPath) && !inside(nodeModules, resultPath));
    iterations.push({ iteration, result, resultsCachePath: resultPath, transformedSource,
      transformedFileCount: cacheFiles.length, dependencyDigest: after.digest, observedInventoryDurationMs: after.durationMs });
  }
  evidence.status = "passed"; evidence.iterations = iterations;
  evidence.dependencyInventory = { digest: baseline.digest, entries: baseline.entries.length, logicalFileBytes: baseline.fileBytes,
    largestFile: baseline.largestFile, qualificationOnly: true, cacheNameExclusions: [] };
} catch (error) {
  evidence.status = "failed_or_uncertain";
  if (error instanceof SnapshotBoundError) evidence.boundDiagnostic = error.diagnostic;
  evidence.failure = error instanceof Error ? error.message.slice(0, 4000) : "unknown qualification failure";
  process.exitCode = 1;
} finally {
  await writeFile(join(evidenceDir, "qualification.json"), JSON.stringify(evidence, null, 2));
}
