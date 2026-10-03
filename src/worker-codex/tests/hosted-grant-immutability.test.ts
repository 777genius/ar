import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { publishImmutableHostedGrantFile, hostedTestEgressGrantName } from "../hosted-test-egress-files";

const synthetic = vi.hoisted(() => ({ root: "" }));
// Normalize synthetic host ownership and temp ancestry only; publication uses real filesystem operations.
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    lstat: async (path: string) => {
      const stat = await fs.lstat(path);
      const ancestor = synthetic.root.startsWith(path.endsWith("/") ? path : path + "/");
      return ancestor || path === synthetic.root || path.startsWith(synthetic.root + "/")
        ? Object.assign(stat, { uid: 0, mode: ancestor ? stat.mode & ~0o022 : stat.mode }) : stat;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args), stat = file.stat.bind(file);
      file.stat = (async () => Object.assign(await stat(), { uid: 0 })) as typeof file.stat;
      return file;
    },
  };
});

describe("immutable grant filesystem publication", () => {
  // Bug: an atomic rename replaces an already accepted record, changing authority on replay.
  it("replays exact bytes and preserves the original record on conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr3-TEST-grant-publication-"));
    synthetic.root = root;
    try {
      const authority = join(root, "private-registry"); await mkdir(authority, { mode: 0o700 });
      const grant = { schemaVersion: 1 as const, jobId: "test-grant", jobRootDir: join(root, "jobs", "test-grant"),
        workspacePath: join(root, "jobs", "test-grant", "workspace"), profileId: CodexProviderEgressProfileId.TestNpmQualification as const };
      await publishImmutableHostedGrantFile(authority, grant);
      const path = join(authority, hostedTestEgressGrantName(grant.jobId));
      const original = await readFile(path), before = await stat(path);
      await publishImmutableHostedGrantFile(authority, grant);
      expect((await readFile(path)).equals(original)).toBe(true);
      expect((await stat(path)).ino).toBe(before.ino);
      expect((await stat(path)).nlink).toBe(1);
      await expect(publishImmutableHostedGrantFile(authority, { ...grant, workspacePath: join(root, "foreign") })).rejects.toThrow("immutable_conflict");
      expect((await readFile(path)).equals(original)).toBe(true);
    } finally { synthetic.root = ""; await rm(root, { recursive: true, force: true }); }
  });
});
