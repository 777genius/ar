import { afterEach, describe, expect, it } from "vitest";
import { chmod, link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { readHostedMimoCredentialAtPath } from "../hosted-mimo-credential-source";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), ".synthetic-mimo-source-"));
  directories.push(directory);
  const path = join(directory, "key");
  await writeFile(path, "synthetic-token-a\n", { mode: 0o600 });
  return { directory, path };
}

describe("hosted MiMo credential filesystem boundary", () => {
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
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor(), 0, 1))
      .toThrow("hosted_mimo_credential_invalid");
  });

  it("rejects writable or symlinked ancestry", async () => {
    // Regression: a rename-capable ancestor can redirect the fixed lookup.
    const { directory, path } = await fixture();
    await chmod(directory, 0o777);
    expect(() => readHostedMimoCredentialAtPath(path, new DefaultRedactor()))
      .toThrow("hosted_mimo_credential_invalid");
    await chmod(directory, 0o700);
    const alias = join(process.cwd(), `.synthetic-mimo-link-${process.pid}`);
    try {
      await symlink(directory, alias);
      expect(() => readHostedMimoCredentialAtPath(join(alias, "key"), new DefaultRedactor()))
        .toThrow("hosted_mimo_credential_invalid");
    } finally { await rm(alias, { force: true }); }
  });
});
