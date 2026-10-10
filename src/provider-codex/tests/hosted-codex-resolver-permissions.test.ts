import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedCodexPermissionProfilesToml, hostedCodexResolverReadPaths } from "../hosted-codex-permissions";
import { codexProviderApiEgressPolicy } from "../codex-provider-egress-policy";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), realpathSync: vi.fn(actual.realpathSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const hosted = { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
const target = "/run/systemd/resolve/stub-resolv.conf";
let root: string;
function resolverFixture(mode = 0o444): void {
  const leaf = join(root, "resolver");
  actual.writeFileSync(leaf, "nameserver 127.0.0.53\n", { mode });
  actual.chmodSync(leaf, mode);
  actual.symlinkSync(leaf, join(root, "resolv.conf"));
  // Translate absolute guest paths to a disposable fixture. Its symlink/file
  // types and modes come from the real filesystem, with no credential reads.
  vi.mocked(lstatSync).mockImplementation(path => actual.lstatSync(
    path === "/etc/resolv.conf" ? join(root, "resolv.conf") : path === target ? leaf : path,
  ));
  vi.mocked(realpathSync).mockImplementation(path => path === "/etc/resolv.conf" || path === target
    ? target : actual.realpathSync(path));
}
beforeEach(() => {
  root = actual.mkdtempSync(join(tmpdir(), "hosted-resolver-TEST-"));
  vi.mocked(lstatSync).mockReset();
  vi.mocked(realpathSync).mockReset();
});
afterEach(() => { actual.rmSync(root, { recursive: true, force: true }); });

describe("hosted resolver leaf admission", () => {
  it("admits a trusted native resolver leaf in both root-deny profiles", () => {
    resolverFixture();
    const resolveStat = (path: Parameters<typeof lstatSync>[0]) => actual.lstatSync(
      path === target ? join(root, "resolver") : join(root, "resolv.conf"),
    );
    vi.mocked(lstatSync).mockImplementation(path => {
      const stat = path === target || path === "/etc/resolv.conf"
        ? resolveStat(path) : actual.lstatSync(root);
      return Object.assign(stat, { uid: 0 });
    });
    const paths = hostedCodexResolverReadPaths({}, true);
    expect(paths).toEqual([target]);
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, undefined, undefined, paths);
    expect(config.match(/"\/run\/systemd\/resolve\/stub-resolv.conf" = "read"/g)).toHaveLength(2);
    expect(config.match(/":root" = "deny"/g)).toHaveLength(2);
    expect(config).not.toContain('"/run" = "read"');
    vi.mocked(lstatSync).mockImplementation(path => Object.assign(
      path === target || path === "/etc/resolv.conf" ? resolveStat(path) : actual.lstatSync(root),
      { uid: path === "/run/systemd/resolve" ? 1000 : 0 },
    ));
    expect(() => hostedCodexResolverReadPaths({}, true)).toThrow("hosted_permission_resolver_custody_invalid");
  });
  it.each([0o444, 0o644])("admits only the selected public resolver in both profiles (mode %s)", mode => {
    resolverFixture(mode);
    const paths = hostedCodexResolverReadPaths(hosted);
    expect(paths).toEqual([target]);
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, undefined, undefined, paths);
    expect(config.match(/"\/run\/systemd\/resolve\/stub-resolv.conf" = "read"/g)).toHaveLength(2);
    expect(config).not.toContain('"/run" = "read"');
    expect(config).not.toContain('"/run/systemd/resolve" = "read"');
    expect(config).not.toContain('"/run/systemd/resolve/resolv.conf" = "read"');
    expect(config.match(/":root" = "deny"/g)).toHaveLength(2);
    expect(config.match(/"\/etc\/subscription-runtime\/secrets" = "deny"/g)).toHaveLength(2);
  });
  it("rejects a private symlink before observing its target", () => {
    resolverFixture();
    const privateLeaf = join(root, "private");
    actual.writeFileSync(privateLeaf, "TEST sentinel only");
    actual.unlinkSync(join(root, "resolv.conf"));
    actual.symlinkSync(privateLeaf, join(root, "resolv.conf"));
    vi.mocked(realpathSync).mockImplementation(path => {
      const observed = actual.realpathSync(path === "/etc/resolv.conf" ? join(root, "resolv.conf") : path);
      return observed === privateLeaf ? "/etc/subscription-runtime/secrets/private" : observed;
    });
    expect(() => hostedCodexResolverReadPaths(hosted)).toThrow("hosted_permission_resolver_path_invalid");
    expect(vi.mocked(lstatSync).mock.calls.map(call => call[0])).toEqual(["/etc/resolv.conf"]);
    expect(() => hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, undefined, undefined,
      ["/etc/subscription-runtime/secrets/private"])).toThrow("hosted_permission_resolver_path_invalid");
  });
  it("rejects writable resolver leaves", () => {
    resolverFixture(0o666);
    expect(() => hostedCodexResolverReadPaths(hosted)).toThrow("hosted_permission_resolver_custody_invalid");
  });
  it("normalizes a missing or dangling resolver to a finite denial", () => {
    vi.mocked(lstatSync).mockImplementation(() => { throw new Error("untrusted filesystem failure"); });
    expect(() => hostedCodexResolverReadPaths(hosted)).toThrow("hosted_permission_resolver_unavailable");
    resolverFixture();
    vi.mocked(realpathSync).mockImplementation(() => { throw new Error("untrusted filesystem failure"); });
    expect(() => hostedCodexResolverReadPaths(hosted)).toThrow("hosted_permission_resolver_unavailable");
  });
  it("does not observe the host resolver outside the hosted guard", () => {
    expect(hostedCodexResolverReadPaths({})).toEqual([]);
    expect(lstatSync).not.toHaveBeenCalled();
    expect(realpathSync).not.toHaveBeenCalled();
  });
  it("keeps a regular /etc resolver inside the existing minimal read root", () => {
    actual.writeFileSync(join(root, "resolv.conf"), "nameserver 127.0.0.53\n");
    vi.mocked(lstatSync).mockReturnValue(actual.lstatSync(join(root, "resolv.conf")));
    expect(hostedCodexResolverReadPaths(hosted)).toEqual([]);
    expect(realpathSync).not.toHaveBeenCalled();
  });
});
