import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";

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
    const privateParent = (directory: string, stat: Stats) => {
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 ||
          (directory === parent && (stat.mode & 0o077) !== 0)) invalid();
    };
    const ancestry = parents.map(directory => {
      const stat = lstatSync(directory); privateParent(directory, stat);
      return { directory, stat };
    });
    const sameInode = (a: Stats, b: Stats) =>
      a.dev === b.dev && a.ino === b.ino;
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const anchoredParent = `/proc/self/fd/${parentFd}`;
      const checkAncestry = () => {
        const opened = fstatSync(parentFd); privateParent(parent, opened);
        if (!sameInode(opened, ancestry[ancestry.length - 1]!.stat) ||
            !sameInode(opened, statSync(anchoredParent))) invalid();
        for (const { directory, stat } of ancestry) {
          const current = lstatSync(directory); privateParent(directory, current);
          if (!sameInode(current, stat)) invalid();
        }
      };
      checkAncestry();
      let fd: number;
      // Linux private-policy contract: procfs resolves the pinned directory;
      // only a missing final component under unchanged ancestry is absence.
      try { fd = openSync(`${anchoredParent}/${basename(path)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          checkAncestry(); return null;
        }
        throw error;
      }
      try {
        checkAncestry();
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
        checkAncestry(); return buffer.subarray(0, length);
      } finally { closeSync(fd); }
    } finally { closeSync(parentFd); }
  } catch { invalid(); }
}

function canonicalPath(path: string): boolean {
  return path.length <= 4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) &&
    !path.split("/").some(part => part === "." || part === "..");
}
function invalid(): never { throw new Error("hosted_readonly_policy_invalid"); }
