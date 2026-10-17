import { describe, expect, it } from "vitest";
import { originalFullProjectControlToolAliasData } from "../../app-server/adapters/hosted-project-control-source-catalog";

describe("original signed-image alias data", () => {
  it("accepts the usrmerge lib64 loader alias alongside original root aliases", () => {
    const rows = [
      { path: "/lib64", target: "usr/lib64" },
      { path: "/usr/lib64/ld-linux-x86-64.so.2", target: "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" },
    ];
    const data = originalFullProjectControlToolAliasData(rows);
    expect(data).toEqual(rows);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data[0])).toBe(true);
    expect(data[0]).not.toBe(rows[0]);
  });

  it("still refuses traversal, duplicate paths and malformed alias rows", () => {
    for (const rows of [
      [{ path: "/usr/lib64/../bin/tool", target: "tool" }],
      [{ path: "/usr/lib64/./loader", target: "loader" }],
      [{ path: "/etc/loader", target: "loader" }],
      [{ path: "/lib64", target: "usr/lib64" }, { path: "/lib64", target: "usr/lib64" }],
      [{ path: "/lib64", target: "bad target" }],
      [{ path: "/lib64", target: "usr/lib64", extra: true }],
    ]) expect(() => originalFullProjectControlToolAliasData(rows)).toThrow("hosted_full_backing_interval_held");
  });
});
