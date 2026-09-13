import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { assertGitPatchBlobsSecretSafe } from "../git-patch-secret-validator";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const unsafe = 'secret = "' + "synthetic-coverage-".repeat(3) + '";\n';
function fixture(format = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "patch-coverage-"));
  roots.push(root);
  const git = (args: string[], input?: string | Buffer): Buffer => execFileSync("git", ["-C", root, ...args], {
    input, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  git(["init", `--object-format=${format}`]);
  git(["config", "user.name", "Synthetic Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (const [path, text] of Object.entries({ "safe.txt": "old safe\n", "unsafe.txt": unsafe,
    "space name.txt": "old safe\n", "unicode-é.txt": "old safe\n", "no-newline.txt": "old" })) {
    writeFileSync(join(root, path), text);
  }
  git(["add", "."]); git(["commit", "-m", "test: synthetic coverage"]);
  const baseCommit = git(["rev-parse", "HEAD"]).toString().trim();
  const validate = (patch: string | Buffer, changedPaths = ["safe.txt"], maxTotalFileBytes?: number) =>
    assertGitPatchBlobsSecretSafe({ workspacePath: root, tempRootDir: root, baseCommit, changedPaths, patch,
      ...(maxTotalFileBytes === undefined ? {} : { maxTotalFileBytes }) });
  return { root, git, validate, baseCommit };
}
function textPatch(before: string, after: string, path = "safe.txt"): string {
  const oldLines = before.split("\n").slice(0, -1);
  const newLines = after.split("\n").slice(0, -1);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldLines.length} +1,${newLines.length} @@\n` +
    oldLines.map((line) => `-${line}\n`).join("") + newLines.map((line) => `+${line}\n`).join("");
}

it("accounts repeated text sections and scans every envelope region without context", async () => {
  const { validate } = fixture();
  const safe = textPatch("old safe\n", "new safe\n");
  await expect(validate(safe)).resolves.toBe(18);
  await expect(validate(safe.split("\n").slice(1).join("\n"))).resolves.toBe(18);
  await expect(validate(textPatch("old safe\n", "middle safe\n") + textPatch("middle safe\n", "new safe\n")))
    .resolves.toBe(30);
  await expect(validate(textPatch("old safe\n", "middle safe\n") +
    textPatch("middle safe\n", "new safe\n"), ["safe.txt"], 29))
    .rejects.toThrow("git_patch_secret_total_limit_exceeded");
  for (const patch of [unsafe + safe, safe + unsafe,
    safe.replace(" @@\n", " @@ " + unsafe),
    textPatch("old safe\n", unsafe) + textPatch(unsafe, "new safe\n"),
    textPatch("old safe\n", unsafe.replace(" = ", " =\n  ")) +
      textPatch(unsafe.replace(" = ", " =\n  "), "new safe\n"),
    safe + "+unconsumed text\n"]) {
    await expect(validate(patch)).rejects.toThrow("git_patch_secret_");
  }
});

it("reads unchanged copy sources without changing the manifest path set or skipping byte charges", async () => {
  const { validate } = fixture();
  const copy = "diff --git a/safe.txt b/copy.txt\nsimilarity index 100%\ncopy from safe.txt\ncopy to copy.txt\n";
  await expect(validate(copy, ["copy.txt"])).resolves.toBe(18);
  await expect(validate(copy, ["copy.txt"], 17)).rejects.toThrow("git_patch_secret_total_limit_exceeded");
  await expect(validate(copy, ["safe.txt", "copy.txt"])).rejects.toThrow("git_patch_secret_changed_paths_mismatch");
  const badCopy = "diff --git a/unsafe.txt b/copy.txt\nsimilarity index 50%\ncopy from unsafe.txt\ncopy to copy.txt\n" +
    "--- a/unsafe.txt\n+++ b/copy.txt\n@@ -1 +1 @@\n-" + unsafe + "+safe destination\n";
  await expect(validate(badCopy, ["copy.txt"])).rejects.toThrow("git_patch_secret_like_content:unsafe.txt");
});

it.each(["sha1", "sha256"])("preserves supported text formats and repository isolation (%s)", async (format) => {
  const { root, git, validate } = fixture(format);
  writeFileSync(join(root, "space name.txt"), "new safe\n");
  writeFileSync(join(root, "unicode-é.txt"), "new safe\n");
  writeFileSync(join(root, "no-newline.txt"), "new");
  writeFileSync(join(root, "added.txt"), "added\n");
  chmodSync(join(root, "safe.txt"), 0o755);
  git(["mv", "unsafe.txt", "renamed.txt"]);
  // Renaming an unsafe preimage must still fail; a safe rename is a separate control.
  const rejected = git(["diff", "--cached", "-M", "HEAD"]);
  await expect(validate(rejected, ["unsafe.txt", "renamed.txt"])).rejects.toThrow("git_patch_secret_");
  git(["reset", "--hard", "HEAD"]);
  git(["mv", "safe.txt", "renamed-safe.txt"]);
  await expect(validate(git(["diff", "--cached", "-M", "HEAD"]), ["safe.txt", "renamed-safe.txt"]))
    .resolves.toBe(18);
  git(["reset", "--hard", "HEAD"]);
  for (const path of ["space name.txt", "unicode-é.txt", "no-newline.txt"]) {
    writeFileSync(join(root, path), path === "no-newline.txt" ? "new" : "new safe\n");
    await expect(validate(git(["diff", "HEAD", "--", path]), [path])).resolves.toBeGreaterThan(0);
  }
  chmodSync(join(root, "safe.txt"), 0o755);
  await expect(validate(git(["diff", "HEAD", "--", "safe.txt"]))).resolves.toBe(18);
  rmSync(join(root, "safe.txt"));
  await expect(validate(git(["diff", "HEAD", "--", "safe.txt"]))).resolves.toBe(9);
  git(["add", "added.txt"]);
  const patch = git(["diff", "--cached", "HEAD", "--", "added.txt"]);
  const index = readFileSync(join(root, ".git", "index"));
  const objects = readdirSync(join(root, ".git", "objects"), { recursive: true }).sort();
  await expect(validate(patch, ["added.txt"])).resolves.toBe(6);
  expect(readFileSync(join(root, ".git", "index")).equals(index)).toBe(true);
  expect(readdirSync(join(root, ".git", "objects"), { recursive: true }).sort()).toEqual(objects);
});

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
function encoded(bytes: Buffer): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 52) {
    const line = bytes.subarray(offset, offset + 52);
    result += String.fromCharCode(line.length <= 26 ? 64 + line.length : 70 + line.length);
    for (let i = 0; i < line.length; i += 4) {
      const block = Buffer.alloc(4); line.copy(block, 0, i, i + 4);
      let value = block.readUInt32BE(); let digits = "";
      for (let digit = 0; digit < 5; digit += 1) { digits = alphabet[value % 85] + digits; value = Math.floor(value / 85); }
      result += digits;
    }
    result += "\n";
  }
  return result;
}
function hunk(bytes: Buffer, delta = false, tail = Buffer.alloc(0)): string {
  return `${delta ? "delta" : "literal"} ${bytes.length}\n${encoded(Buffer.concat([deflateSync(bytes), tail]))}\n`;
}

it("binds both binary directions and consumes every delta instruction and compressed byte", async () => {
  const { validate } = fixture();
  const before = Buffer.from("old safe\n"), after = Buffer.from("new safe\n");
  const oid = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const header = `diff --git a/safe.txt b/safe.txt\nindex ${oid(before)}..${oid(after)} 100644\nGIT binary patch\n`;
  const delta = (target: Buffer) => Buffer.concat([Buffer.from([9, 9, 9]), target]);
  const forward = hunk(delta(after), true), reverse = hunk(delta(before), true);
  await expect(validate(header + forward + reverse + "\n\n")).resolves.toBe(18);
  await expect(validate(header + hunk(after) + hunk(before))).resolves.toBe(18);
  await expect(validate(header + hunk(after))).resolves.toBe(18);
  const customHeader = header.replace("a/safe.txt b/safe.txt", "before/safe.txt after/safe.txt");
  await expect(validate(customHeader + forward + reverse)).resolves.toBe(18);
  await expect(validate(customHeader + hunk(after) + hunk(Buffer.from(unsafe))))
    .rejects.toThrow("git_patch_secret_");
  const addition = `diff --git a/added.txt b/added.txt\nnew file mode 100644\nindex ${"0".repeat(40)}..${oid(after)}\nGIT binary patch\n`;
  await expect(validate(addition + hunk(after) + hunk(Buffer.alloc(0)), ["added.txt"]))
    .resolves.toBe(9);
  const deletion = `diff --git a/safe.txt b/safe.txt\ndeleted file mode 100644\nindex ${oid(before)}..${"0".repeat(40)}\nGIT binary patch\n`;
  await expect(validate(deletion + hunk(Buffer.alloc(0)) + hunk(before))).resolves.toBe(9);
  for (const payload of [
    hunk(after) + hunk(Buffer.from(unsafe)),
    forward + hunk(Buffer.concat([delta(before), Buffer.from([0])]), true),
    forward + hunk(Buffer.from([9, 9, 0x91, 99, 9]), true),
    forward + hunk(Buffer.from([9, 9, 9, 1]), true),
    forward + hunk(Buffer.from([9, 9, 0]), true),
    forward + reverse + hunk(before),
    hunk(after, false, Buffer.from("trailing")) + reverse,
  ]) await expect(validate(header + payload)).rejects.toThrow("git_patch_secret_");
});

it("does not transfer a destination fixture classification to an unchanged copy source", async () => {
  const { root, git } = fixture();
  const sourcePath = "unlisted-source.ts";
  const destination = "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts";
  const line = '  const secret = "' + "sk-" + "ant-" +
    "abcdefghijklmnopqrstuvwxyz0123456789" + '";\n';
  writeFileSync(join(root, sourcePath), line);
  git(["add", sourcePath]); git(["commit", "-m", "test: unlisted copy source"]);
  const baseCommit = git(["rev-parse", "HEAD"]).toString().trim();
  const patch = `diff --git a/${sourcePath} b/${destination}\n` +
    `similarity index 100%\ncopy from ${sourcePath}\ncopy to ${destination}\n`;
  await expect(assertGitPatchBlobsSecretSafe({
    workspacePath: root, tempRootDir: root, baseCommit, patch,
    changedPaths: [destination],
  })).rejects.toThrow(`git_patch_secret_like_content:${sourcePath}`);
});

it("scans complete intermediate text when an assignment begins outside the changed hunk", async () => {
  const { root, git } = fixture();
  writeFileSync(join(root, "safe.txt"), "secret =\nold safe\n");
  git(["add", "safe.txt"]); git(["commit", "-m", "test: split intermediate assignment"]);
  const baseCommit = git(["rev-parse", "HEAD"]).toString().trim();
  const middle = '"' + "intermediate-negative-".repeat(3) + '"';
  const section = (before: string, after: string) =>
    "diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n" +
    `@@ -2 +2 @@\n-${before}\n+${after}\n`;
  await expect(assertGitPatchBlobsSecretSafe({
    workspacePath: root, tempRootDir: root, baseCommit, changedPaths: ["safe.txt"],
    patch: section("old safe", middle) + section(middle, "new safe"),
  })).rejects.toThrow("git_patch_secret_");
});

it("preserves invalid-input, object, path, mode and reconstruction limits", async () => {
  const { root, git, baseCommit } = fixture();
  const input = {
    workspacePath: root, tempRootDir: root, baseCommit,
    changedPaths: ["safe.txt"], patch: textPatch("old safe\n", "new safe\n"),
  };
  for (const changes of [
    { baseCommit: "not-an-object" }, { baseCommit: "f".repeat(40) },
    { changedPaths: [] }, { changedPaths: ["../safe.txt"] },
    { changedPaths: Array.from({ length: 257 }, (_, i) => `path-${i}`) },
    { changedPaths: Array.from({ length: 1025 }, () => "safe.txt") },
    { maxFileBytes: 0 }, { maxTotalFileBytes: 65 * 1024 * 1024 },
    { maxFileBytes: 8 }, { maxTotalFileBytes: 17 },
    { patch: Buffer.alloc(16 * 1024 * 1024 + 1, 32) },
  ]) await expect(assertGitPatchBlobsSecretSafe({ ...input, ...changes }))
    .rejects.toThrow("git_patch_secret_");
  // A synthetic gitlink and symlink blob are never admitted as ordinary files.
  for (const mode of ["160000", "120000"]) {
    const oid = mode === "160000" ? baseCommit :
      git(["hash-object", "-w", "--stdin"], "safe.txt").toString().trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${oid},special`]);
    await expect(assertGitPatchBlobsSecretSafe({
      ...input, changedPaths: ["special"], patch: git(["diff", "--cached", "HEAD"]),
    })).rejects.toThrow("git_patch_secret_");
    git(["reset", "--", "special"]);
  }
  await expect(assertGitPatchBlobsSecretSafe(input)).resolves.toBe(18);
});

