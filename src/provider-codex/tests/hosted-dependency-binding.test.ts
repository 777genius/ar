import { describe, expect, it } from "vitest";
import { assertHostedDependencyBindingInventoryRevision, parseHostedDependencyBinding } from "../app-server/adapters/hosted-dependency-workspace";

// Closed serialized configuration only; this test never grants admission or
// substitutes for the actual installed-file/owner/namespace/native TEST gates.
const jobRootDir = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-binding";
const legacy = { version: 1, jobId: "TEST-binding", jobRootDir,
  workspace: { canonicalPath: `${jobRootDir}/workspace`, dev: "1", ino: "2" },
  installationId: "00000000-0000-0000-0000-000000000001", runtimeSha: "a".repeat(40), grantDigest: "b".repeat(64) };
const files = Array.from({ length: 7 }, (_, i) => ({ path: `/opt/test-runtime/leaf-${i}.js`, sha256: "c".repeat(64) }));
const toolProfile = { version: 1, profileId: "vite-vitest-config-free-v1", pins: { vite: "8.3.5", vitest: "4.1.12" },
  cache: { canonicalPath: `${jobRootDir}/tool-cache/vite-vitest-config-free-v1`, dev: "1", ino: "3" },
  node: { path: "/opt/test-node/bin/node", sha256: "d".repeat(64) }, helper: files[0], readonlyFiles: files,
  testFiles: ["value.test.ts"], optimizerDependencies: ["picocolors"], transformCache: "temporary" };
const registered = { ...legacy, version: 2, toolProfile };

describe("protected dependency binding closed revisions", () => {
  it("refuses legacy inventory for opted v2 while retaining v1 revision compatibility", () => {
    const v1 = parseHostedDependencyBinding(legacy), v2 = parseHostedDependencyBinding(registered);
    for (const revision of [2, 3]) {
      expect(() => assertHostedDependencyBindingInventoryRevision(v1, revision)).not.toThrow();
      expect(() => assertHostedDependencyBindingInventoryRevision(v2, revision)).toThrow();
    }
    for (const revision of [4, 5]) {
      expect(() => assertHostedDependencyBindingInventoryRevision(v1, revision)).not.toThrow();
      expect(() => assertHostedDependencyBindingInventoryRevision(v2, revision)).not.toThrow();
    }
    for (const revision of [1, 6, "4", undefined]) {
      expect(() => assertHostedDependencyBindingInventoryRevision(v1, revision)).toThrow();
      expect(() => assertHostedDependencyBindingInventoryRevision(v2, revision)).toThrow();
    }
  });
  it("preserves exact v1 and deeply freezes the strict v2 configuration", () => {
    expect(parseHostedDependencyBinding(legacy)).toEqual(legacy);
    const binding = parseHostedDependencyBinding(registered);
    expect(binding.version).toBe(2);
    if (binding.version !== 2) throw new Error("missing v2");
    expect(Object.isFrozen(binding.toolProfile)).toBe(true);
    expect(Object.isFrozen(binding.toolProfile.readonlyFiles)).toBe(true);
    expect(Object.isFrozen(binding.toolProfile.cache)).toBe(true);
    expect(binding.toolProfile.transformCache).toBe("temporary");
  });
  it("denies v1 capability smuggling, unknown fields/revisions and unregistered v2", () => {
    for (const invalid of [{ ...legacy, toolProfile }, { ...registered, pid: 1 }, { ...legacy, version: 2 },
      { ...registered, version: 3 }, { ...registered, toolProfile: { ...toolProfile, mount: "/" } }]) {
      expect(() => parseHostedDependencyBinding(invalid)).toThrow();
    }
  });
  it("denies a sibling cache, altered tool pin and a non-seven closure", () => {
    for (const changed of [{ ...toolProfile, cache: { ...toolProfile.cache, canonicalPath: `${jobRootDir}/tool-cache` } },
      { ...toolProfile, pins: { vite: "8.3.4", vitest: "4.1.12" } }, { ...toolProfile, readonlyFiles: files.slice(0, 6) }]) {
      expect(() => parseHostedDependencyBinding({ ...registered, toolProfile: changed })).toThrow();
    }
  });
});
