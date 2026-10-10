import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/** TEST inventory diagnostics only. No credential file is read and no existing
 * directory is adopted/chmodded. The real fixture must satisfy its own contract. */
export async function assertCodexSubscriptionTestBoundary(jobRootDir: string): Promise<void> {
  const uid = process.getuid?.() ?? null;
  const paths = [join(jobRootDir, "tmp")];
  let ancestor = jobRootDir;
  while (true) {
    paths.push(ancestor);
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const entries = await Promise.all(paths.map(async path => {
    const stat = await lstat(path);
    return { path, uid: stat.uid, gid: stat.gid, mode: `0${(stat.mode & 0o7777).toString(8)}`,
      directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), realpath: await realpath(path),
      sharedWritable: (stat.mode & 0o022) !== 0, privateMode: (stat.mode & 0o077) === 0 };
  }));
  const failures = entries.filter(entry => !entry.directory || entry.symlink || entry.realpath !== entry.path ||
    entry.sharedWritable || ([jobRootDir, join(jobRootDir, "tmp")].includes(entry.path) &&
      (!entry.privateMode || uid === null || entry.uid !== uid)));
  console.info("TEST subscription preparation filesystem boundary", JSON.stringify({ currentUid: uid, entries }));
  if (failures.length) throw new Error(`TEST_subscription_private_fixture_invalid:${JSON.stringify({ currentUid: uid, failures })}`);
}
