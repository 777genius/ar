import { describe, expect, it } from "vitest";
import { OriginalFullGitEntryKind as Kind, originalFullProjectControlGitEntryData } from "../../app-server/adapters/hosted-project-control-source-catalog";

const git = { path: "/usr/bin/git", kind: Kind.Regular, sha256: "a".repeat(64), size: 32, target: null, elf: true };
const directory = { path: "/usr/lib/git-core", kind: Kind.Directory, sha256: null, size: null, target: null, elf: false };

describe("copied original Git inventory data", () => {
  it("keeps an opaque script and a helper alias as copied facts", () => {
    const script = { path: "/usr/lib/git-core/git-sh-setup", kind: Kind.Regular,
      sha256: "b".repeat(64), size: 100, target: null, elf: false };
    const alias = { path: "/usr/lib/git-core/git-status", kind: Kind.Symlink,
      sha256: null, size: null, target: "../../bin/git", elf: false };
    const rows = [git, directory, script, alias];
    const data = originalFullProjectControlGitEntryData(rows);
    expect(data).toEqual(rows);
    expect(Object.isFrozen(data)).toBe(true);
    expect(data[2]).not.toBe(script);
    expect(Object.keys(data[2]!).sort()).toEqual(["elf", "kind", "path", "sha256", "size", "target"]);
  });

  it("refuses impossible entries and incomplete parent topology", () => {
    for (const rows of [
      [{ ...git, size: 4 }, directory],
      [git, directory, { ...directory, path: "/usr/lib/git-core/a/b" }],
      [git, directory, { ...directory, kind: "device", path: "/usr/lib/git-core/device" }],
      [git, directory, { ...directory, path: "/usr/lib/git-core/../outside" }],
      [git, directory, directory],
      [git, { ...directory, target: "unexpected" }],
      [directory],
    ]) expect(() => originalFullProjectControlGitEntryData(rows)).toThrow("hosted_full_backing_interval_held");
  });
});
