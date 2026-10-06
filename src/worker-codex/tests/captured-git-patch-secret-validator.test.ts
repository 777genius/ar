import { expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { assertCapturedGitPatchBlobsSecretSafe } from "../git-patch-secret-validator";

const patch = (before: string, after: string): string =>
  "diff --git a/authored.txt b/authored.txt\n--- a/authored.txt\n+++ b/authored.txt\n@@ -1 +1 @@\n-" + before + "+" + after;
const before = "old safe\n", after = "new safe\n";
const snapshot = (middle: string) => {
  const first = patch(before, middle);
  return { patch: first + patch(middle, after), changedPaths: ["authored.txt"], appliedPaths: ["authored.txt"],
    baseBlobs: new Map([["authored.txt", Buffer.from(before)]]),
    postBlobs: new Map([["authored.txt", Buffer.from(after)]]),
    intermediates: new Map([[first.split("\n").length - 1, new Map([["authored.txt", Buffer.from(middle)]])]]),
  };
};
// Red: scanning only final before/after hides a secret introduced then removed.
it("scans full intermediate repeated-section bytes and refuses omitted snapshots", () => {
  const unsafe = 'secret = "' + "synthetic-coverage-".repeat(3) + '";\n';
  expect(() => assertCapturedGitPatchBlobsSecretSafe(snapshot(unsafe))).toThrow("git_patch_secret_like_content:authored.txt");
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...snapshot(unsafe), intermediates: new Map() })).toThrow("git_patch_secret_intermediate_missing");
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...snapshot(unsafe),
    intermediates: new Map([[6, new Map()]]) })).toThrow("git_patch_secret_intermediate_missing");
});
// Red: private captured data skips byte charges, applied membership or envelope.
it("retains complete safe coverage and logical byte limits", () => {
  const captured = snapshot("middle safe\n");
  expect(assertCapturedGitPatchBlobsSecretSafe(captured)).toBe(30);
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...captured, maxTotalFileBytes: 29 })).toThrow("git_patch_secret_total_limit_exceeded");
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...captured, appliedPaths: ["other.txt"] })).toThrow("git_patch_secret_changed_paths_mismatch");
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...captured, patch: captured.patch + 'secret = "' + "synthetic-envelope-".repeat(3) + '";\n' })).toThrow("git_patch_secret_");
});

function base85(bytes: Buffer): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 52) {
    const line = bytes.subarray(offset, offset + 52);
    let encoded = line.length <= 26 ? String.fromCharCode(64 + line.length) : String.fromCharCode(70 + line.length);
    for (let block = 0; block < line.length; block += 4) {
      let value = 0;
      for (let n = 0; n < 4; n++) value = value * 256 + (line[block + n] ?? 0);
      const digits = Array<string>(5);
      for (let n = 4; n >= 0; n--) { digits[n] = alphabet[value % 85]!; value = Math.floor(value / 85); }
      encoded += digits.join("");
    }
    lines.push(encoded);
  }
  return lines.join("\n");
}
// Red: extracted validation trusts the binary header or supplied final bytes
// without proving the actual compressed payload direction and expansion bounds.
it("binds literal binary payload bytes and rejects mismatches and declared expansion", () => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const binaryPatch = "diff --git a/authored.bin b/authored.bin\nnew file mode 100644\nGIT binary patch\nliteral 4\n" + base85(deflateSync(bytes)) + "\n\n";
  const captured = { patch: binaryPatch, changedPaths: ["authored.bin"], appliedPaths: ["authored.bin"],
    baseBlobs: new Map<string, Buffer>(), postBlobs: new Map([["authored.bin", bytes]]),
    intermediates: new Map<number, ReadonlyMap<string, Buffer>>() };
  expect(assertCapturedGitPatchBlobsSecretSafe(captured)).toBe(4);
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...captured,
    postBlobs: new Map([["authored.bin", Buffer.from([0, 1, 2, 4])]]) })).toThrow("git_patch_secret_binary_direction_mismatch");
  expect(() => assertCapturedGitPatchBlobsSecretSafe({ ...captured, maxFileBytes: 3 })).toThrow("git_patch_secret_file_limit_exceeded");
});
