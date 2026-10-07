/** TEST-only opaque seed attachment. Never reads, hashes, copies or prints credentials. */
import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { assertCurrentClosedEntry } from "./current-closed-entry.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import type { HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { command, directory } from "./common.ts";
const configuredPool = "/srv/worker-state/account-pools/live-codex-auth";
const guestSeedRoot = "/run/TEST-configured-codex-auth";
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function assertConfiguredAccountName(name: string): void {
  assert(typeof name === "string" && namePattern.test(name));
}
function fileIdentity(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    assert(s.isFile() && s.uid === 0n && s.gid === 0n && s.nlink === 1n && (s.mode & 0o7777n) === 0o600n && s.size > 0n && s.size <= 65536n);
    assert(s.dev === named.dev && s.ino === named.ino && s.ctimeNs === named.ctimeNs && s.size === named.size);
    return `${s.dev}:${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}`;
  } finally { closeSync(fd); }
}
function safeAncestry(path: string): void {
  for (let p = dirname(path);; p = dirname(p)) {
    const s = lstatSync(p); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022));
    if (p === "/") break;
  }
  assert.equal(realpathSync(path), path);
}
/** Called by the trusted owned-OS ROOT setup after actual runtime slot discovery.
 * The exact configured name is preserved, never account-u <-> u inferred.
 * This selects input data in ONE fixed configured pool, not account availability. */
export function configuredAuthNspawnBinding(accountName: string): string {
  assertReadonlyHostOperator(); assertConfiguredAccountName(accountName);
  const source = `${configuredPool}/${accountName}/auth.json`, target = `${guestSeedRoot}/${accountName}/auth.json`;
  safeAncestry(source); fileIdentity(source);
  // All names are closed path atoms; no shell interpolation, options or env origin.
  return `--bind-ro=${source}:${target}`;
}
function mounts() {
  const bytes = readFileSync("/proc/self/mountinfo", "utf8"); assert(Buffer.byteLength(bytes) <= 1024 * 1024);
  return bytes.trimEnd().split("\n").map(line => {
    const fields = line.split(" "), at = fields.indexOf("-");
    assert(at > 5 && /^[1-9][0-9]*$/.test(fields[0] ?? ""));
    return { id: fields[0]!, dev: fields[2]!, root: fields[3]!, target: fields[4]!, options: fields[5]!.split(",") };
  });
}
/** Mount belongs to this TEST issuer's current PID1 namespace. No credential content
 * copy and no retained source FD crosses the actual provider/collector boundary. */
export function mountCurrentConfiguredAuth(jobRoot: string, accountName: string) {
  assertReadonlyHostOperator(); assertConfiguredAccountName(accountName);
  assert(/^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}$/.test(jobRoot));
  const source = `${guestSeedRoot}/${accountName}/auth.json`, target = `${jobRoot}/auth/${accountName}/auth.json`;
  safeAncestry(source); const sourceIdentity = fileIdentity(source);
  const initial = mounts().filter(row => row.target === source); assert.equal(initial.length, 1); assert(initial[0]!.options.includes("ro"));
  directory(jobRoot + "/auth"); directory(jobRoot + "/auth/" + accountName);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const own = fstatSync(fd, { bigint: true }); closeSync(fd);
  assert(own.isFile() && own.size === 0n && own.nlink === 1n);
  assert(!mounts().some(row => row.target === target || row.target.startsWith(target + "/")));
  // Any uncertain mount/remount holds its exact owned target; no automatic retry/unmount.
  command("/usr/bin/mount", ["--bind", source, target]);
  command("/usr/bin/mount", ["-o", "remount,bind,ro,nosuid,nodev,noexec", target]);
  const attached = mounts().filter(row => row.target === target); assert.equal(attached.length, 1);
  const record = attached[0]!; assert(record.options.includes("ro") && record.options.includes("nosuid") && record.options.includes("nodev") && record.options.includes("noexec"));
  assert.equal(fileIdentity(source), sourceIdentity); assert.equal(fileIdentity(target), sourceIdentity);
  let closed = false;
  return Object.freeze({
    /** Original branded completion plus current CLOSED/no-live-reader state is
     * required. A bool or caller-authored release receipt is never accepted. */
    close(result: HostedForegroundResult) {
      return withHostedActivationFence(fence => {
      assertCurrentClosedEntry(fence, jobRoot, result); assertReadonlyHostOperator(); assert(!closed);
      const current = mounts().filter(row => row.target === target); assert.equal(current.length, 1);
      assert.deepEqual(current[0], record); assert.equal(fileIdentity(target), sourceIdentity);
      command("/usr/bin/umount", ["--", target]);
      assert(!mounts().some(row => row.target === target));
      const after = lstatSync(target, { bigint: true });
      assert(after.isFile() && !after.isSymbolicLink() && after.dev === own.dev && after.ino === own.ino && after.size === 0n && after.nlink === 1n);
      unlinkSync(target); closed = true;
      });
    },
  });
}
