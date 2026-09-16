import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { admittedReadonlyCodexProcessFactory } from "@vioxen/subscription-runtime/provider-codex";

export const hostedReadonlyPolicyRoot =
  "/run/user/0/subscription-runtime-host-policy/codex-readonly";
const maxPolicyBytes = 64 * 1024;

export type HostedReadonlyPolicy = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly runtimeSha: string;
  readonly runtimeManifestSha256: string;
  readonly issuerDeploymentDigest: string;
  readonly readonlyPaths: readonly string[];
};

/** Parsing is structural validation, never deployment approval or custody. */
export function parseHostedReadonlyPolicy(value: unknown): HostedReadonlyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !==
      "issuerDeploymentDigest,jobId,jobRootDir,readonlyPaths,runtimeManifestSha256,runtimeSha,schemaVersion,workspacePath" ||
      record.schemaVersion !== 1 ||
      typeof record.jobId !== "string" || !record.jobId.trim() || record.jobId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(record.jobId) ||
      typeof record.jobRootDir !== "string" || !canonicalPath(record.jobRootDir) ||
      typeof record.workspacePath !== "string" ||
      typeof record.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(record.runtimeSha) ||
      typeof record.runtimeManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.runtimeManifestSha256) ||
      typeof record.issuerDeploymentDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.issuerDeploymentDigest) ||
      !Array.isArray(record.readonlyPaths) || record.readonlyPaths.length === 0 ||
      record.readonlyPaths.length > 64 || !record.readonlyPaths.every(path => typeof path === "string")) invalid();
  const policy: HostedReadonlyPolicy = Object.freeze({
    schemaVersion: 1,
    jobId: record.jobId,
    jobRootDir: record.jobRootDir,
    workspacePath: record.workspacePath,
    runtimeSha: record.runtimeSha,
    runtimeManifestSha256: record.runtimeManifestSha256,
    issuerDeploymentDigest: record.issuerDeploymentDigest,
    readonlyPaths: Object.freeze([...record.readonlyPaths]),
  });
  // Reuse the adapter's finite mount grammar without spawning a process.
  admittedReadonlyCodexProcessFactory(policy);
  if (Buffer.byteLength(JSON.stringify(policy)) > maxPolicyBytes) invalid();
  return policy;
}

/** Both operands must be independently obtained by the host admission adapter.
 * A caller-provided expected record cannot confer review/stage authority.
 */
export function assertHostedReadonlyPolicyBinding(
  policy: HostedReadonlyPolicy,
  expected: HostedReadonlyPolicy,
): void {
  const actual = parseHostedReadonlyPolicy(policy);
  const trusted = parseHostedReadonlyPolicy(expected);
  if (JSON.stringify(actual) !== JSON.stringify(trusted)) {
    throw new Error("hosted_readonly_policy_binding_mismatch");
  }
}

/** Fixed-root synchronous reader for the eventual worker-owned spawn guard.
 * A readable root-authored policy still needs independent stage/review/custody
 * admission. This function intentionally does not claim to supply that authority.
 */
export function readHostedReadonlyPolicy(jobId: string): {
  readonly policy: HostedReadonlyPolicy;
  readonly bytes: Buffer;
} | null {
  const name = createHash("sha256").update(jobId).digest("hex") + ".json";
  const bytes = readHostedPrivateBytes(join(hostedReadonlyPolicyRoot, name), maxPolicyBytes);
  if (!bytes) return null;
  try {
    const policy = parseHostedReadonlyPolicy(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ));
    if (policy.jobId !== jobId) invalid();
    return { policy, bytes };
  } catch { invalid(); }
}

/** Host filesystem adapter helper; production callers choose fixed private roots. */
export function readHostedPrivateBytes(path: string, maxBytes: number): Buffer | null {
  try {
    if (!canonicalPath(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) invalid();
    const parent = dirname(path);
    const parents: string[] = [];
    for (let directory = parent;; directory = dirname(directory)) {
      parents.unshift(directory);
      if (directory === "/") break;
    }
    // Trusted parents prevent component replacement before and during open.
    for (const directory of parents) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
          (directory === parent && (stat.mode & 0o077) !== 0)) invalid();
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
          (before.mode & 0o077) !== 0 || before.size > maxBytes) invalid();
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const after = fstatSync(fd);
      if (length > maxBytes || length !== before.size ||
          after.size !== before.size || after.ctimeMs !== before.ctimeMs ||
          after.mtimeMs !== before.mtimeMs || after.nlink !== 1 || after.uid !== 0 ||
          (after.mode & 0o077) !== 0) invalid();
      return buffer.subarray(0, length);
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    invalid();
  }
}

function canonicalPath(path: string): boolean {
  return path.length <= 4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) &&
    !path.split("/").some(part => part === "." || part === "..");
}
function invalid(): never { throw new Error("hosted_readonly_policy_invalid"); }
