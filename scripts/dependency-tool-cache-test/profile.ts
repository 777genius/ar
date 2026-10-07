import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inside, pins, qualify, type Registration } from "./common.ts";

const registration: Registration = JSON.parse(await readFile(process.argv[2] ?? "", "utf8"));
const iteration = process.argv[3];
assert.ok(iteration === "first" || iteration === "second", "closed TEST invocation required");
// No tool dependency import/config evaluation occurs before this TEST qualification.
// This is not a runtime admission token or proof of native descendant exclusion.
await qualify(registration);
await appendFile(registration.trace, "tool-import-begin\n");
const fixtureRequire = createRequire(join(registration.workspace, "package.json"));
const vite: typeof import("vite") = await import(pathToFileURL(fixtureRequire.resolve("vite")).href);
assert.equal(vite.version, pins.vite);
const config = await vite.resolveConfig({ root: registration.workspace, configFile: false, envDir: false,
  cacheDir: registration.viteCache, optimizeDeps: { entries: [], include: ["picocolors"], noDiscovery: true } }, "serve");
assert.equal(config.cacheDir, registration.viteCache);
// Public, deprecated API, exact-version isolated qualification only. Await includes commit.
const metadata = await vite.optimizeDeps(config, iteration === "first");
const optimized = metadata.optimized.picocolors;
assert.ok(optimized, "nonempty actual optimizer result required");
const bundle = await realpath(optimized.file);
assert.ok(inside(join(registration.viteCache, "deps"), bundle));
assert.ok((await readFile(bundle)).length > 0);
assert.ok((await readFile(`${bundle}.map`)).length > 0);
const optimizedModule: unknown = await import(pathToFileURL(bundle).href);
assert.ok(optimizedModule !== null && typeof optimizedModule === "object");
const colors = (optimizedModule as { default?: { green?: (text: string) => string } }).default;
assert.equal(typeof colors?.green, "function");
assert.equal(colors!.green!("TEST-cache-export"), "TEST-cache-export");
await appendFile(registration.trace, "optimizer-export-passed\n");

const vitest: typeof import("vitest/node") = await import(pathToFileURL(fixtureRequire.resolve("vitest/node")).href);
const ctx = await vitest.startVitest("test", ["fixture.test.ts"], {
  root: registration.workspace, config: false, run: true, watch: false, environment: "node",
  include: ["fixture.test.ts"], pool: "forks", maxWorkers: 1, fileParallelism: false,
  coverage: { enabled: false }, experimental: { fsModuleCache: true, fsModuleCachePath: registration.transformCache },
}, { root: registration.workspace, cacheDir: registration.viteCache, envDir: false, server: { watch: null } });
try {
  await ctx.waitForTestRunEnd();
  assert.deepEqual(ctx.state.getUnhandledErrors(), []);
  const modules = ctx.state.getTestModules();
  assert.equal(modules.length, 1, "actual TEST module must run");
  const module = modules[0]!;
  assert.equal(module.moduleId, join(registration.workspace, "fixture.test.ts"));
  assert.equal(module.state(), "passed"); assert.equal(module.ok(), true);
  const tests = [...module.children.allTests()];
  assert.equal(tests.length, 1);
  assert.equal(tests[0]!.result().state, "passed");
  assert.ok(process.exitCode === undefined || process.exitCode === 0);
  await writeFile(join(registration.fixtureRoot, `tool-result-${iteration}.json`), JSON.stringify({
    profile: registration.profile, vite: vite.version, vitest: ctx.version,
    optimizerBundle: bundle, testModule: module.moduleId, testCount: tests.length,
    result: "passed", runtimeAdmissionProven: false,
  }, null, 2));
} finally {
  // Public close + bounded foreground child exit are necessary tool-fixture evidence,
  // not authoritative runtime cgroup/queue/future-reader drain proof.
  await ctx.close();
}
