import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { scopedCgroupPopulated } from "./hosted-readonly-observations";

/** Factual filesystem collector. Production supplies its fixed owned kernel
 * cgroup path; caller-supplied facts never authorize installer completion.
 * Only a missing initial root is absence. Lost files/children are uncertainty.
 */
export function observeInstallerCgroupEmpty(root: string): string {
  const fail = (): never => { throw new Error("dependency_installer_cgroup_unresolved"); };
  const facts: unknown[] = []; let count = 0;
  let initial: Stats;
  try { initial = lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createHash("sha256").update(JSON.stringify([[root, "absent"]]) + "\n").digest("hex");
  }
  const walk = (path: string): void => {
    if (++count > 256) fail();
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink() || (count === 1 && (before.dev !== initial.dev || before.ino !== initial.ino))) fail();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) fail();
      const anchored = `/proc/self/fd/${fd}`, events = readFileSync(anchored + "/cgroup.events", "utf8"),
        processes = readFileSync(anchored + "/cgroup.procs", "utf8"), names = readdirSync(anchored).sort();
      if (scopedCgroupPopulated(events) || processes !== "") fail();
      for (const name of names) {
        if (!/^[A-Za-z0-9_.@+-]+$/.test(name) || name === "." || name === "..") fail();
        const child = lstatSync(anchored + "/" + name); if (child.isSymbolicLink()) fail();
        if (child.isDirectory()) walk(path + "/" + name);
      }
      if (events !== readFileSync(anchored + "/cgroup.events", "utf8") || processes !== readFileSync(anchored + "/cgroup.procs", "utf8") ||
          JSON.stringify(names) !== JSON.stringify(readdirSync(anchored).sort())) fail();
      const after = lstatSync(path); if (after.dev !== before.dev || after.ino !== before.ino) fail();
      facts.push([path, before.dev, before.ino, events, processes, names]);
    } finally { closeSync(fd); }
  };
  walk(root); return createHash("sha256").update(JSON.stringify(facts) + "\n").digest("hex");
}
