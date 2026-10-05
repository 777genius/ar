import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, statfs, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DependencyInstallKeyError, DependencyInstallKeyFailure, DependencyNpmLockName,
  validateDependencyTestNpmInputs,
} from "../../worker-core/dependency-environment/domain/dependency-install-key";
import type { DependencyWorkspaceIdentity } from "../../worker-core/dependency-environment/domain/dependency-receipt";

export enum NpmInputCaptureStatus { Qualified = "qualified", Unsupported = "unsupported", Unknown = "unknown" }
export enum NpmInputCaptureReason {
  MissingPackage = "missing_package", MissingLock = "missing_lock", ProjectConfig = "project_config",
  UnsupportedClosure = "unsupported_closure", InvalidInputs = "invalid_inputs",
  InvalidRequest = "invalid_request", UnsupportedPlatform = "unsupported_platform", UnsafeInput = "unsafe_input",
  WorkspaceChanged = "workspace_changed", Unstable = "unstable", MountCrossing = "mount_crossing",
  Bounds = "bounds", Access = "access",
}
type CapturedFile = {
  readonly dev: string; readonly ino: string; readonly mode: string; readonly size: string;
  readonly mountId: string; readonly sha256: string;
};
export type NpmInstallInputCapture =
  | { readonly status: NpmInputCaptureStatus.Qualified; readonly workspace: DependencyWorkspaceIdentity;
      readonly lockName: DependencyNpmLockName; readonly packageBytes: Uint8Array; readonly lockBytes: Uint8Array;
      readonly packageFile: CapturedFile; readonly lockFile: CapturedFile; readonly closureDigest: string }
  | { readonly status: NpmInputCaptureStatus.Unsupported | NpmInputCaptureStatus.Unknown;
      readonly reason: NpmInputCaptureReason };
class CaptureFailure extends Error {
  constructor(readonly status: NpmInputCaptureStatus.Unsupported | NpmInputCaptureStatus.Unknown,
    readonly reason: NpmInputCaptureReason) { super(`npm_input_capture:${reason}`); }
}
function unknown(reason: NpmInputCaptureReason): never { throw new CaptureFailure(NpmInputCaptureStatus.Unknown, reason); }
function unsupported(reason: NpmInputCaptureReason): never { throw new CaptureFailure(NpmInputCaptureStatus.Unsupported, reason); }
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const child = (parent: FileHandle, name: string): string => `/proc/self/fd/${parent.fd}/${name}`;
const identity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => identity(a, b) && a.size === b.size &&
  a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
async function presence(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (code(error) === "ENOENT") return null; throw error; }
}
async function mountId(handle: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) unknown(NpmInputCaptureReason.UnsafeInput);
  return id;
}
type Anchor = { handle: FileHandle; info: BigIntStats; mount: string; parent?: FileHandle; name?: string };
type InputFile = Anchor & { bytes: Uint8Array; name: string; parent: FileHandle };

/** Factual, bounded Linux capture for the existing closed registry/no-scripts
 * TEST profile, restricted to lockfileVersion 3 inputs.
 * npm-shrinkwrap presence wins even when it is unsafe or unsupported. Ignored
 * package-lock content is never opened or hashed. No project config is read.
 * This snapshot does not establish admission, quiescence, tool pins or Ready;
 * the trusted consumer must hold exclusion and compare captures around effects.
 */
