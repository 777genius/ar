/** Canonical compiler leaves for the existing relocated lifetime-test layout.
 * This copies DATA and code bytes; it creates no runtime custody or grant. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(process.argv.length, 2, "fixed packaging operation has no path selector");
const root = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(root, "dist/host-storage-tests/managed-launcher");
assert.equal(realpathSync(target), target);
assert.ok(existsSync(target + "/dependency-full-native-TEST.js"), "original lifetime compiler output required");
for (const [canonical, name] of [
  ["hosted-fd-unit-lifecycle.js", "hosted-fd-unit-lifecycle.js"],
  ["hosted-fd-unit-policy.js", "hosted-fd-unit-policy.js"],
  ["hosted-full-guest-source-inventory.js", "hosted-full-guest-source-inventory.js"],
] as const) {
  const source = resolve(root, "dist/provider-codex/app-server/adapters", canonical);
  assert.equal(realpathSync(source), source);
  const before = lstatSync(source); assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 256 * 1024);
  const destination = target + "/" + name;
  if (existsSync(destination)) assert.ok(lstatSync(destination).isFile() && !lstatSync(destination).isSymbolicLink());
  const bytes = readFileSync(source); copyFileSync(source, destination);
  const after = lstatSync(source);
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs], [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
  assert.deepEqual(readFileSync(destination), bytes, "same canonical compiled bytes");
}