it.each([false, true])("strips one custom prefix component in Git and traditional headers (traditional=%s)", async (traditional) => {
  const { root, git, validate } = fixture();
  for (const path of ["safe.txt", "space name.txt", "unicode-é.txt"]) {
    writeFileSync(join(root, path), "new safe\n");
    for (const prefixes of [[], ["--src-prefix=before/", "--dst-prefix=after/"],
      ["--src-prefix=old space/", "--dst-prefix=new space/"]]) {
      let patch = git(["diff", ...prefixes, "--", path]).toString();
      if (traditional) patch = patch.split("\n")
        .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index ")).join("\n");
      await expect(validate(patch, [path])).resolves.toBe(18);
    }
  }
});

it("keeps custom prefix paths bound and rejects malformed headers and unsafe aliases", async () => {
  const { validate } = fixture();
  const custom = (patch: string) => patch.replaceAll("a/", "before/").replaceAll("b/", "after/");
  const safe = custom(textPatch("old safe\n", "new safe\n"));
  for (const name of ["../safe.txt", "./safe.txt", "nested/../safe.txt", "/safe.txt"]) {
    await expect(validate(safe.replaceAll("safe.txt", name))).rejects.toThrow("git_patch_secret_");
  }
  for (const patch of [safe.replaceAll("before/", ""), safe.replaceAll("after/", ""),
    safe.replace("--- before/safe.txt", '--- "before/safe.txt'),
    safe.replace("+++ after/safe.txt", "+++ after/other.txt"),
    safe.replace("@@ -1,1", "@@ -bad,1"), unsafe + safe, safe + unsafe,
    custom(textPatch("old safe\n", unsafe) + textPatch(unsafe, "new safe\n"))]) {
    await expect(validate(patch)).rejects.toThrow("git_patch_secret_");
  }
});

it("retains envelope secrets across long runs of already-scanned blob lines", async () => {
  const { assertTextAndEnvelopeCoverage } = await import("../git-patch-content-coverage");
  const count = 10000;
  const contents = "safe\n".repeat(count);
  const covered = Array.from({ length: count }, (_, index) => ({
    patchLine: index + 1, content: "safe", newLine: index + 1,
  }));
  const coverage = {
    lines: ["secret =", ...Array<string>(count).fill("+safe"), '"' + "synthetic-envelope-".repeat(3) + '"'],
    sections: [{ startLine: 0, oldPath: undefined, newPath: "safe.txt", text: covered }],
    copySources: [],
  };
  expect(() => assertTextAndEnvelopeCoverage(coverage, new Map(), new Map([["safe.txt", Buffer.from(contents)]]), new Set()))
    .toThrow("git_patch_secret_envelope_content");
});
