import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DependencyInstallArchitecture, DependencyLibcFamily, DependencyNpmLockName, DependencyToolRootKind } from "../../worker-core/dependency-environment/domain/dependency-install-key";
import type { HostedDependencyBinding } from "../../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyKeyInputsCurrent, readHostedDependencyKeyInputs, sameHostedDependencyKeyInputs } from "../hosted-dependency-materialization";
import { readHostedDependencyInstallerProfile, HostedDependencyInstallerRevision, type HostedDependencyInstallerProfile } from "../hosted-dependency-installer-recipe";
import { NpmInputCaptureReason, NpmInputCaptureStatus } from "../../worker-local/dependency-environment/capture-npm-install-inputs";

vi.mock("../hosted-dependency-installer-recipe", async original => ({
  ...await original<typeof import("../hosted-dependency-installer-recipe")>(), readHostedDependencyInstallerProfile: vi.fn(),
}));
const profile = (): HostedDependencyInstallerProfile => ({ schemaVersion: 1, recipeRevision: HostedDependencyInstallerRevision.NumericUidDropV2,
  nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127",
  platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  npmSha256: "b".repeat(64), npmVersion: "10.9.3", npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
  networkInputs: { hosts: "e".repeat(64), "resolv.conf": "f".repeat(64), "nsswitch.conf": "e".repeat(64) },
  privilegeDropper: { path: "/usr/bin/setpriv", sha256: "f".repeat(64), version: "2.39.3",
    libraries: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }] },
});
const pkg = { name: "input-wiring-TEST", version: "1.0.0" };
const lock = { ...pkg, lockfileVersion: 3, packages: { "": pkg } };
async function fixture() {
  vi.mocked(readHostedDependencyInstallerProfile).mockReturnValue(profile());
  const path = await realpath(await mkdtemp(join(tmpdir(), "hosted-key-inputs-TEST-")));
  await writeFile(join(path, "package.json"), JSON.stringify(pkg), { mode: 0o600 });
  await writeFile(join(path, "package-lock.json"), JSON.stringify(lock), { mode: 0o600 });
  await mkdir(join(path, "node_modules"));
  await writeFile(join(path, "node_modules", "authored-TEST-sentinel"), "original authored bytes", { mode: 0o600 });
  const info = await lstat(path, { bigint: true });
  const binding: HostedDependencyBinding = { version: 1, jobId: "TEST-input-wiring", jobRootDir: path,
    workspace: { canonicalPath: path, dev: String(info.dev), ino: String(info.ino) },
    installationId: "TEST-installation", runtimeSha: "a".repeat(40), grantDigest: "a".repeat(64) };
  return { path, binding, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// This boundary proves actual input-to-key mapping and synchronous content
// revalidation, not host grant/toolchain custody/Ready. Profile facts are fixed
// synthetic pins; filesystem inputs and preservation assertions are real.
describe.skipIf(process.platform !== "linux")("hosted selected-lock key input wiring", () => {
  it("uses exact selected shrinkwrap bytes/name and does not read a contradictory ignored lock", async () => {
    const f = await fixture();
    try {
      const packageOnly = await readHostedDependencyKeyInputs(f.binding);
      await writeFile(join(f.path, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2), { mode: 0o600 });
      await writeFile(join(f.path, "package-lock.json"), "malformed ignored TEST bytes");
      const selected = await readHostedDependencyKeyInputs(f.binding);
      expect(selected.lockName).toBe(DependencyNpmLockName.Shrinkwrap);
      expect(selected.lockBytes).toEqual(await readFile(join(f.path, "npm-shrinkwrap.json")));
      expect(selected.key.installKey).not.toBe(packageOnly.key.installKey);
      expect(JSON.parse(Buffer.from(selected.key.canonicalBytes).toString()).lock.name).toBe("npm-shrinkwrap.json");
      await writeFile(join(f.path, "package-lock.json"), "changed ignored bytes");
      expect(sameHostedDependencyKeyInputs(selected, await readHostedDependencyKeyInputs(f.binding))).toBe(true);
      expect(() => assertHostedDependencyKeyInputsCurrent(f.binding, selected)).not.toThrow();
      expect(await readFile(join(f.path, "node_modules", "authored-TEST-sentinel"), "utf8")).toBe("original authored bytes");
    } finally { await f.cleanup(); }
  });

  it("rejects malformed selected shrinkwrap with actionable sanitized facts and no fallback effects", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.path, "npm-shrinkwrap.json"), "{invalid TEST-private-content", { mode: 0o600 });
      await expect(readHostedDependencyKeyInputs(f.binding)).rejects.toMatchObject({ captureFailure: {
        status: NpmInputCaptureStatus.Unsupported, reason: NpmInputCaptureReason.InvalidInputs } });
      expect(await readFile(join(f.path, "package-lock.json"), "utf8")).toBe(JSON.stringify(lock));
      expect(await readFile(join(f.path, "node_modules", "authored-TEST-sentinel"), "utf8")).toBe("original authored bytes");
    } finally { await f.cleanup(); }
  });

  it("refuses changed current bytes or trusted tool pins after async capture before publication", async () => {
    const f = await fixture();
    try {
      const captured = await readHostedDependencyKeyInputs(f.binding);
      await writeFile(join(f.path, "package-lock.json"), JSON.stringify({ ...lock, version: "2.0.0" }));
      expect(() => assertHostedDependencyKeyInputsCurrent(f.binding, captured)).toThrow();
      await writeFile(join(f.path, "package-lock.json"), captured.lockBytes);
      vi.mocked(readHostedDependencyInstallerProfile).mockReturnValue({ ...profile(), nodeVersion: "v22.19.0" });
      expect(() => assertHostedDependencyKeyInputsCurrent(f.binding, captured)).toThrow();
      expect(await readFile(join(f.path, "node_modules", "authored-TEST-sentinel"), "utf8")).toBe("original authored bytes");
    } finally { await f.cleanup(); }
  });
});
