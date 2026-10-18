import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copiedReadonlyLauncherPaths } from "./assemble.ts";

test("copied readonly launcher loads its actual complete production module closure", () => {
  const source = fileURLToPath(new URL("../../host-integration/", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "TEST-readonly-launcher-closure-"));
  const load = () => spawnSync(process.execPath,
    ["--input-type=module", "--eval", "await import(process.argv[1]);", pathToFileURL(join(root, "managed-launcher/launch.mjs")).href],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536,
      env: { PATH: dirname(process.execPath), LANG: "C", LC_ALL: "C", NODE_DISABLE_COMPILE_CACHE: "1" } });
  try {
    for (const path of copiedReadonlyLauncherPaths) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, path), target);
      chmodSync(target, 0o644);
      assert.deepEqual(readFileSync(target), readFileSync(join(source, path)));
    }
    const complete = load();
    assert.ifError(complete.error); assert.equal(complete.signal, null);
    assert.equal(complete.status, 0, complete.stderr); assert.equal(complete.stdout, "");
    // The independent Node loader must reject either missing actual dependency.
    for (const leaf of ["hosted-host-policy.mjs", "storage-pressure-guard.mjs"]) {
      const path = "managed-launcher/" + leaf, target = join(root, path);
      unlinkSync(target);
      const incomplete = load();
      assert.ifError(incomplete.error); assert.equal(incomplete.signal, null);
      assert.notEqual(incomplete.status, 0); assert.match(incomplete.stderr, /ERR_MODULE_NOT_FOUND/);
      assert(incomplete.stderr.includes(leaf));
      copyFileSync(join(source, path), target); chmodSync(target, 0o644);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
