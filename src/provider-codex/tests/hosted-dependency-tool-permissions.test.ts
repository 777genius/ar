import { describe, expect, it } from "vitest";
import { hostedCodexPermissionProfilesToml } from "../hosted-codex-permissions";
import { codexProviderApiEgressPolicy } from "../codex-provider-egress-policy";
import { parseDependencyToolGuestConfig } from "../../core/dependency-environment/dependency-tool-profile";

// Configuration only. These tests do not construct or assert runtime admission.
const job = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-tools";
const files = ["helper", "schema", "hook", "hook-policy", "parser", "scan-policy"].map(name => ({
  path: `/opt/subscription-runtime/release/dist/${name}.js`, sha256: "a".repeat(64),
}));
files.push({ path: "/opt/subscription-runtime/release/package.json", sha256: "c".repeat(64) });
const config = parseDependencyToolGuestConfig({ version: 1,
  workspace: { canonicalPath: `${job}/workspace`, dev: "1", ino: "2" }, tree: { dev: "1", ino: "3" },
  profile: { version: 1, profileId: "vite-vitest-config-free-v1", pins: { vite: "8.3.5", vitest: "4.1.12" },
    testFiles: ["value.test.ts"], optimizerDependencies: ["picocolors"], transformCache: "persisted",
    cache: { canonicalPath: `${job}/tool-cache/vite-vitest-config-free-v1`, dev: "1", ino: "4" },
    node: { path: "/opt/node/bin/node", sha256: "b".repeat(64) }, helper: files[0], readonlyFiles: files } });

function section(configToml: string, name: string): ReadonlyMap<string, string> {
  const header = `[${name}]\n`, index = configToml.indexOf(header);
  expect(index).toBeGreaterThanOrEqual(0);
  const body = configToml.slice(index + header.length).split("\n[")[0]!;
  return new Map(body.split("\n").filter(line => /^"/.test(line)).map(line => {
    const [key, value] = line.split(" = ");
    return [JSON.parse(key!), JSON.parse(value!)] as [string, string];
  }));
}
describe("actual named dependency tool permission config", () => {
  it("keeps dependencies read-only in both profiles while exposing only the private cache leaf", () => {
    const toml = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, undefined, config);
    for (const name of ["hosted-project-read", "hosted-project-write"]) {
      const absolute = section(toml, `permissions.${name}.filesystem`);
      expect(absolute.get(`${job}/workspace/node_modules`)).toBe("read");
      expect(absolute.get(config.profile.cache.canonicalPath)).toBe("write");
      expect([...absolute].filter(([, access]) => access === "write")).toEqual([[config.profile.cache.canonicalPath, "write"]]);
      expect(absolute.has(job)).toBe(false);
      expect(absolute.has(`${job}/tool-cache`)).toBe(false);
      expect(absolute.has("/opt/subscription-runtime")).toBe(false);
      for (const file of files) expect(absolute.get(file.path)).toBe("read");
      const workspace = section(toml, `permissions.${name}.filesystem.":workspace_roots"`);
      expect(workspace.get("node_modules")).toBe("read");
      expect(workspace.get(".")).toBe(name === "hosted-project-write" ? "write" : "read");
    }
  });
  it("rejects a sibling cache grant and leaves unregistered profiles unchanged", () => {
    const sibling = { ...config, profile: { ...config.profile, cache: { ...config.profile.cache, canonicalPath: `${job}/sibling` } } };
    expect(() => hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), undefined, undefined, sibling)).toThrow("hosted_permission_tool_layout_invalid");
    const plain = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy());
    expect(plain).not.toContain("tool-cache"); expect(plain).not.toContain('"node_modules" = "read"');
  });
});
