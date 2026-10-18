import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashHeldImmutableFile, readHeldImmutableFileChecked } from "../project-control-evidence-custody-held-stat";

// Binding tests for the same-descriptor private read: owner/mode/length are checked on the SAME held final descriptor
// that supplies the bytes, before any payload is read. Custody is Linux-only, so the suite is skipped elsewhere. A
// separate pathname precheck followed by a second open would pass the valid case but fail the replacement case.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture(content = "private bytes\n", mode = 0o600) {
  const dir = await mkdtemp(join(tmpdir(), "held-read-TEST-"));
  dirs.push(dir);
  const path = join(dir, "record.json");
  await writeFile(path, content); await chmod(path, mode);
  return { dir, path };
}

describe.skipIf(process.platform !== "linux")("same-descriptor checked private read (Linux)", () => {
  it("returns a Buffer whose uid, mode and length were presented to the check from the same descriptor", async () => {
    const { path } = await fixture();
    const seen: { length: number; mode: number; uid: number }[] = [];
    const bytes = await readHeldImmutableFileChecked(path, 1024, (facts) => { seen.push(facts); });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("private bytes\n");
    const onDisk = await stat(path);
    expect(seen).toEqual([{ length: 14, mode: 0o600, uid: onDisk.uid }]);
  });

  it("refuses an insecure mode on the descriptor before any payload is read", async () => {
    const { path } = await fixture("x", 0o644);
    let metadataPhaseEnded = false;
    await expect(readHeldImmutableFileChecked(path, 1024, (facts) => {
      if ((facts.mode & 0o177) !== 0) throw new Error("TEST_insecure_mode");
    }, async () => { metadataPhaseEnded = true; })).rejects.toThrow("TEST_insecure_mode");
    expect(metadataPhaseEnded).toBe(false); // the payload phase was never reached
  });

  it("refuses a path replaced between the metadata check and the payload read", async () => {
    const { dir, path } = await fixture("original\n");
    const replacement = join(dir, "replacement.json");
    await writeFile(replacement, "attacker bytes\n"); await chmod(replacement, 0o600);
    await expect(readHeldImmutableFileChecked(path, 1024, () => undefined, async () => { await rename(replacement, path); }))
      .rejects.toThrow("evidence_custody_file_changed_during_read");
  });

  it("refuses a file above its byte cap without presenting it to the check or reading it", async () => {
    const { path } = await fixture("0123456789");
    let checked = false;
    await expect(readHeldImmutableFileChecked(path, 4, () => { checked = true; })).rejects.toThrow("evidence_custody_file_invalid");
    expect(checked).toBe(false);
  });

  it("streams the SHA-256 and exact length of a multi-chunk file through the held descriptor, with the byte cap enforced", async () => {
    const body = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61); // more than two 1 MiB chunks
    const { path } = await fixture(body.toString("latin1"));
    const hashed = await hashHeldImmutableFile(path, body.length);
    expect(hashed).toEqual({ sha256: createHash("sha256").update(body).digest("hex"), length: body.length, mode: 0o600 });
    await expect(hashHeldImmutableFile(path, body.length - 1)).rejects.toThrow("evidence_custody_file_invalid");
  });

  it("refuses a streamed hash of a symlink alias and of a file that grew past its recorded length", async () => {
    const { dir, path } = await fixture("0123456789");
    await symlink(path, join(dir, "alias.json"));
    await expect(hashHeldImmutableFile(join(dir, "alias.json"), 1024)).rejects.toThrow();
    await appendFile(path, "grown");
    expect((await hashHeldImmutableFile(path, 1024)).length).toBe(15);
    await expect(hashHeldImmutableFile(path, 10)).rejects.toThrow("evidence_custody_file_invalid"); // a recorded length of 10 no longer admits it
  });

  it("refuses a symlink as the final component", async () => {
    const { dir, path } = await fixture();
    const alias = join(dir, "alias.json");
    await symlink(path, alias);
    await expect(readHeldImmutableFileChecked(alias, 1024, () => undefined)).rejects.toThrow();
  });
});
