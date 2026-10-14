import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProjectAuthorityCrashPoint, LocalProjectAuthorityTupleStore } from
  "../project-authority-tuple-local-adapter";
const roots: string[] = [];
const projectId = "hosted-web-core-v1";
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
describe("project authority initialization and boundary safety", () => {
  it.runIf(process.platform === "linux")(
    "closes the current directory handle when opening the next path component fails",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "authority-safety-")); roots.push(parent);
      const invalidRoot = join(parent, "missing", "authority");
      const store = new LocalProjectAuthorityTupleStore({ rootDir: invalidRoot, projectId });
      await expect(store.initialize(expected())).rejects.toMatchObject({ code: "ENOENT" });
      const before = (await readdir("/proc/self/fd")).length;

      for (let attempt = 0; attempt < 64; attempt += 1) {
        await expect(store.initialize(expected())).rejects.toMatchObject({ code: "ENOENT" });
      }

      expect((await readdir("/proc/self/fd")).length).toBe(before);
    },
  );
  it("initializes durably, noops exact replay, and rejects conflict and reset", async () => {
    const rootDir = await root(); const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId });
    await expect(store.initialize(expected())).resolves.toBe("initialized");
    await expect(store.initialize(expected())).resolves.toBe("noop");
    await expect(store.initialize({ ...expected(), inputPatchHash: "9".repeat(64) }))
      .rejects.toThrow("project_authority_initialize_conflict");
    await store.compareAndSet({ expected: expected(), desired: desired() });
    await expect(store.initialize(expected())).rejects.toThrow("project_authority_initialize_conflict");
  });
  it("fails closed for non-private project, state, and lock modes", async () => {
    for (const leaf of ["project", "state", "lock"] as const) {
      const rootDir = await root(); const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId });
      await store.initialize(expected());
      if (leaf === "project") await chmod(join(rootDir, projectId), 0o755);
      if (leaf === "state") await chmod(join(rootDir, projectId, "authority-tuple.json"), 0o644);
      if (leaf === "lock") await chmod(join(rootDir, projectId, ".authority-tuple.flock"), 0o644);
      await expect(store.compareAndSet({ expected: expected(), desired: desired() }))
        .rejects.toThrow(/project_authority_(?:directory_not_private|state_corrupt|lock_unsafe)/);
    }
  });
  it("rejects a project-directory swap without writing the replacement", async () => {
    const rootDir = await root(); const initial = new LocalProjectAuthorityTupleStore({ rootDir, projectId });
    await initial.initialize(expected());
    const displaced = join(rootDir, `${projectId}.displaced`);
    const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId, crashHook: async (point) => {
      if (point !== LocalProjectAuthorityCrashPoint.AfterTempFsync) return;
      await rename(join(rootDir, projectId), displaced);
      await mkdir(join(rootDir, projectId), { mode: 0o700 });
    } });
    await expect(store.compareAndSet({ expected: expected(), desired: desired() }))
      .rejects.toThrow("project_authority_directory_identity_changed");
    expect(await readdir(join(rootDir, projectId))).toEqual([]);
    expect(JSON.parse(await readFile(join(displaced, "authority-tuple.json"), "utf8")).tuple)
      .toEqual(expected());
  });
});
async function root(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "authority-safety-")); roots.push(parent);
  const path = join(parent, "authority"); await mkdir(path, { mode: 0o700 }); return path;
}
function expected() { return { packetRevision: "hosted-web-core-v1-r1", baseSha: "a".repeat(40),
  phaseStartSha: null, inputPatchHash: "b".repeat(64) } as const; }
function desired() { return { ...expected(), phaseStartSha: "c".repeat(40),
  reviewReceiptSha256: "d".repeat(64) }; }
