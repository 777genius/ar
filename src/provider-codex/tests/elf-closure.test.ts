import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { elfClosureMaxFiles, measureElfClosure, parseLoaderList, type ElfClosureIo, type ElfFileFacts } from "../app-server/adapters/elf-closure";

const listing = [
  "\tlinux-vdso.so.1 (0x00007ffd5c9f1000)",
  "\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f1c2a000000)",
  "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f1c29e00000)",
  "\t/lib64/ld-linux-x86-64.so.2 (0x00007f1c2a400000)", ""].join("\n");
const real: Record<string, string> = { "/lib/x86_64-linux-gnu/libstdc++.so.6": "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
  "/lib/x86_64-linux-gnu/libc.so.6": "/usr/lib/x86_64-linux-gnu/libc.so.6", "/lib64/ld-linux-x86-64.so.2": "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" };
const rootFile: ElfFileFacts = { isFile: true, isSymbolicLink: false, uid: 0, nlink: 1, mode: 0o100755 };
function io(over: { list?: string; facts?: (path: string) => ElfFileFacts; realpath?: (path: string) => string } = {}): ElfClosureIo {
  return { list: () => over.list ?? listing, realpath: over.realpath ?? (path => real[path] ?? path), facts: over.facts ?? (() => rootFile), read: path => Buffer.from(`bytes of ${path}`) };
}
const sha = (path: string) => createHash("sha256").update(`bytes of ${path}`).digest("hex");

describe("ELF closure measurement", () => {
  // Regression: the vdso line (no path) or the bare interpreter line is dropped or mis-parsed, so a pinned closure misses the loader.
  it("reads library and interpreter paths from the loader listing and ignores the vdso", () => {
    expect(parseLoaderList(listing)).toEqual(["/lib/x86_64-linux-gnu/libstdc++.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/ld-linux-x86-64.so.2"]);
  });
  // Regression: members are pinned through a symlinked alias (/lib -> /usr/lib) that the collector later refuses, or the executable itself is missing from its own closure.
  it("pins canonical real paths with their digests, sorted, including the executable", () => {
    expect(measureElfClosure("/usr/bin/ss", io())).toEqual([
      { path: "/usr/bin/ss", sha256: sha("/usr/bin/ss") },
      { path: "/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", sha256: sha("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2") },
      { path: "/usr/lib/x86_64-linux-gnu/libc.so.6", sha256: sha("/usr/lib/x86_64-linux-gnu/libc.so.6") },
      { path: "/usr/lib/x86_64-linux-gnu/libstdc++.so.6", sha256: sha("/usr/lib/x86_64-linux-gnu/libstdc++.so.6") },
    ]);
  });
  // Regression: a foreign, hardlinked, writable or symlinked member is pinned as if it were trusted bytes.
  it.each<[string, Partial<ElfFileFacts>]>([["symlink", { isSymbolicLink: true }], ["directory or special file", { isFile: false }], ["other owner", { uid: 1000 }],
    ["hardlinked", { nlink: 2 }], ["group writable", { mode: 0o100775 }], ["other writable", { mode: 0o100757 }]])("refuses a %s member", (_name, bad) => {
    expect(() => measureElfClosure("/usr/bin/ss", io({ facts: path => path.endsWith("libc.so.6") ? { ...rootFile, ...bad } : rootFile }))).toThrow();
  });
  // Regression: a loader line the grammar does not know (unresolved library, relative path, odd token) is skipped and its library is never pinned.
  it.each(["\tlibmissing.so.1 => not found\n", "\tlibx.so => lib/relative.so (0x1)\n", "\tstatically linked\n", "\tsurprise (0x1)\n", "\tlibx.so => /usr/lib/libx.so\n",
    "\tlinux-vdso.so.1 => /evil/vdso (0x1)\n", "\tlibx.so => /usr/lib/libx.so (0x1) trailing\n"])("refuses the unknown loader line %j", line => {
    expect(() => parseLoaderList(listing + line)).toThrow("elf_closure_invalid");
    expect(() => measureElfClosure("/usr/bin/ss", io({ list: listing + line }))).toThrow();
  });
  // Regression: the nlink exception widens into "any hardlink" or loses its digest binding.
  it("accepts a link count above one only for the exact path, digest and count of a supplied exception", () => {
    const libc = "/usr/lib/x86_64-linux-gnu/libc.so.6", two = io({ facts: path => path === libc ? { ...rootFile, nlink: 2 } : rootFile });
    expect(() => measureElfClosure("/usr/bin/ss", two)).toThrow();
    expect(measureElfClosure("/usr/bin/ss", two, [{ path: libc, sha256: sha(libc), nlink: 2 }]).map(pin => pin.path)).toContain(libc);
    for (const wrong of [{ path: libc, sha256: "0".repeat(64), nlink: 2 }, { path: libc, sha256: sha(libc), nlink: 3 }, { path: "/usr/lib/x86_64-linux-gnu/libstdc++.so.6", sha256: sha(libc), nlink: 2 }]) {
      expect(() => measureElfClosure("/usr/bin/ss", two, [wrong])).toThrow();
    }
    // the exception never waives owner/writability
    const writable = io({ facts: path => path === libc ? { ...rootFile, nlink: 2, mode: 0o100775 } : rootFile });
    expect(() => measureElfClosure("/usr/bin/ss", writable, [{ path: libc, sha256: sha(libc), nlink: 2 }])).toThrow();
    expect(() => measureElfClosure("/usr/bin/ss", two, [{ path: libc, sha256: sha(libc), nlink: 1 }])).toThrow();
  });
  // Regression: a non-canonical executable path, a static executable (no loader closure) or an unbounded closure is accepted.
  it("refuses non-canonical, static and oversized closures", () => {
    expect(() => measureElfClosure("usr/bin/ss", io())).toThrow();
    expect(() => measureElfClosure("/usr/bin/ss", io({ realpath: path => path === "/usr/bin/ss" ? "/opt/other/ss" : path }))).toThrow();
    expect(() => measureElfClosure("/usr/bin/tini", io({ list: "\tnot a dynamic executable\n" }))).toThrow();
    const many = Array.from({ length: elfClosureMaxFiles + 1 }, (_value, index) => `\tlib${index}.so => /usr/lib/lib${index}.so (0x1)`).join("\n");
    expect(() => measureElfClosure("/usr/bin/ss", io({ list: many }))).toThrow();
  });
});
