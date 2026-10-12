import { describe, expect, it } from "vitest";
import { decodeOriginalFullPeerSelection as decode, resolveOriginalFullPeerSelection as resolve } from "../hosted-project-control-peer-selection.js";
const sha = "a".repeat(64), other = "b".repeat(64), lib = "/usr/lib/x86_64-linux-gnu/", loader = lib + "ld-linux-x86-64.so.2";
const tools = ["/usr/bin/dbus-daemon", "/usr/bin/ss", "/usr/bin/setpriv", "/usr/bin/systemd-run", "/usr/bin/tini", "/usr/bin/unshare", "/usr/bin/busctl"];
const layoutNames = ["bin", "sbin", "lib", "lib64"];
function fixture() {
  const packages = [ { package: "iproute2", version: "6.1.0-1ubuntu6.4", arch: "amd64", sha256: sha, size: 1024 },
    { package: "libc6", version: "2.39-0ubuntu8", arch: "amd64", sha256: sha, size: 1024 } ];
  return {
    elf: { schemaVersion: 1, pins: [...tools, loader, lib + "libc.so.6"].map(path => ({ path, sha256: sha })) },
    packages: { schemaVersion: 1, release: "ubuntu-noble", releases: ["archive", "security", "updates"].map(name => ({ name: name + "_InRelease", sha256: sha })), packages,
      usrLayout: { aliases: layoutNames.map(name => ({ alias: "/" + name, target: "/usr/" + name, priorKind: "symlink", movedEntries: 0 })),
        movedEntries: 0, movedBytes: "0", movedManifestSha256: sha,
        tools: tools.map(path => ({ path, sha256: sha, dev: "1", ino: "2", mode: 0o755, bytes: "1024" })) },
      pinnedNode: { sha256: other, version: "v22.23.3", requirements: ["libc.so.6", "ld-linux-x86-64.so.2"].map(soname => ({ soname, sha256: sha, package: "libc6" })), requiredPackages: ["libc6"] } },
    aliases: { schemaVersion: 1, packages, aliases: [...layoutNames.map(name => ({ path: "/" + name, target: "usr/" + name })),
      { path: "/usr/lib64/ld-linux-x86-64.so.2", target: "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" }].sort((a, b) => a.path < b.path ? -1 : 1) },
  };
}
type Fixture = ReturnType<typeof fixture>;
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const selected = (f = fixture()) => decode(encoded(f.elf), encoded(f.packages), encoded(f.aliases));
function edge(f: Fixture, path: string, target: string): void { f.aliases.aliases.push({ path, target }); f.aliases.aliases.sort((a, b) => a.path < b.path ? -1 : 1); }
function chain(f: Fixture, length: number): string {
  for (let i = 0; i < length; i++) edge(f, lib + "peer" + i, i === length - 1 ? "libc.so.6" : "peer" + (i + 1));
  return lib + "peer0";
}

