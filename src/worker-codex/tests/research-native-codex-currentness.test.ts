import { local, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { captureNativeCodex, nativeCompanion, nativeUnit } from "./fixtures/research-native-codex";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { assertResearchProviderRoot } from "../research-provider-root";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
// This case imports no new closure API, so the unchanged old root can run it.
// Keeping dev/ino/mode/size and restoring mtime defeats identity-only checks;
// retained companion bytes must still reject the changed executable.
it("rejects same-inode companion byte mutation after capture", async () => {
  const f = captureNativeCodex(), plan = f.prepare();
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const before = real.lstatSync(local(nativeCompanion));
  await new Promise(resolve => setTimeout(resolve, 5));
  const bytes = fs.readFileSync(nativeCompanion);
  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 10 ? 32 : 10;
  fs.writeFileSync(nativeCompanion, bytes);
  real.utimesSync(local(nativeCompanion), before.atime, before.mtime);
  const after = real.lstatSync(local(nativeCompanion));
  expect([after.dev, after.ino, after.mode, after.size]).toEqual([before.dev, before.ino, before.mode, before.size]);
  expect(() => assertResearchProviderRoot(plan, f.spec, nativeUnit, f.home)).toThrow("hosted_research_launch_denied");
});
