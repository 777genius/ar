import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";

/** ONE ELF-closure measurement shared by the collector-profile issuer and any other pin builder (library-first: the system-bus descriptor and
 * a rootfs builder need the same invariant). It measures; it grants nothing. Every member must be a canonical, root-owned, single-link
 * regular file that no group or other can write, and the loader (not a hand parser) decides which libraries belong to the executable. */
export type ElfPin = Readonly<{ path: string; sha256: string }>;
export type ElfFileFacts = Readonly<{ isFile: boolean; isSymbolicLink: boolean; uid: number; nlink: number; mode: number }>;
/** Observation edges, so the invariants are testable with literal observations. */
export type ElfClosureIo = Readonly<{
  list(executable: string): string;
  realpath(path: string): string;
  facts(path: string): ElfFileFacts;
  read(path: string): Buffer;
}>;
export const elfClosureMaxFiles = 64;
export const elfLoaderPath = "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
const canonical = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
function invalid(): never { throw new Error("elf_closure_invalid"); }

/**
 * The COMPLETE glibc `ld.so --list` grammar, one of exactly three line shapes (blank lines allowed):
 *   `<vdso> (0x...)`            kernel-provided object, no file: linux-vdso.so.1 / linux-gate.so.1 (the only names that may carry no path)
 *   `<soname> => /path (0x...)` a library resolved to a file
 *   `/path (0x...)`             the interpreter
 * Anything else is refused, in particular `<soname> => not found`, `statically linked` / `not a dynamic executable` and any path the
 * grammar does not recognise: an unknown line is a library this measurement did not pin.
 */
const vdsoLine = /^\s*(?:linux-vdso\.so\.1|linux-gate\.so\.1)\s+\(0x[0-9a-f]+\)\s*$/;
const libraryLine = /^\s*(?!linux-(?:vdso|gate)\.)[A-Za-z0-9_.+-]+\s+=>\s+(\/\S+)\s+\(0x[0-9a-f]+\)\s*$/;
const interpreterLine = /^\s*(\/\S+)\s+\(0x[0-9a-f]+\)\s*$/;
export function parseLoaderList(text: string): readonly string[] {
  if (Buffer.byteLength(text) > 65536) invalid();
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || vdsoLine.test(line)) continue;
    const path = (libraryLine.exec(line) ?? interpreterLine.exec(line))?.[1];
    if (!path) invalid();
    paths.push(path);
  }
  return Object.freeze(paths);
}

/**
 * Bounded provenance exception for a member with more than one link (e.g. a distribution libc that is hard-linked inside the image).
 * It is NOT a policy knob: it matches ONE exact canonical path, ONE exact SHA-256 and ONE exact link count, nothing else; the caller takes it from
 * an admitted record. Ownership, regular-file, symlink, writability and digest checks still apply to the member. There is no default and
 * the production issuers pass none.
 */
export type ElfHardlinkException = Readonly<{ path: string; sha256: string; nlink: number }>;

export function measureElfClosure(executable: string, io: ElfClosureIo = nodeElfClosureIo, exceptions: readonly ElfHardlinkException[] = []): readonly ElfPin[] {
  if (!canonical.test(executable) || io.realpath(executable) !== executable) invalid();
  const members = new Set<string>([executable]);
  for (const listed of parseLoaderList(io.list(executable))) members.add(io.realpath(listed));
  // A static executable has no loader closure and cannot satisfy the profile contract (at least executable + loader).
  if (members.size < 2 || members.size > elfClosureMaxFiles) invalid();
  return Object.freeze([...members].sort().map((path): ElfPin => {
    const facts = io.facts(path);
    if (!canonical.test(path) || !facts.isFile || facts.isSymbolicLink || facts.uid !== 0 || (facts.mode & 0o022) !== 0) invalid();
    const sha256 = createHash("sha256").update(io.read(path)).digest("hex");
    if (facts.nlink !== 1 && !exceptions.some(entry => entry.path === path && entry.sha256 === sha256 && entry.nlink === facts.nlink && entry.nlink > 1)) invalid();
    return Object.freeze({ path, sha256 });
  }));
}

export const nodeElfClosureIo: ElfClosureIo = Object.freeze({
  list(executable: string): string {
    const result = spawnSync(elfLoaderPath, ["--list", executable], { encoding: "utf8", timeout: 5_000, maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    if (result.error || result.signal || result.status !== 0) invalid();
    return result.stdout;
  },
  realpath: (path: string): string => realpathSync(path),
  facts(path: string): ElfFileFacts {
    const stat = lstatSync(path);
    return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), uid: stat.uid, nlink: stat.nlink, mode: stat.mode };
  },
  read: (path: string): Buffer => readFileSync(path),
});