describe("original FULL peer metadata facts", () => {
  it("joins the actual closed schemas and resolves only signed selected paths", () => {
    const selection = selected(); expect(selection.nodeSha256).toBe(other);
    expect(resolve(selection, "/usr/bin/ss")).toEqual({ path: "/usr/bin/ss", sha256: sha, aliases: [] });
    expect(resolve(selection, loader)).toEqual({ path: loader, sha256: sha, aliases: [] });
    expect(resolve(selection, "/lib64/ld-linux-x86-64.so.2")).toEqual({ path: loader, sha256: sha, aliases: [
      { path: "/lib64", target: "usr/lib64" }, { path: "/usr/lib64/ld-linux-x86-64.so.2", target: "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" } ] });
    expect(Object.isFrozen(selection)).toBe(true);
    for (const rows of [selection.nodeRequirements, selection.signedElfs, selection.aliases]) { expect(Object.isFrozen(rows)).toBe(true); for (const row of rows) expect(Object.isFrozen(row)).toBe(true); }
    expect(Object.isFrozen(resolve(selection, loader).aliases)).toBe(true);
  });
  it("preserves exact package order rather than independently sorting authenticated vectors", () => { const f = fixture(); f.packages.packages.reverse(); expect(selected(f).nodeSha256).toBe(other); });
  it("normalizes a raw absolute loader alias through the original /lib edge", () => { const f = fixture(); f.aliases.aliases.at(-1)!.target = "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2";
    expect(resolve(selected(f), "/lib64/ld-linux-x86-64.so.2").aliases.map(row => row.path)).toEqual(["/lib64", "/usr/lib64/ld-linux-x86-64.so.2", "/lib"]); });
  it("accepts the original directory migration facts with exact aggregate counts", () => { const f = fixture(); f.packages.usrLayout.aliases[0]!.priorKind = "directory"; f.packages.usrLayout.aliases[0]!.movedEntries = 2;
    f.packages.usrLayout.movedEntries = 2; f.packages.usrLayout.movedBytes = "42"; expect(selected(f).nodeSha256).toBe(other); });
  it("accepts exactly sixteen lexical alias edges", () => { const f = fixture(), logical = chain(f, 16); expect(resolve(selected(f), logical).aliases).toHaveLength(16); });
  it("rejects seventeen edges, even in an otherwise unused captured chain", () => { const f = fixture(); chain(f, 17); expect(() => selected(f)).toThrow(); });
  it("accepts a fixed safe soname outside pinned Node while requiring its signed leaf", () => { const f = fixture(); f.elf.pins.push({ path: lib + "libpeer.so.2.0", sha256: other });
    edge(f, lib + "libpeer.so.2", "libpeer.so.2.0"); expect(resolve(selected(f), lib + "libpeer.so.2").sha256).toBe(other); });

  const mutations: [string, (f: Fixture) => void][] = [
    ["ELF schema", f => { f.elf.schemaVersion = 2; }], ["duplicate ELF", f => { f.elf.pins.push(f.elf.pins[0]!); }],
    ["unsigned tool", f => { f.elf.pins.shift(); }], ["foreign signed root", f => { f.elf.pins[0]!.path = "/tmp/ss"; }],
    ["noncanonical pin", f => { f.elf.pins[0]!.path = "/usr/lib/../bin/dbus-daemon"; }], ["bad digest", f => { f.elf.pins[0]!.sha256 = sha.toUpperCase(); }],
    ["release", f => { f.packages.release = "ubuntu-jammy"; }], ["release census", f => { f.packages.releases.pop(); }], ["duplicate release", f => { f.packages.releases[1]!.name = f.packages.releases[0]!.name; }],
    ["package vector drift", f => { f.aliases.packages = f.aliases.packages.slice().reverse(); }], ["package digest drift", f => { f.aliases.packages = structuredClone(f.aliases.packages); f.aliases.packages[0]!.sha256 = other; }],
    ["duplicate package", f => { f.packages.packages.push(f.packages.packages[0]!); }], ["arch", f => { f.packages.packages[0]!.arch = "arm64"; }],
    ["iproute version", f => { f.packages.packages[0]!.version = "6.1.0-1ubuntu6.5"; }], ["empty package size", f => { f.packages.packages[0]!.size = 0; }],
    ["unsafe package", f => { f.packages.packages[1]!.package = "../libc6"; }], ["tool writable", f => { f.packages.usrLayout.tools[0]!.mode = 0o777; }],
    ["tool non-executable", f => { f.packages.usrLayout.tools[0]!.mode = 0o644; }], ["tool SHA drift", f => { f.packages.usrLayout.tools[0]!.sha256 = other; }],
    ["tool order", f => { f.packages.usrLayout.tools.reverse(); }], ["tool unsigned decimal", f => { f.packages.usrLayout.tools[0]!.dev = "-1"; }],
    ["tool zero inode", f => { f.packages.usrLayout.tools[0]!.ino = "0"; }], ["tool oversize", f => { f.packages.usrLayout.tools[0]!.bytes = String(32 * 1024 * 1024 + 1); }],
    ["layout alias", f => { f.packages.usrLayout.aliases[0]!.target = "/tmp/bin"; }], ["layout prior kind", f => { f.packages.usrLayout.aliases[0]!.priorKind = "other"; }],
    ["layout moved sum", f => { f.packages.usrLayout.movedEntries = 1; }], ["symlink migration", f => { f.packages.usrLayout.aliases[0]!.movedEntries = 1; f.packages.usrLayout.movedEntries = 1; }],
    ["layout bytes", f => { f.packages.usrLayout.movedBytes = "01"; }], ["node version", f => { f.packages.pinnedNode.version = "v22.23.4"; }],
    ["node unsupported soname", f => { f.packages.pinnedNode.requirements[0]!.soname = "libnew.so.1"; }], ["node unsupported package", f => { f.packages.pinnedNode.requirements[0]!.package = "iproute2"; }],
    ["node unsafe soname", f => { f.packages.pinnedNode.requirements[0]!.soname = "../libc.so.6"; }], ["node digest join", f => { f.packages.pinnedNode.requirements[0]!.sha256 = other; }],
    ["node required packages", f => { f.packages.pinnedNode.requiredPackages.push("iproute2"); }], ["node duplicate requirement", f => { f.packages.pinnedNode.requirements.push(f.packages.pinnedNode.requirements[0]!); }],
    ["node missing loader", f => { f.packages.pinnedNode.requirements[1]!.soname = "libm.so.6"; }], ["alias schema", f => { f.aliases.schemaVersion = 2; }],
    ["alias order", f => { f.aliases.aliases.reverse(); }], ["alias duplicate", f => { f.aliases.aliases.push(f.aliases.aliases[0]!); }],
    ["layout edge absent", f => { f.aliases.aliases.shift(); }], ["layout edge target drift", f => { f.aliases.aliases[0]!.target = "tmp/bin"; }],
    ["alias above-root escape", f => { f.aliases.aliases.at(-1)!.target = "../../../../usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"; }],
    ["alias foreign root", f => { f.aliases.aliases.at(-1)!.target = "/tmp/ld-linux-x86-64.so.2"; }],
    ["alias unsafe bytes", f => { f.aliases.aliases.at(-1)!.target += "\n"; }], ["alias signed regular collision", f => { edge(f, loader, "libc.so.6"); }],
    ["unused alias missing signed terminal", f => { edge(f, lib + "unseen.so", "missing.so"); }],
    ["unused alias cycle", f => { edge(f, lib + "cycle1", "cycle2"); edge(f, lib + "cycle2", "cycle1"); }],
    ["loader resolves different signed ELF", f => { f.aliases.aliases.at(-1)!.target = "../lib/x86_64-linux-gnu/libc.so.6"; }],
  ];
  it.each(mutations)("refuses %s without selecting a path", (_name, mutate) => { const f = fixture(); mutate(f); expect(() => selected(f)).toThrow(); });

  it.each(["elf", "packages", "aliases"] as const)("rejects unknown fields throughout the %s schema", key => {
    const f = fixture(); const value = { ...f[key], unknown: true }; const bytes = { elf: encoded(f.elf), packages: encoded(f.packages), aliases: encoded(f.aliases), [key]: encoded(value) };
    expect(() => decode(bytes.elf, bytes.packages, bytes.aliases)).toThrow();
  });
  it.each([Buffer.from("{}"), Buffer.from("{}\n\n"), Buffer.from("{bad}\n"), Buffer.from('{"schemaVersion":1,"schemaVersion":1,"pins":[]}\n'), Buffer.alloc(256 * 1024 + 1), Buffer.from("\ufffd\n")])("refuses noncanonical, invalid or oversized bytes", bytes => {
    const f = fixture(); expect(() => decode(bytes, encoded(f.packages), encoded(f.aliases))).toThrow();
  });
  it.each(["/bin/ss", "/usr/bin/node", "/usr/bin/git", "/tmp/ss", "/usr/lib64/ld-linux-x86-64.so.2", "/usr/lib/x86_64-linux-gnu/../libc.so.6", lib + "../libc.so.6", lib + "nested/libc.so.6", lib + ".", lib + "..", lib + "libc.so.6\0"])("refuses unselected logical input %s", path => {
    expect(() => resolve(selected(), path)).toThrow();
  });
  it("refuses a selected-library logical name with no signed leaf", () => expect(() => resolve(selected(), lib + "missing.so")).toThrow());
  it("retains the original 4096 signed-row resolver limit rather than narrowing it to 1024", () => {
    const selection = selected(), signedElfs = [...selection.signedElfs];
    while (signedElfs.length < 4096) signedElfs.push({ path: "/usr/lib/vendor/p" + signedElfs.length, sha256: sha });
    expect(resolve({ ...selection, signedElfs }, loader).path).toBe(loader);
  });
  it("accepts exactly 1024 captured aliases within the original metadata byte budget", () => {
    const f = fixture(); for (let i = 0; f.aliases.aliases.length < 1024; i++) edge(f, lib + "p" + i, "libc.so.6");
    expect(encoded(f.aliases).length).toBeLessThan(256 * 1024); expect(selected(f).aliases).toHaveLength(1024);
  });
  it.each(["elf", "packages", "aliases"] as const)("enforces the authenticated metadata byte bound for %s", key => {
    const f = fixture(), bytes = { elf: encoded(f.elf), packages: encoded(f.packages), aliases: encoded(f.aliases), [key]: Buffer.alloc(256 * 1024 + 1) };
    expect(() => decode(bytes.elf, bytes.packages, bytes.aliases)).toThrow();
  });
  it.each(["pin", "package", "layout", "tool", "requirement", "alias"])("rejects a nested unknown %s field", kind => {
    const f = fixture(); let row: object;
    switch (kind) { case "pin": row = f.elf.pins[0]!; break; case "package": row = f.packages.packages[0]!; break;
      case "layout": row = f.packages.usrLayout; break; case "tool": row = f.packages.usrLayout.tools[0]!; break;
      case "requirement": row = f.packages.pinnedNode.requirements[0]!; break; default: row = f.aliases.aliases[0]!; }
    Object.assign(row, { expectedPolicy: "grant" }); expect(() => selected(f)).toThrow();
  });
  it("refuses oversized copied signed catalogue at the same resolver boundary", () => { const selection = selected(); expect(() => resolve({ ...selection, signedElfs: Array.from({ length: 4097 }, (_, i) => ({ path: lib + "p" + i, sha256: sha })) }, loader)).toThrow(); });
  it("refuses oversized copied alias catalogue", () => { const f = fixture(); for (let i = 0; i < 1021; i++) edge(f, lib + "p" + i, "libc.so.6"); expect(() => selected(f)).toThrow(); });
  it("validates copied requirement rows without treating the returned tuple as authority", () => { const selection = selected(); expect(() => resolve({ ...selection, nodeRequirements: [{ ...selection.nodeRequirements[0]!, package: "iproute2" }, selection.nodeRequirements[1]!] }, loader)).toThrow(); });
});
