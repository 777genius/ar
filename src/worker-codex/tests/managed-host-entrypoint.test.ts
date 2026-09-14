import { afterEach, describe, expect, it, vi } from "vitest";
import { assertManagedHostEntrypointAllowed, managedHostMarkerPath } from "../../managed-host-entrypoint";

describe("public managed host entrypoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["darwin", "win32"] as const)("keeps %s legacy without inspecting", platform => {
    const inspect = vi.fn();
    assertManagedHostEntrypointAllowed(platform, inspect);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("keeps an absent Linux marker legacy and propagates inspection failures", () => {
    assertManagedHostEntrypointAllowed("linux", () => { throw Object.assign(new Error(), { code: "ENOENT" }); });
    expect(() => assertManagedHostEntrypointAllowed("linux", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).toThrow("denied");
  });

  it("allows only the exact launcher null device", () => {
    const inspect = vi.fn(() => ({ rdev: 259, isCharacterDevice: () => true }));
    assertManagedHostEntrypointAllowed("linux", inspect);
    expect(inspect).toHaveBeenCalledWith(managedHostMarkerPath);
    expect(() => assertManagedHostEntrypointAllowed("linux", () => ({ rdev: 260, isCharacterDevice: () => true }))).toThrow("Host Jobs API");
  });

  it.each([0o100000, 0o100644, 0o120777, 0o040755])("refuses node mode %i despite forged environment", mode => {
    vi.stubEnv("SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH", "1");
    vi.stubEnv("SUBSCRIPTION_RUNTIME_JOB_ROOT", "/tmp/fake");
    expect(() => assertManagedHostEntrypointAllowed("linux", () => ({ mode, rdev: 259, isCharacterDevice: () => false }))).toThrow("Host Jobs API");
  });
});
