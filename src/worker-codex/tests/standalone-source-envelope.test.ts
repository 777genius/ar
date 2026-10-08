import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { inspectStandaloneSourceEnvelope, StandaloneSourceEnvelopeReason, StandaloneSourceEnvelopeStatus } from "../job-storage/standalone-source-envelope";
const execute = promisify(execFile);
describe("complete source envelope feasibility", () => {
  it("includes unique ignored source but never turns inventory into a recovery receipt", async () => {
    const root = await sourceFixture();
    try {
      await writeFile(join(root, ".gitignore"), "unique-ignored.txt\n");
      await writeFile(join(root, "unique-ignored.txt"), "irreplaceable bytes\n");
      const envelope = await inspectStandaloneSourceEnvelope(root);
      expect(envelope.status).toBe(StandaloneSourceEnvelopeStatus.CaptureRequired);
      if (envelope.status !== StandaloneSourceEnvelopeStatus.CaptureRequired) throw new Error("source_capture_unavailable");
      expect(envelope.uniqueIgnoredPaths).toEqual(["unique-ignored.txt"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([StandaloneSourceEnvelopeReason.GitLock, StandaloneSourceEnvelopeReason.Alternates, StandaloneSourceEnvelopeReason.UnclassifiedLink, StandaloneSourceEnvelopeReason.Dependencies])(
    "protects unsupported source dependency %s", async reason => {
      const root = await sourceFixture();
      try {
        if (reason === StandaloneSourceEnvelopeReason.GitLock) await writeFile(join(root, ".git", "index.lock"), "writer");
        if (reason === StandaloneSourceEnvelopeReason.Alternates) {
          await mkdir(join(root, ".git", "objects", "info"), { recursive: true });
          await writeFile(join(root, ".git", "objects", "info", "alternates"), "/unavailable-object-store\n");
        }
        if (reason === StandaloneSourceEnvelopeReason.UnclassifiedLink) await symlink("/unknown-source", join(root, "dependency"));
        if (reason === StandaloneSourceEnvelopeReason.Dependencies) {
          await mkdir(join(root, "nested"));
          await writeFile(join(root, "nested", ".git"), "gitdir: /unavailable-repository\n");
        }
        expect(await inspectStandaloneSourceEnvelope(root)).toEqual({ status: StandaloneSourceEnvelopeStatus.Unsupported, reason });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
});
async function sourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "test-a1-source-"));
  await execute("git", ["init", root]);
  return root;
}
