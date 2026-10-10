import { local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { captureNativeCodex, nativeCodex, nativeCompanion, nativeUnrelated, nativeUnit } from "./fixtures/research-native-codex";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertResearchProviderRoot, ResearchRootMountAccess } from "../research-provider-root";

// Explicit hosted-only fixture: default unit CI has neither a privileged
// namespace contract nor bwrap. Missing native prerequisites are failures here.
beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
it("executes the sibling helper inside the physical admitted root without exposing another sibling", async () => {
  const f = captureNativeCodex(), plan = f.prepare();
  const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  expect(realFs.lstatSync(local(nativeCodex)).uid).toBe(0);
  expect(realFs.existsSync(local(nativeCompanion))).toBe(true);
  expect(realFs.existsSync(local(nativeUnrelated))).toBe(true);
  assertResearchProviderRoot(plan, f.spec, nativeUnit, f.home);
  const args = ["--unshare-all", "--die-with-parent", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
    "--ro-bind", local(plan.fixedRootDirectory), "/"];
  // Apply the production plan's materialized bindings. Only its fixed /usr
  // capability uses Host bytes; every other source belongs to this TEST tree.
  for (const binding of plan.bindings) args.push(
    binding.access === ResearchRootMountAccess.ReadOnly ? "--ro-bind" : "--bind",
    binding.source === "/usr" ? "/usr" : local(binding.source), binding.target,
  );
  args.push("--proc", "/proc", "--dev", "/dev", "--chdir", f.home, "--", nativeCodex);
  const child = realProcess.spawnSync("/usr/bin/bwrap", args, {
    env: { PATH: "/usr/bin:/bin" }, cwd: local(f.home), encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("TEST_NATIVE_COMPANION_READY\n");
  expect(child.stderr).toBe("");
  assertResearchProviderRoot(plan, f.spec, nativeUnit, f.home);
});
