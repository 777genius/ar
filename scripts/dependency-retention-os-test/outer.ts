/** The runner only operates one newly registered service/root. Guest creation
 * is not authority: all positive gates execute inside its actual kernel view. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assemble } from "./assemble.ts";
import { command, directory, directoryIdentity, fileDigest, json, runtime } from "./common.ts";

assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0); assert.equal(process.arch, "x64");
assert.equal(process.env.GITHUB_ACTIONS, "true", "owned OS fixture requires a disposable GitHub VM");
assert.match(process.env.TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
assert.equal(command("/usr/bin/lsb_release", ["--codename", "--short"]).trim(), "noble");
const source = resolve(process.argv[2] ?? ""), toolchain = resolve(process.argv[3] ?? "");
assert(source.startsWith("/home/runner/work/")); assert(toolchain.startsWith("/opt/hostedtoolcache/node/"));
assert(existsSync(source + "/dist/worker-codex/codex-goal-cli.js"));
assert.equal(dirname(dirname(process.execPath)), toolchain);
const base = "/var/lib/subscription-runtime-os-TEST";
assert(!existsSync(base), "refuse any existing fixture namespace"); directory(base);
const id = randomUUID(), owned = base + "/" + id; directory(owned);
const root = owned + "/root", unit = `TEST-retention-os-${id}.service`;
const machineId = randomUUID().replaceAll("-", ""), outerMachineId = readFileSync("/etc/machine-id", "utf8").trim();
const evidence: Record<string, unknown> = { schemaVersion: 1, qualification: "owned_native_os_synthetic_provider",
  sourceSha: process.env.TEST_SOURCE_SHA, unit, machineId, outerMachineId, status: "failed", results: [],
  unsupported: ["committed_absent_eviction_and_cold_restore", "live_account_provider_acceptance"] };
let registered: ReturnType<typeof directoryIdentity> | undefined;
let invocationId: string | undefined;
let fragmentSha256: string | undefined;
try {
  assemble(root, owned + "/apt", source, toolchain, process.env.TEST_SOURCE_SHA!, machineId);
  registered = directoryIdentity(root);
  const packagePath = root + runtime + "/os-packages.json";
  const packageStat = lstatSync(packagePath); assert(packageStat.isFile() && packageStat.uid === 0 && packageStat.size < 65536);
  evidence.osPackageFacts = JSON.parse(readFileSync(packagePath, "utf8"));
  const nspawn = root + "/usr/bin/systemd-nspawn";
  const version = command(nspawn, ["--version"]).split("\n")[0]!;
  assert.match(version, /^systemd 255(?:\.|\s)/);
  const launch = { schemaVersion: 1, purpose: "dependency-retention-owned-OS-TEST", unit, root: registered,
    machineId, outerMachineId, sourceSha: process.env.TEST_SOURCE_SHA, nspawnVersion: version, nspawnSha256: fileDigest(nspawn) };
  json(owned + "/registration.json", launch);
  evidence.launchRegistration = launch;
  const fragment = `[Unit]\nDescription=Owned disposable dependency TEST OS ${id}\n[Service]\nType=exec\nDelegate=yes\nKillMode=control-group\nRestart=no\nRuntimeMaxSec=25min\nTimeoutStopSec=30s\nEnvironment=SYSTEMD_NSPAWN_USE_CGNS=1\nExecStart=${nspawn} --directory=${root} --machine=TEST-retention-${id} --register=no --keep-unit --private-users=no --boot --console=pipe --resolv-conf=off --capability=CAP_SYS_ADMIN,CAP_MKNOD,CAP_SETPCAP,CAP_SETFCAP --setenv=SYSTEMD_UNIT_PATH=/etc/systemd/test-units:/run/systemd/system -- --unit=TEST-retention.target --log-target=console\n`;
  const unitPath = "/run/systemd/system/" + unit;
  assert(!existsSync(unitPath)); writeFileSync(unitPath, fragment, { flag: "wx", mode: 0o644 });
  fragmentSha256 = fileDigest(unitPath);
  json(owned + "/unit-registration.json", { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
  evidence.fragmentSha256 = fragmentSha256;
  command("/usr/bin/systemctl", ["daemon-reload"]);
  command("/usr/bin/systemctl", ["start", "--no-block", unit]);
  invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
  // A queued start may not yet have its invocation. Poll only this registered unit.
  const deadline = Date.now() + 22 * 60 * 1000;
  const path = root + runtime + "/guest-evidence.json";
  while (!existsSync(path)) {
    assert(Date.now() < deadline, "owned TEST guest qualification timed out");
    const state = command("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"]).trim();
    assert(["active", "activating"].includes(state), "owned TEST guest exited before evidence");
    if (!invocationId) invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.match(invocationId ?? "", /^[a-f0-9]{32}$/);
  evidence.invocationId = invocationId;
  const stat = lstatSync(path); assert(stat.isFile() && stat.uid === 0 && stat.size < 65536);
  const guest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(guest.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(guest.machineId, machineId);
  assert.equal(guest.qualification, "native_fresh_hot_synthetic_provider");
  evidence.guest = guest; evidence.status = guest.status;
  assert.equal(guest.status, "partial_pass", "actual unchanged guest gate did not qualify");
} catch (error) {
  evidence.failure = error instanceof Error ? error.message.slice(0, 512) : "owned TEST fixture failure";
  process.exitCode = 1;
} finally {
  if (registered && existsSync("/run/systemd/system/" + unit)) {
    try {
      assert.deepEqual(directoryIdentity(root), registered);
      assert.equal(readFileSync("/etc/machine-id", "utf8").trim(), outerMachineId);
      const retained = JSON.parse(readFileSync(owned + "/unit-registration.json", "utf8")) as Record<string, unknown>;
      assert.deepEqual(retained, { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
      assert.equal(fileDigest("/run/systemd/system/" + unit), retained.fragmentSha256);
      const current = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
      assert(invocationId && current === invocationId, "uncertain owned unit: leave held for VM disposal");
      command("/usr/bin/systemctl", ["stop", unit], 45000);
      evidence.ownedOsStopped = true;
    } catch { evidence.ownedOsStopped = false; process.exitCode = 1; }
  }
  // No guest registry/root is deleted. VM disposal retains uncertain state until
  // the platform ends the owned job; export bounded sanitized facts only.
  assert(Buffer.byteLength(JSON.stringify(evidence)) <= 256 * 1024);
  json(source + "/dependency-retention-os-evidence.json", evidence, 0o644);
}
