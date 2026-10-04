/** Trusted TEST reader mounted as one extra read-only file in the installer root.
 * This is not an authenticated provider or ordinary-consumer acceptance probe.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const observedIds = { uid: process.getuid?.(), euid: process.geteuid?.(),
  gid: process.getgid?.(), egid: process.getegid?.() };
assert.deepEqual(observedIds, { uid: 65532, euid: 65532, gid: 65532, egid: 65532 });
const staging = process.argv[2];
assert(staging && /^\/var\/lib\/subscription-runtime-host-policy\/dependency-installers\/[a-f0-9-]{36}\/staging$/.test(staging));
const sentinels: unknown = JSON.parse(process.argv[3] ?? "null");
assert(Array.isArray(sentinels) && sentinels.length === 7);
const dependency: unknown = createRequire(import.meta.url)(staging + "/node_modules/is-number");
assert.equal(typeof dependency, "function");
if (typeof dependency !== "function") throw new Error("TEST dependency capability missing");
assert.equal(dependency(42), true);
for (const path of sentinels) {
  assert(typeof path === "string" && path.startsWith("/var/lib/subscription-runtime-host-policy/"));
  assert.throws(() => readFileSync(path), (error: unknown) => error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES"), "TEST privileged sentinel must be hidden");
}
process.stdout.write(JSON.stringify({ schemaVersion: 1, scenario: "typed_installer_root_probe", observedIds,
  dependencyRead: "passed", sentinelDenial: "passed" }) + "\n");
