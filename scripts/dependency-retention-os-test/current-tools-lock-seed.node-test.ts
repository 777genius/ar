/** Exact source DATA only: no npm, guest, receipt or installed-tree authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { testPublicLockSeedSha256 } from "./current-tools-lock-seed.ts";

test("current public lock seed matches complete source bytes", () => {
  const bytes = readFileSync(new URL("../../package-lock.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), testPublicLockSeedSha256);
});
