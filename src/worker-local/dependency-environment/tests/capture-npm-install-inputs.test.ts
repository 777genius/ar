import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DependencyInstallArchitecture, DependencyLibcFamily, DependencyNpmLockName, DependencyToolRootKind,
  type DependencyTestNpmToolchain,
} from "../../../worker-core/dependency-environment/domain/dependency-install-key";
import { buildTestNpmDependencyInstallKey } from "../build-test-npm-dependency-install-key";
import { captureNpmInstallInputs, revalidateNpmInstallInputs, NpmInputCaptureReason as Reason, NpmInputCaptureStatus as Status,
  type NpmInstallInputCapture } from "../capture-npm-install-inputs";

// Mutable module wrapper permits a deterministic real-FS race barrier. All
// reads/opens/stats remain the actual implementation; no authority is mocked.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const pkg = { name: "capture-TEST", version: "1.0.0", dependencies: { sample: "1.0.0" } };
const lock = { name: "capture-TEST", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
  "": { name: "capture-TEST", version: "1.0.0", dependencies: { sample: "1.0.0" } },
  "node_modules/sample": { version: "1.0.0", resolved: "https://registry.npmjs.org/sample/-/sample-1.0.0.tgz",
    integrity: `sha512-${"A".repeat(86)}==` },
} };
const bounds = { maxInputBytes: 16384, maxDurationMs: 10000 };
const toolchain: DependencyTestNpmToolchain = {
  nodePath: "/opt/node/bin/node", nodeSha256: "a".repeat(64), nodeVersion: "v22.18.0", nodeAbi: "127",
  platform: "linux", arch: DependencyInstallArchitecture.X64, npmCliPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
  npmSha256: "b".repeat(64), npmVersion: "10.9.3", npmRootPath: "/opt/node/lib/node_modules/npm", npmRootSha256: "c".repeat(64),
  libc: { family: DependencyLibcFamily.Glibc, version: "2.36", path: "/usr/lib/libc.so.6", sha256: "d".repeat(64) },
  toolRoots: [{ path: "/usr/lib/libc.so.6", sha256: "d".repeat(64), kind: DependencyToolRootKind.File }],
};
function qualified(value: NpmInstallInputCapture) {
  expect(value.status).toBe(Status.Qualified);
  if (value.status !== Status.Qualified) throw new Error("TEST expected qualified inputs");
  return value;
}
function key(value: ReturnType<typeof qualified>): string {
  return buildTestNpmDependencyInstallKey({ packageBytes: value.packageBytes, lockBytes: value.lockBytes,
    lockName: value.lockName, toolchain, maxInputBytes: bounds.maxInputBytes, maxCanonicalBytes: 16384 }).installKey;
}
async function fixture() {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "npm-input-capture-TEST-")));
  const packagePath = join(path, "package.json"), packageLock = join(path, DependencyNpmLockName.PackageLock);
  const shrinkwrap = join(path, DependencyNpmLockName.Shrinkwrap);
  await fs.writeFile(packagePath, encode(pkg), { mode: 0o600 });
  await fs.writeFile(packageLock, encode(lock), { mode: 0o600 });
  return { path, packagePath, packageLock, shrinkwrap,
    capture: () => captureNpmInstallInputs({ workspacePath: path, ...bounds }),
    cleanup: () => fs.rm(path, { recursive: true, force: true }) };
}

