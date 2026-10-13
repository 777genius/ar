import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { readHostedMimoCredentialAtPath, resolveHostedMimoCodingProxyCredential } from "../hosted-mimo-credential-source";
import type { HostedMimoCodingWorkerOrigin } from "../hosted-mimo-worker-origin";

const originFence = vi.hoisted(() => ({ current: vi.fn(), pathReads: 0 }));
vi.mock("../hosted-mimo-worker-origin", () => ({
  assertHostedMimoCodingWorkerOriginCurrent: originFence.current,
  readHostedMimoWorkerOrigin: () => null,
}));

const syntheticOwner = vi.hoisted(() => ({ root: "", ancestorUid: 0, fileUid: 0 }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (path: string) => {
      originFence.pathReads++;
      const stat = fs.lstatSync(path);
      const ancestor = syntheticOwner.root !== "" &&
        syntheticOwner.root.startsWith(path.endsWith("/") ? path : `${path}/`);
      const within = syntheticOwner.root !== "" &&
        (path === syntheticOwner.root || path.startsWith(`${syntheticOwner.root}/`));
      return ancestor || within
        ? Object.assign(stat, { uid: syntheticOwner.ancestorUid,
          mode: ancestor ? stat.mode & ~0o022 : stat.mode })
        : stat;
    },
    fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { uid: syntheticOwner.fileUid }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  syntheticOwner.root = "";
  syntheticOwner.ancestorUid = 0;
  syntheticOwner.fileUid = 0;
  originFence.current.mockReset();
  originFence.pathReads = 0;
});

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".synthetic-mimo-source-"));
  // Keep real symlink, mode, link, size and rotation behavior; only synthetic
  // ownership and checkout ancestry metadata are normalized for user CI.
  syntheticOwner.root = directory;
  directories.push(directory);
  const path = join(directory, "key");
  await writeFile(path, "synthetic-token-a\n", { mode: 0o600 });
  return { directory, path };
}

describe("hosted MiMo credential filesystem boundary", () => {
  it("does not inspect the credential path after its origin check closes the original lifetime", () => {
    let active = true;
    originFence.current.mockImplementationOnce(() => { active = false; });
    const assertActive = () => { if (!active) throw new Error("TEST-original-expired"); };
    expect(() => resolveHostedMimoCodingProxyCredential({} as HostedMimoCodingWorkerOrigin,
      new DefaultRedactor(), assertActive)).toThrow("TEST-original-expired");
    expect(originFence.pathReads).toBe(0);
  });
  it("opens the rotated file afresh and registers each synthetic value before returning it", async () => {
    // Regression: caching the first open or registering redaction after return
    // exposes the old key or a downstream error string.
    const { directory, path } = await fixture();
    const redactor = new DefaultRedactor();
    expect(readHostedMimoCredentialAtPath(path, redactor)).toBe("synthetic-token-a");
    const replacement = join(directory, "next-key");
    await writeFile(replacement, "synthetic-token-b\n", { mode: 0o600 });
    await rename(replacement, path);
    expect(readHostedMimoCredentialAtPath(path, redactor)).toBe("synthetic-token-b");
    expect(redactor.redact("synthetic-token-a synthetic-token-b")).not.toMatch(/synthetic-token-[ab]/);
  });

  it("rejects a symlink, hard link, oversized file, loose mode, and non-root owner", async () => {
    // Regression: a substituted or readable shared source becomes launch authority.
    const { directory, path } = await fixture();
    const reject = (target: string) => expect(() => readHostedMimoCredentialAtPath(target, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    const symlinkPath = join(directory, "symlink");
    await symlink(path, symlinkPath); reject(symlinkPath);
    const hardlinkPath = join(directory, "hardlink");
    await link(path, hardlinkPath); reject(path);
    await rm(hardlinkPath);
    await writeFile(path, "x".repeat(4097), { mode: 0o600 }); reject(path);
    await writeFile(path, "synthetic-token\n", { mode: 0o600 });
    await chmod(path, 0o644); reject(path);
    await chmod(path, 0o600);
    syntheticOwner.fileUid = 1;
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    syntheticOwner.fileUid = 0;
  });

  it("rejects writable or symlinked ancestry", async () => {
    // Regression: a rename-capable ancestor can redirect the fixed lookup.
    const { directory, path } = await fixture();
    await chmod(directory, 0o777);
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    await chmod(directory, 0o700);
    syntheticOwner.ancestorUid = 1;
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    syntheticOwner.ancestorUid = 0;
    const alias = join(process.cwd(), `.synthetic-mimo-link-${process.pid}`);
    try {
      await symlink(directory, alias);
      expect(() => readHostedMimoCredentialAtPath(join(alias, "key"), new DefaultRedactor()))
        .toThrow("hosted_mimo_credential_invalid");
    } finally { await rm(alias, { force: true }); }
  });
});
