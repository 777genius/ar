import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertHostedTestEgressIdentity,
  parseHostedTestEgressGrant,
  type HostedTestEgressGrant,
  type HostedTestEgressIdentity,
} from "./hosted-test-egress-contract";

// Already hidden by InaccessiblePaths=-/run/user in older hosted installations.
export const hostedTestEgressGrantRoot =
  "/run/user/0/subscription-runtime-host-policy/codex-egress";

export async function assertHostedTestEgressOperator(): Promise<void> {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 ||
        !(await readFile("/proc/self/uid_map", "utf8"))
          .trim().match(/^0\s+0\s+4294967295$/)) throw new Error();
    for (const namespace of ["user", "mnt", "pid"]) {
      if (await readlink(`/proc/self/ns/${namespace}`) !==
          await readlink(`/proc/1/ns/${namespace}`)) throw new Error();
    }
  } catch {
    throw new Error("hosted_test_egress_host_operator_required");
  }
}

export function hostedTestEgressGrantName(jobId: string): string {
  return createHash("sha256").update(jobId).digest("hex") + ".json";
}

export async function canonicalHostedTestIdentity(
  identity: HostedTestEgressIdentity,
  ownerUid = 0,
): Promise<HostedTestEgressIdentity> {
  // A hosted tool may edit workspace contents, never an ancestor of either identity.
  if (identity.jobRootDir.startsWith(identity.workspacePath + "/")) {
    throw new Error("hosted_test_egress_identity_invalid");
  }
  for (const path of [identity.jobRootDir, identity.workspacePath]) {
    if (!isAbsolute(path) || resolve(path) !== path ||
        hostedTestEgressGrantRoot === path ||
        hostedTestEgressGrantRoot.startsWith(path.endsWith("/") ? path : path + "/") ||
        !await assertHostedTestEgressDirectory(path, false, ownerUid, false)) {
      throw new Error("hosted_test_egress_identity_invalid");
    }
  }
  return identity;
}

/** Adapter seam for disposable tests; production callers always use the fixed root. */
export async function assertHostedTestEgressDirectory(
  root: string,
  create = false,
  ownerUid = 0,
  privateLeaf = true,
): Promise<boolean> {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error("hosted_test_egress_custody_invalid");
  }
  const parents: string[] = [];
  for (let p = root; p !== dirname(p); p = dirname(p)) parents.unshift(p);
  parents.unshift("/");
  // Walk from / downward: each checked parent prevents an untrusted actor from
  // renaming the next component while it is inspected or later used at launch.
  // Host root/mount orchestration remains trusted; a second realpath cannot do this.
  for (const path of parents) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return false;
      await mkdir(path, { mode: 0o700 });
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== ownerUid) || (stat.mode & 0o022) !== 0 ||
        (privateLeaf && path === root && (stat.mode & 0o077) !== 0)) {
      throw new Error("hosted_test_egress_custody_invalid");
    }
  }
  return true;
}

export async function readHostedTestEgressGrantFile(
  root: string,
  identity: HostedTestEgressIdentity,
  ownerUid = 0,
): Promise<HostedTestEgressGrant | null> {
  if (!await assertHostedTestEgressDirectory(root, false, ownerUid)) return null;
  let file;
  try {
    file = await open(join(root, hostedTestEgressGrantName(identity.jobId)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("hosted_test_egress_custody_invalid");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== ownerUid || stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new Error("hosted_test_egress_custody_invalid");
    }
    const grant = parseHostedTestEgressGrant(JSON.parse(await file.readFile("utf8")));
    assertHostedTestEgressIdentity(grant, identity);
    await canonicalHostedTestIdentity(identity, ownerUid);
    return grant;
  } catch {
    throw new Error("hosted_test_egress_grant_invalid");
  } finally {
    await file.close();
  }
}

export async function writeHostedTestEgressGrant(
  grant: HostedTestEgressGrant,
): Promise<void> {
  await assertHostedTestEgressOperator();
  const validated = parseHostedTestEgressGrant(grant);
  await canonicalHostedTestIdentity(validated);
  await assertHostedTestEgressDirectory(hostedTestEgressGrantRoot, true);
  const target = join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(grant.jobId));
  const temporary = target + "." + randomUUID() + ".tmp";
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(validated) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } finally {
    if (created) await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}

export async function revokeHostedTestEgressGrant(jobId: string): Promise<void> {
  await assertHostedTestEgressOperator();
  if (!await assertHostedTestEgressDirectory(hostedTestEgressGrantRoot)) return;
  await unlink(join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(jobId)))
    .catch((error: unknown) => { if (!isMissing(error)) throw error; });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
