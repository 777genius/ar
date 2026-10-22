import { fstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
function invalid(): never { throw new Error("hosted_fd_boundary_unresolved"); }
export type HostedFdFact = Readonly<{ fd: number; target: string; flags: number; dev: string; ino: string; rdev: string;
  socket: boolean; pipe: boolean; character: boolean; file: boolean; directory: boolean }>;

export function hostedFdTable(pid: number): readonly HostedFdFact[] {
  if (!Number.isSafeInteger(pid) || pid < 1) invalid();
  const directory = `/proc/${pid}/fd`, names = readdirSync(directory).sort((a, b) => Number(a) - Number(b));
  if (names.length > 256) invalid();
  const facts: HostedFdFact[] = [];
  for (const name of names) {
    if (!/^(?:0|[1-9][0-9]{0,5})$/.test(name)) invalid();
    const fd = Number(name), path = `${directory}/${name}`;
    try {
      const target = readlinkSync(path), info = readFileSync(`/proc/${pid}/fdinfo/${name}`, "utf8");
      const flags = /^flags:\s+([0-7]{1,12})$/m.exec(info);
      const actual = readFileSync(`/proc/${pid}/fdinfo/${name}`, "utf8");
      // An empty fdinfo read is the same vanish as ENOENT below: the kernel
      // prints nothing when the descriptor is no longer held at read time.
      if (info === "" || actual === "") {
        try { statSync(directory); }
        catch { invalid(); }
        continue;
      }
      if (!flags || /^flags:\s+([0-7]{1,12})$/m.exec(actual)?.[1] !== flags[1] || target !== readlinkSync(path)) invalid();
      // No proc FD is opened for IO, including O_PATH handles to directories.
      const s = pid === process.pid ? fstatSync(fd, { bigint: true }) : statSync(path, { bigint: true });
      facts.push(Object.freeze({ fd, target, flags: Number.parseInt(flags[1]!, 8), dev: String(s.dev), ino: String(s.ino),
        rdev: String(s.rdev), socket: s.isSocket(), pipe: s.isFIFO(), character: s.isCharacterDevice(),
        file: s.isFile(), directory: s.isDirectory() }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      // Only our already-closed enumeration descriptor can vanish from self.
      if (pid === process.pid && ["ENOENT", "EBADF"].includes(code)) {
        try { fstatSync(fd); }
        catch (closed) { if ((closed as NodeJS.ErrnoException).code === "EBADF") continue; }
      } else if (pid !== process.pid && code === "ENOENT") {
        // A live process may close a transient descriptor between enumeration
        // and readlink; the vanished row is simply no longer held. A dead
        // process stays a hard failure: its whole fd directory is gone.
        try { statSync(directory); }
        catch { throw error; }
        continue;
      }
      throw error;
    }
  }
  return Object.freeze(facts);
}
