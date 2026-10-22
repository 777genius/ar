/** Trusted ROOT input consumption, not a catalog or provider-availability proof. */
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, realpathSync, readSync } from "node:fs";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { runtime } from "./common.ts";
const packageRoot = runtime + "/toolchain/lib/node_modules/@openai/codex";
const executable = packageRoot + "/bin/codex.js", alias = "/usr/local/bin/codex";
function publicPin(path: typeof executable | `${typeof packageRoot}/package.json`) {
  const parents: { path: string; fd: number; dev: number; ino: number; mode: number }[] = [];
  try {
    for (let p = dirname(path);; p = dirname(p)) {
      const fd = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const s = fstatSync(fd); parents.push({path:p,fd,dev:s.dev,ino:s.ino,mode:s.mode});
      assert(s.isDirectory() && s.uid === 0 && s.gid === 0 && !(s.mode & 0o022)); assert.equal(realpathSync(p), p);
      if (p === "/") break;
    }
    const fd = openSync(`/proc/self/fd/${parents[0]!.fd}/${basename(path)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd); assert(before.isFile() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022));
      assert(before.size > 0 && before.size <= 65536);
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
      assert.equal(length, before.size);
      for (const after of [fstatSync(fd), lstatSync(path)]) {
        assert(after.isFile() && !after.isSymbolicLink());
        for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const) assert.equal(after[key], before[key]);
      }
      for (const parent of parents) for (const now of [fstatSync(parent.fd), lstatSync(parent.path)]) {
        assert(now.isDirectory() && !now.isSymbolicLink() && now.uid === 0 && now.gid === 0);
        assert.equal(now.dev, parent.dev); assert.equal(now.ino, parent.ino); assert.equal(now.mode, parent.mode);
      }
      const captured = bytes.subarray(0, length); return { bytes: captured, sha256: createHash("sha256").update(captured).digest("hex") };
    } finally { closeSync(fd); }
  } finally { for (const p of parents) closeSync(p.fd); }
}
/** The new cohort requires separately reviewed PUBLIC real Codex bytes. The
 * historical synthetic package cannot satisfy this closed package/alias route.
 * Actual factory model/list and native use remain mandatory later operations. */
export function assertCurrentRealCodexInputs(sourceSha: string) {
  assertReadonlyHostOperator(); assert(/^[a-f0-9]{40}$/.test(sourceSha));
  const reviewed = readHostedPrivateBytes("/run/TEST-real-codex-review/input.json", 4096); assert(reviewed);
  const value: unknown = JSON.parse(reviewed.toString("utf8"));
  assert(isDependencyCustodyObject(value, "executableSha256,packageSha256,reviewReference,schemaVersion,sourceSha"));
  assert.equal(value.schemaVersion, 1); assert.equal(value.sourceSha, sourceSha);
  assert(typeof value.reviewReference === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,255}$/.test(value.reviewReference));
  for (const digest of [value.executableSha256, value.packageSha256]) assert(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
  assert.equal(reviewed.toString("utf8"), JSON.stringify(value) + "\n");
  const before = lstatSync(alias); assert(before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1);
  const target = readlinkSync(alias); assert.equal(realpathSync(alias), executable);
  const script = publicPin(executable), manifest = publicPin(`${packageRoot}/package.json`);
  assert.equal(script.sha256, value.executableSha256); assert.equal(manifest.sha256, value.packageSha256);
  const metadata: unknown = JSON.parse(manifest.bytes.toString("utf8"));
  assert(metadata && typeof metadata === "object" && "name" in metadata && metadata.name === "@openai/codex");
  assert.equal(realpathSync(alias), executable); assert.equal(readlinkSync(alias), target); assert.deepEqual(lstatSync(alias), before);
  assert(publicPin(executable).bytes.equals(script.bytes)); assert(publicPin(`${packageRoot}/package.json`).bytes.equals(manifest.bytes));
  return Object.freeze({ executableSha256: script.sha256, packageSha256: manifest.sha256 });
}
