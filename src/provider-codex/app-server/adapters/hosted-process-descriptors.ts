import { fstatSync, readdirSync } from "node:fs";

/** Fixed launch-boundary check. Node's explicit three-pipe spawn also closes all
 * other descriptors in the child. Reject file/directory handles before provider
 * code runs, including readonly and O_PATH handles reopenable through procfs. */
export function assertHostedProcessDescriptors(): void {
  for (const descriptor of [0, 1, 2]) {
    const stat = fstatSync(descriptor);
    if (!stat.isFIFO() && !stat.isSocket()) throw new Error("hosted_custody_stdio_pipe_required");
  }
  for (const name of readdirSync("/proc/self/fd")) {
    if (!/^\d+$/.test(name)) throw new Error("hosted_custody_descriptor_invalid");
    const descriptor = Number(name);
    if (descriptor <= 2) continue;
    try {
      const stat = fstatSync(descriptor);
      if (stat.isFile() || stat.isDirectory()) throw new Error("hosted_custody_inherited_handle_denied");
    } catch (error) {
      // The directory FD used by readdir may already be closed. No inherited
      // handle is ignored merely because its readlink target looks harmless.
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
}
