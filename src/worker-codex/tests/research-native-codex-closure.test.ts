import { host, local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { captureNativeCodex, nativeCodex, nativeCompanion, nativeUnrelated, nativeUnit } from "./fixtures/research-native-codex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { hostedCodexExecutableReadClosure, hostedCodexExecutableReadPath, hostedCodexPermissionProfilesToml } from "../../provider-codex/hosted-codex-permissions";
import { codexProviderApiEgressPolicy } from "../../provider-codex/codex-provider-egress-policy";
import { assertResearchProviderRoot, ResearchRootMountAccess } from "../research-provider-root";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const readClosure = (binary = nativeCodex) => hostedCodexExecutableReadClosure({ codexBinaryPath: binary, sourceEnv: {} });

describe("native Codex finite executable closure", () => {
  // Old file-only admission omits the helper that the installed native Codex
  // invokes beside itself. Permission and physical-root contracts both need it.
  it("admits only the native binary and authenticated companion in both profiles and root", () => {
    const f = captureNativeCodex(), closure = readClosure()!;
    expect(hostedCodexExecutableReadPath({ codexBinaryPath: nativeCodex, sourceEnv: {} })).toBe(nativeCodex);
    expect(closure.paths).toEqual([nativeCodex, nativeCompanion]);
    expect(closure.companion?.sha256).toBe(createHash("sha256").update(fs.readFileSync(nativeCompanion)).digest("hex"));
    const config = hostedCodexPermissionProfilesToml(codexProviderApiEgressPolicy(), closure.paths);
    for (const path of [nativeCodex, nativeCompanion]) {
      expect(config.match(new RegExp(JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ' = "read"', "g"))).toHaveLength(2);
    }
    expect(config).not.toContain(JSON.stringify(dirname(nativeCodex)) + ' = "read"');
    expect(config).not.toContain(nativeUnrelated);
    const plan = f.prepare();
    for (const path of [nativeCodex, nativeCompanion]) expect(plan.bindings.find(binding => binding.source === path)).toMatchObject({
      target: path, file: true, access: ResearchRootMountAccess.ReadOnly,
    });
    expect(plan.bindings.some(binding => binding.source === nativeUnrelated || binding.source === dirname(nativeCodex))).toBe(false);
    assertResearchProviderRoot(plan, f.spec, nativeUnit, f.home);
    expect(host.authReads).toBe(0);
  });

  it.each(["missing", "mode", "symlink", "hardlink", "owner", "ancestor", "wrong-target"] as const)(
    "rejects required native companion %s before root effects", async fault => {
      const binary = fault === "wrong-target" ? nativeCodex.replace("x86_64-unknown-linux-musl", "TEST-wrong-target") : nativeCodex;
      const f = captureNativeCodex(binary), companion = join(dirname(binary), "codex-code-mode-host");
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      if (fault === "missing") fs.unlinkSync(companion);
      if (fault === "mode") real.chmodSync(local(companion), 0o644);
      if (fault === "symlink") { fs.unlinkSync(companion); fs.symlinkSync("TEST-unrelated", companion); }
      if (fault === "hardlink") { fs.unlinkSync(companion); real.linkSync(local(join(dirname(binary), "TEST-unrelated")), local(companion)); }
      if (fault === "owner") host.foreign.add(companion);
      if (fault === "ancestor") real.chmodSync(local(dirname(binary)), 0o777);
      if (fault === "ancestor") expect(readClosure(binary)).toBeUndefined();
      else expect(() => readClosure(binary)).toThrow("hosted_codex_native_companion_invalid");
      host.spawn.mockClear();
      expect(() => f.prepare()).toThrow();
      expect(fs.existsSync(join(f.directory, "provider-roots"))).toBe(false);
      expect(host.spawn).not.toHaveBeenCalled(); expect(host.authReads).toBe(0);
    });

  it("does not let the legacy /usr read grant swallow a required companion failure", () => {
    const binary = nativeCodex.replace("/opt/TEST-codex", "/usr/lib/TEST-codex");
    const f = captureNativeCodex(binary);
    fs.unlinkSync(join(dirname(binary), "codex-code-mode-host"));
    expect(() => readClosure(binary)).toThrow("hosted_codex_native_companion_invalid");
    expect(() => f.prepare()).toThrow("hosted_codex_native_companion_invalid");
    expect(fs.existsSync(join(f.directory, "provider-roots"))).toBe(false);
  });

  it("preserves unrelated standalone codex and the public npm-wrapper read root", () => {
    captureNativeCodex("/opt/TEST-standalone/bin/codex");
    fs.unlinkSync("/opt/TEST-standalone/bin/codex-code-mode-host");
    expect(readClosure("/opt/TEST-standalone/bin/codex")?.paths).toEqual(["/opt/TEST-standalone/bin/codex"]);
    const binary = "/opt/TEST-node/lib/node_modules/@openai/codex/bin/codex.js";
    fs.mkdirSync(local(dirname(binary)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(binary, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(join(dirname(dirname(binary)), "package.json"), '{"name":"@openai/codex"}', { mode: 0o644 });
    const root = "/opt/TEST-node/lib/node_modules/@openai/codex";
    expect(hostedCodexExecutableReadPath({ codexBinaryPath: binary, sourceEnv: {} })).toBe(root);
    expect(readClosure(binary)).toEqual({ paths: [root] });
    expect(readClosure("/usr/bin/TEST-codex")).toBeUndefined();
  });
});