// Regressions fail if precedence is reversed, unsupported shrinkwrap falls
// back, bytes escape on rejection, or actual FD/path drift yields a key.
describe.skipIf(process.platform !== "linux")("closed npm input capture", () => {
  it("selects shrinkwrap over a contradictory package-lock and ignores the latter's bytes", async () => {
    const f = await fixture();
    try {
      const packageOnly = qualified(await f.capture());
      const selected = Buffer.from(JSON.stringify(lock, null, 2));
      await fs.writeFile(f.shrinkwrap, selected, { mode: 0o600 });
      await fs.writeFile(f.packageLock, "invalid ignored TEST lock");
      const before = qualified(await f.capture());
      expect(before.lockName).toBe(DependencyNpmLockName.Shrinkwrap);
      expect(Buffer.from(before.lockBytes)).toEqual(selected);
      expect(before.lockFile.sha256).toBe(createHash("sha256").update(selected).digest("hex"));
      expect(key(before)).not.toBe(key(packageOnly));
      await fs.writeFile(f.packageLock, "different ignored TEST bytes");
      const after = qualified(await f.capture());
      expect(after.closureDigest).toBe(before.closureDigest);
      expect(key(after)).toBe(key(before));
      // Returned copies cannot be changed by subsequent source writes.
      await fs.writeFile(f.shrinkwrap, encode(lock));
      const changed = qualified(await f.capture());
      expect(changed.closureDigest).not.toBe(before.closureDigest);
      expect(key(changed)).not.toBe(key(before));
      expect(Buffer.from(before.lockBytes)).toEqual(selected);
    } finally { await f.cleanup(); }
  });

  it.each(["malformed", "old lock version", "local dependency", "install script", "credential"])(
    "never falls back from selected %s shrinkwrap or returns rejected bytes", async (scenario) => {
      const f = await fixture();
      try {
        const entry = lock.packages["node_modules/sample"];
        const candidate = scenario === "malformed" ? Buffer.from("{broken TEST shrinkwrap")
          : scenario === "old lock version" ? encode({ ...lock, lockfileVersion: 2 })
          : encode({ ...lock, packages: { ...lock.packages, "node_modules/sample": { ...entry,
            ...(scenario === "local dependency" ? { resolved: "file:../outside-TEST" }
              : scenario === "install script" ? { hasInstallScript: true }
              : { resolved: "https://TEST-secret@registry.npmjs.org/sample/-/sample.tgz" }) } } });
        await fs.writeFile(f.shrinkwrap, candidate, { mode: 0o600 });
        const result = await f.capture();
        expect(result).toEqual({ status: Status.Unsupported,
          reason: scenario === "malformed" ? Reason.InvalidInputs : Reason.UnsupportedClosure });
        expect(JSON.stringify(result)).not.toContain("TEST-secret");
        expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
        expect(await fs.readFile(f.shrinkwrap)).toEqual(candidate);
      } finally { await f.cleanup(); }
    });

  it("refuses selected symlinks and hardlinks while preserving the external sentinel", async () => {
    const f = await fixture();
    try {
      const sentinel = join(f.path, "external-TEST-sentinel");
      await fs.writeFile(sentinel, encode(lock), { mode: 0o600 });
      await fs.symlink(sentinel, f.shrinkwrap);
      expect(await f.capture()).toEqual({ status: Status.Unknown, reason: Reason.UnsafeInput });
      expect(await fs.readlink(f.shrinkwrap)).toBe(sentinel);
      await fs.rm(f.shrinkwrap);
      await fs.link(sentinel, f.shrinkwrap);
      expect(await f.capture()).toEqual({ status: Status.Unknown, reason: Reason.UnsafeInput });
      expect(await fs.readFile(sentinel)).toEqual(encode(lock));
      expect((await fs.lstat(sentinel)).nlink).toBe(2);
      expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
    } finally { await f.cleanup(); }
  });

  it("denies project config without reading it, and missing inputs without filesystem effects", async () => {
    const f = await fixture();
    try {
      const config = join(f.path, ".npmrc");
      // A directory cannot be read as ordinary config bytes; presence alone vetoes.
      await fs.mkdir(config, { mode: 0o700 });
      await fs.writeFile(join(config, "TEST-sentinel"), "private config sentinel", { mode: 0o600 });
      expect(await f.capture()).toEqual({ status: Status.Unsupported, reason: Reason.ProjectConfig });
      expect(await fs.readFile(join(config, "TEST-sentinel"), "utf8")).toBe("private config sentinel");
      await fs.rm(config, { recursive: true });
      await fs.rm(f.packageLock);
      expect(await f.capture()).toEqual({ status: Status.Unsupported, reason: Reason.MissingLock });
      expect(await fs.readdir(f.path)).toEqual(["package.json"]);
      await fs.rm(f.packagePath);
      expect(await f.capture()).toEqual({ status: Status.Unsupported, reason: Reason.MissingPackage });
      expect(await fs.readdir(f.path)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("refuses unsafe modes, input bounds and a symlinked ancestor", async () => {
    const f = await fixture();
    try {
      await fs.chmod(f.packageLock, 0o666);
      expect(await f.capture()).toEqual({ status: Status.Unknown, reason: Reason.UnsafeInput });
      await fs.chmod(f.packageLock, 0o600);
      expect(await captureNpmInstallInputs({ workspacePath: f.path, ...bounds, maxInputBytes: 1 }))
        .toEqual({ status: Status.Unknown, reason: Reason.Bounds });
      await fs.symlink(f.path, join(f.path, "alias"));
      expect(await captureNpmInstallInputs({ workspacePath: join(f.path, "alias"), ...bounds }))
        .toEqual({ status: Status.Unknown, reason: Reason.UnsafeInput });
      expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
    } finally { await f.cleanup(); }
  });

  it("matches the physical workspace rather than accepting a replaced root at the same path", async () => {
    const f = await fixture();
    const held = `${f.path}-original`;
    try {
      const before = qualified(await f.capture());
      await fs.rename(f.path, held);
      await fs.mkdir(f.path, { mode: 0o700 });
      await fs.writeFile(f.packagePath, encode(pkg), { mode: 0o600 });
      await fs.writeFile(f.packageLock, encode(lock), { mode: 0o600 });
      expect(await captureNpmInstallInputs({ workspacePath: f.path, ...bounds, expectedWorkspace: before.workspace }))
        .toEqual({ status: Status.Unknown, reason: Reason.WorkspaceChanged });
      expect(await fs.readFile(join(held, "package.json"))).toEqual(encode(pkg));
      expect(await fs.readFile(f.packagePath)).toEqual(encode(pkg));
      expect((await fs.lstat(held, { bigint: true })).ino).not.toBe((await fs.lstat(f.path, { bigint: true })).ino);
    } finally { await f.cleanup(); await fs.rm(held, { recursive: true, force: true }); }
  });

  it("bounds the combined selected bytes even when each valid file fits individually", async () => {
    const f = await fixture();
    try {
      const packageBytes = await fs.readFile(f.packagePath), lockBytes = await fs.readFile(f.packageLock);
      const maxInputBytes = Math.max(packageBytes.length, lockBytes.length);
      expect(packageBytes.length + lockBytes.length).toBeGreaterThan(maxInputBytes);
      expect(await captureNpmInstallInputs({ workspacePath: f.path, ...bounds, maxInputBytes }))
        .toEqual({ status: Status.Unknown, reason: Reason.Bounds });
      expect(await fs.readFile(f.packagePath)).toEqual(packageBytes);
      expect(await fs.readFile(f.packageLock)).toEqual(lockBytes);
      expect(qualified(await f.capture()).lockBytes).toEqual(Uint8Array.from(lockBytes));
    } finally { await f.cleanup(); }
  });

  it("revalidates current bytes and refuses same-inode same-size mutation despite restored mtime", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.shrinkwrap, encode(lock), { mode: 0o600 });
      const captured = qualified(await f.capture()), old = await fs.lstat(f.shrinkwrap);
      const check = () => revalidateNpmInstallInputs({ capture: captured, maxDurationMs: bounds.maxDurationMs });
      expect(check()).toEqual({ status: Status.Qualified });
      const changed = Buffer.from(captured.lockBytes);
      const offset = changed.indexOf(Buffer.from('"version":"1.0.0"'));
      expect(offset).toBeGreaterThanOrEqual(0);
      changed[offset + '"version":"'.length] = "2".charCodeAt(0);
      await fs.writeFile(f.shrinkwrap, changed);
      await fs.utimes(f.shrinkwrap, old.atime, old.mtime);
      expect((await fs.lstat(f.shrinkwrap)).ino).toBe(old.ino);
      expect((await fs.lstat(f.shrinkwrap)).size).toBe(old.size);
      expect(check()).toEqual({ status: Status.Unknown, reason: Reason.Unstable });
      expect(await fs.readFile(f.shrinkwrap)).toEqual(changed);
      expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
    } finally { await f.cleanup(); }
  });

  it.each(["selection", "config", "replacement"])("final synchronous check refuses %s without modifying source", async (scenario) => {
    const f = await fixture();
    try {
      const captured = qualified(await f.capture());
      if (scenario === "selection") await fs.writeFile(f.shrinkwrap, encode(lock), { mode: 0o600 });
      if (scenario === "config") await fs.writeFile(join(f.path, ".npmrc"), "TEST-private-config", { mode: 0o600 });
      if (scenario === "replacement") {
        await fs.rename(f.packageLock, join(f.path, "original-TEST-lock"));
        await fs.writeFile(f.packageLock, encode(lock), { mode: 0o600 });
      }
      expect(revalidateNpmInstallInputs({ capture: captured, maxDurationMs: bounds.maxDurationMs })).toEqual(scenario === "config"
        ? { status: Status.Unsupported, reason: Reason.ProjectConfig } : { status: Status.Unknown, reason: Reason.Unstable });
      expect(await fs.readFile(f.packagePath)).toEqual(encode(pkg));
      expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
      if (scenario === "replacement") expect(await fs.readFile(join(f.path, "original-TEST-lock"))).toEqual(encode(lock));
    } finally { await f.cleanup(); }
  });

  it("final selected shrinkwrap check ignores an unselected external symlink", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.shrinkwrap, encode(lock), { mode: 0o600 });
      const captured = qualified(await f.capture());
      const sentinel = join(f.path, "external-TEST-secret");
      await fs.writeFile(sentinel, "private TEST sentinel", { mode: 0o600 });
      await fs.rm(f.packageLock); await fs.symlink(sentinel, f.packageLock);
      expect(revalidateNpmInstallInputs({ capture: captured, maxDurationMs: bounds.maxDurationMs })).toEqual({ status: Status.Qualified });
      expect(await fs.readlink(f.packageLock)).toBe(sentinel);
      expect(await fs.readFile(sentinel, "utf8")).toBe("private TEST sentinel");
      expect(qualified(await f.capture()).closureDigest).toBe(captured.closureDigest);
    } finally { await f.cleanup(); }
  });

  it.each(["shrinkwrap", "config"])("refuses newly created %s selection/config membership during capture", async (scenario) => {
    const f = await fixture();
    const actualOpen = fs.open;
    let created = false;
    try {
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await actualOpen(...args);
        if (!created && String(args[0]).endsWith(`/${DependencyNpmLockName.PackageLock}`)) {
          created = true;
          await fs.writeFile(scenario === "shrinkwrap" ? f.shrinkwrap : join(f.path, ".npmrc"),
            scenario === "shrinkwrap" ? encode(lock) : "TEST-private-config", { mode: 0o600 });
        }
        return handle;
      });
      try {
        expect(await f.capture()).toEqual(scenario === "shrinkwrap"
          ? { status: Status.Unknown, reason: Reason.Unstable }
          : { status: Status.Unsupported, reason: Reason.ProjectConfig });
        expect(created).toBe(true);
        expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
        expect(await fs.readFile(scenario === "shrinkwrap" ? f.shrinkwrap : join(f.path, ".npmrc")))
          .toEqual(scenario === "shrinkwrap" ? encode(lock) : Buffer.from("TEST-private-config"));
      } finally { spy.mockRestore(); }
    } finally { await f.cleanup(); }
  });

  it("detects a real selected-file mutation after opening its retained FD", async () => {
    const f = await fixture();
    const actualOpen = fs.open;
    let mutated = false;
    try {
      await fs.writeFile(f.shrinkwrap, encode(lock), { mode: 0o600 });
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await actualOpen(...args);
        if (!mutated && String(args[0]).endsWith(`/${DependencyNpmLockName.Shrinkwrap}`)) {
          mutated = true;
          await fs.appendFile(f.shrinkwrap, " ");
        }
        return handle;
      });
      try {
        expect(await f.capture()).toEqual({ status: Status.Unknown, reason: Reason.Unstable });
        expect(mutated).toBe(true);
        expect(await fs.readFile(f.shrinkwrap)).toEqual(Buffer.concat([encode(lock), Buffer.from(" ")]));
        expect(await fs.readFile(f.packageLock)).toEqual(encode(lock));
      } finally { spy.mockRestore(); }
      expect(qualified(await f.capture()).lockName).toBe(DependencyNpmLockName.Shrinkwrap);
    } finally { await f.cleanup(); }
  });
});