export async function captureNpmInstallInputs(input: {
  readonly workspacePath: string; readonly expectedWorkspace?: DependencyWorkspaceIdentity;
  /** Combined package + selected lock byte bound, matching the key builder. */
  readonly maxInputBytes: number; readonly maxDurationMs: number;
}): Promise<NpmInstallInputCapture> {
  const directories: Anchor[] = [];
  const files: InputFile[] = [];
  try {
    if (process.platform !== "linux") unknown(NpmInputCaptureReason.UnsupportedPlatform);
    if (!isAbsolute(input.workspacePath) || resolve(input.workspacePath) !== input.workspacePath ||
        input.workspacePath.includes("\0") || input.workspacePath.length > 4096 ||
        Buffer.from(input.workspacePath).toString() !== input.workspacePath ||
        !Number.isSafeInteger(input.maxInputBytes) || input.maxInputBytes <= 0 || input.maxInputBytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs <= 0) unknown(NpmInputCaptureReason.InvalidRequest);
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) unknown(NpmInputCaptureReason.UnsupportedPlatform);
    const started = performance.now();
    const check = (): void => { if (performance.now() - started > input.maxDurationMs) unknown(NpmInputCaptureReason.Bounds); };
    const retainDirectory = async (path: string, parent?: FileHandle, name?: string): Promise<Anchor> => {
      check();
      const handle = await open(path, directoryFlags);
      let retained = false;
      try {
        const anchor: Anchor = { handle, info: await handle.stat({ bigint: true }), mount: "",
          ...(parent ? { parent } : {}), ...(name ? { name } : {}) };
        directories.push(anchor);
        retained = true;
        anchor.mount = await mountId(handle);
        if (!anchor.info.isDirectory()) unknown(NpmInputCaptureReason.UnsafeInput);
        return anchor;
      } catch (error) { if (!retained) await handle.close(); throw error; }
    };
    let root = await retainDirectory("/");
    for (const name of input.workspacePath.split("/").filter(Boolean)) {
      root = await retainDirectory(child(root.handle, name), root.handle, name);
    }
    const workspace: DependencyWorkspaceIdentity = {
      canonicalPath: input.workspacePath, dev: String(root.info.dev), ino: String(root.info.ino),
    };
    if (input.expectedWorkspace && (input.expectedWorkspace.canonicalPath !== workspace.canonicalPath ||
        input.expectedWorkspace.dev !== workspace.dev || input.expectedWorkspace.ino !== workspace.ino)) {
      unknown(NpmInputCaptureReason.WorkspaceChanged);
    }
    const assertNoConfig = async (): Promise<void> => {
      check();
      if (await presence(child(root.handle, ".npmrc"))) unsupported(NpmInputCaptureReason.ProjectConfig);
    };
    await assertNoConfig();
    const packageInfo = await presence(child(root.handle, "package.json"));
    if (!packageInfo) unsupported(NpmInputCaptureReason.MissingPackage);
    const shrinkwrapInfo = await presence(child(root.handle, DependencyNpmLockName.Shrinkwrap));
    const lockName = shrinkwrapInfo ? DependencyNpmLockName.Shrinkwrap : DependencyNpmLockName.PackageLock;
    const lockInfo = shrinkwrapInfo ?? await presence(child(root.handle, lockName));
    if (!lockInfo) unsupported(NpmInputCaptureReason.MissingLock);
    if (packageInfo.size + lockInfo.size > BigInt(input.maxInputBytes)) unknown(NpmInputCaptureReason.Bounds);
    const captureFile = async (name: string, before: BigIntStats): Promise<InputFile> => {
      check();
      if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n) unknown(NpmInputCaptureReason.UnsafeInput);
      if (before.size <= 0n) unsupported(NpmInputCaptureReason.InvalidInputs);
      if (before.size > BigInt(input.maxInputBytes)) unknown(NpmInputCaptureReason.Bounds);
      const handle = await open(child(root.handle, name), fileFlags);
      const file: InputFile = { handle, info: before, mount: "", name, parent: root.handle, bytes: new Uint8Array() };
      files.push(file);
      if (!sameFile(before, await handle.stat({ bigint: true }))) unknown(NpmInputCaptureReason.Unstable);
      file.mount = await mountId(handle);
      if (file.mount !== root.mount) unknown(NpmInputCaptureReason.MountCrossing);
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        check();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!bytesRead) unknown(NpmInputCaptureReason.Unstable);
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead ||
          !sameFile(before, await handle.stat({ bigint: true }))) unknown(NpmInputCaptureReason.Unstable);
      file.bytes = bytes;
      return file;
    };
    const pkg = await captureFile("package.json", packageInfo);
    const lock = await captureFile(lockName, lockInfo);
    try { validateDependencyTestNpmInputs(pkg.bytes, lock.bytes); }
    catch (error) {
      if (error instanceof DependencyInstallKeyError) unsupported(error.reason === DependencyInstallKeyFailure.InvalidInputs
        ? NpmInputCaptureReason.InvalidInputs : NpmInputCaptureReason.UnsupportedClosure);
      throw error;
    }
    // Verify selection/config again, including newly created shrinkwrap. No
    // ignored package-lock identity or content belongs to this selected closure.
    await assertNoConfig();
    if (lockName === DependencyNpmLockName.PackageLock && await presence(child(root.handle, DependencyNpmLockName.Shrinkwrap))) {
      unknown(NpmInputCaptureReason.Unstable);
    }
    for (const file of files) {
      check();
      const current = await presence(child(file.parent, file.name));
      if (!current || !sameFile(file.info, current) || !sameFile(file.info, await file.handle.stat({ bigint: true }))) {
        unknown(NpmInputCaptureReason.Unstable);
      }
      const verify = await open(child(file.parent, file.name), fileFlags);
      try {
        if (!sameFile(file.info, await verify.stat({ bigint: true }))) unknown(NpmInputCaptureReason.Unstable);
        if (await mountId(verify) !== file.mount || await mountId(file.handle) !== file.mount) unknown(NpmInputCaptureReason.MountCrossing);
      } finally { await verify.close(); }
    }
    for (const anchor of directories) {
      check();
      if (!identity(anchor.info, await anchor.handle.stat({ bigint: true }))) unknown(NpmInputCaptureReason.WorkspaceChanged);
      if (await mountId(anchor.handle) !== anchor.mount) unknown(NpmInputCaptureReason.MountCrossing);
      if (anchor.parent && anchor.name) {
        const verify = await open(child(anchor.parent, anchor.name), directoryFlags);
        try {
          if (!identity(anchor.info, await verify.stat({ bigint: true }))) unknown(NpmInputCaptureReason.WorkspaceChanged);
          if (await mountId(verify) !== anchor.mount) unknown(NpmInputCaptureReason.MountCrossing);
        } finally { await verify.close(); }
      }
    }
    await assertNoConfig();
    if (lockName === DependencyNpmLockName.PackageLock && await presence(child(root.handle, DependencyNpmLockName.Shrinkwrap))) {
      unknown(NpmInputCaptureReason.Unstable);
    }
    check();
    const describe = (file: InputFile): CapturedFile => ({ dev: String(file.info.dev), ino: String(file.info.ino),
      mode: String(file.info.mode), size: String(file.info.size), mountId: file.mount, sha256: hash(file.bytes) });
    const packageFile = describe(pkg), lockFile = describe(lock);
    // Output-input digest stays separate from physical identity: inode metadata
    // detects drift but cannot perturb an unchanged npm installation key.
    const closureDigest = hash(Buffer.from(JSON.stringify({ version: 1, lockName,
      packageSha256: packageFile.sha256, lockSha256: lockFile.sha256 }) + "\n"));
    const packageBytes = Uint8Array.from(pkg.bytes), lockBytes = Uint8Array.from(lock.bytes);
    check();
    return { status: NpmInputCaptureStatus.Qualified, workspace, lockName, packageBytes,
      lockBytes, packageFile, lockFile, closureDigest };
  } catch (error) {
    if (error instanceof CaptureFailure) return { status: error.status, reason: error.reason };
    return { status: NpmInputCaptureStatus.Unknown, reason: ["ELOOP", "ENOTDIR"].includes(code(error) ?? "")
      ? NpmInputCaptureReason.UnsafeInput : NpmInputCaptureReason.Access };
  } finally {
    let closeFailed = false;
    for (const anchor of [...files, ...directories.slice().reverse()]) {
      try { await anchor.handle.close(); } catch { closeFailed = true; }
    }
    if (closeFailed) return { status: NpmInputCaptureStatus.Unknown, reason: NpmInputCaptureReason.Access };
  }
}
