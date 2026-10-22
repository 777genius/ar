/** Explicit TEST bootstrap configuration for the existing fresh installer.
 * Only production issueFreshHostedManifestPlacement publishes the placement. */
import assert from "node:assert/strict";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { HostedManifestLimitsRevision, openHostedDependencyManifestPlacement } from "../../dist/worker-codex/hosted-dependency-manifest-placement.js";
import { withHostedActivationFence } from "../../dist/provider-codex/index.js";
import { digest, directory, json, OwnedOsScenario, policy } from "./common.ts";
const scratch = "/mnt/TEST-retention-manifest-scratch", policyPath = policy + "/dependency-manifest-storage-policy.json";
export function prepareFreshDependencyManifestPolicy() {
  assertReadonlyHostOperator(); assert.equal(process.env.TEST_OS_SCENARIO, OwnedOsScenario.Dependency);
  assert(!existsSync(scratch) && !existsSync(policyPath) && !existsSync(policy + "/dependency-manifest-placement.json"));
  directory("/mnt", 0o755); directory(scratch);
  assert.equal(realpathSync(scratch), scratch);
  for (let path = scratch;; path = dirname(path)) {
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
    if (path === scratch) assert.equal(stat.mode & 0o7777, 0o700); if (path === "/") break;
  }
  const before = lstatSync(scratch), fd = openSync(scratch, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let pin: { canonicalPath: string; dev: string; ino: string; mountId: string };
  try {
    const opened = fstatSync(fd); assert(opened.dev === before.dev && opened.ino === before.ino);
    const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"); assert(Buffer.byteLength(info) <= 4096);
    const matches = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)]; assert.equal(matches.length, 1);
    pin = { canonicalPath: scratch, dev: String(opened.dev), ino: String(opened.ino), mountId: matches[0]![1]! };
    fsyncSync(fd); const current = lstatSync(scratch);
    assert(current.dev === opened.dev && current.ino === opened.ino && current.uid === 0 && (current.mode & 0o7777) === 0o700);
  } finally { closeSync(fd); }
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId));
  const configuration = { version: 1, scratchRoot: pin, bootId, limitsRevision: HostedManifestLimitsRevision.TestUnqualifiedV1 };
  json(policyPath, configuration);
  // Close every TEST bootstrap descriptor before the real inventory/issuer gate.
  for (const path of [policyPath, policy, scratch, "/mnt"]) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return { purpose: "TEST_manifest_configuration_only", scratchRoot: pin, policySha256: digest(JSON.stringify(configuration) + "\n"),
    limitsRevision: configuration.limitsRevision };
}
export async function qualifyFreshDependencyManifestPlacement() {
  assertReadonlyHostOperator(); assert.equal(process.env.TEST_OS_SCENARIO, OwnedOsScenario.Dependency);
  // The real read checks installation identity, private pins, quotas and all
  // physical grant aliases; the fixture never supplies a placement or bypass.
  const store = await openHostedDependencyManifestPlacement();
  await store.close(); withHostedActivationFence(fence => store.assertCurrent(fence));
  return { purpose: "TEST_actual_fresh_manifest_placement_only", placementRevision: store.placementRevision,
    limitsRevision: store.limitsRevision, issuedBy: "unchanged_fresh_installation", storeClosedBeforeNextAdmission: true };
}
