import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProjectAuthorityCasStatus,
  type ProjectAuthorityPreState,
  type ProjectAuthorityTuple,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalProjectAuthorityCrashPoint,
  LocalProjectAuthorityTupleStore,
} from "../project-authority-tuple-local-adapter";

const temporaryRoots: string[] = [];
const projectId = "hosted-web-core-v1";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("LocalProjectAuthorityTupleStore", () => {
  it("performs one atomic apply and exact noops under concurrent replay", async () => {
    const rootDir = await authorityRoot();
    const input = transition();
    await seedDocument(rootDir, input.expected);
    const stores = Array.from({ length: 24 }, () =>
      new LocalProjectAuthorityTupleStore({
        rootDir,
        projectId,
      })
    );

    const results = await Promise.all(
      stores.map((store) => store.compareAndSet(input)),
    );

    expect(results.filter(
      (status) => status === ProjectAuthorityCasStatus.Applied,
    )).toHaveLength(1);
    expect(results.filter(
      (status) => status === ProjectAuthorityCasStatus.Noop,
    )).toHaveLength(23);
    expect(JSON.parse(await readFile(authorityFile(rootDir), "utf8")))
      .toEqual({
        schemaVersion: 1,
        projectId,
        tuple: input.desired,
      });
  });

  it("recovers a project lock whose owning process is dead", async () => {
    const rootDir = await authorityRoot();
    const input = transition();
    await seedDocument(rootDir, input.expected);
    const lockDir = join(rootDir, projectId, ".authority-tuple.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 9_999_999,
      token: "00000000-0000-4000-8000-000000000000",
    }) + "\n", { mode: 0o600 });

    await expect(new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId,
    }).compareAndSet(input)).resolves.toBe(
      ProjectAuthorityCasStatus.Applied,
    );
  });

  it("applies only from the exact persisted null phaseStart pre-state", async () => {
    const rootDir = await authorityRoot();
    const input = transition();
    await seedDocument(rootDir, input.expected);
    const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId });

    await expect(store.compareAndSet(input))
      .resolves.toBe(ProjectAuthorityCasStatus.Applied);

    await seedDocument(rootDir, {
      ...input.expected,
      inputPatchHash: "9".repeat(64),
    });
    await expect(store.compareAndSet(input))
      .rejects.toThrow("project_authority_compare_and_set_conflict");
  });

  it("fails closed for stale and conflicting replays", async () => {
    const rootDir = await authorityRoot();
    const input = transition();
    await seedDocument(rootDir, input.expected);
    const store = new LocalProjectAuthorityTupleStore({ rootDir, projectId });
    await store.compareAndSet(input);

    await expect(store.compareAndSet({
      expected: input.expected,
      desired: {
        ...input.desired,
        phaseStartSha: "d".repeat(40),
        reviewReceiptSha256: "e".repeat(64),
      },
    })).rejects.toThrow("project_authority_compare_and_set_conflict");
    await expect(store.compareAndSet({
      expected: {
        ...input.expected,
        packetRevision: "hosted-web-core-v1-r0",
      },
      desired: {
        ...input.desired,
        packetRevision: "hosted-web-core-v1-r0",
      },
    })).rejects.toThrow("project_authority_compare_and_set_conflict");
  });

  it("recovers from an fsynced orphan temp and noops a post-rename replay", async () => {
    const rootDir = await authorityRoot();
    const input = transition();
    await seedDocument(rootDir, input.expected);
    const beforeRename = new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId,
      crashHook(point) {
        if (point === LocalProjectAuthorityCrashPoint.AfterTempFsync) {
          throw new Error("simulated_process_crash");
        }
      },
    });
    await expect(beforeRename.compareAndSet(input))
      .rejects.toThrow("simulated_process_crash");
    const crashEntries = await readdir(join(rootDir, projectId));
    expect(crashEntries.some((entry) => entry.endsWith(".tmp"))).toBe(true);
    expect(JSON.parse(await readFile(authorityFile(rootDir), "utf8")).tuple)
      .toEqual(input.expected);

    const recovered = new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId,
    });
    await expect(recovered.compareAndSet(input))
      .resolves.toBe(ProjectAuthorityCasStatus.Applied);

    let crashed = false;
    const afterRenameRoot = await authorityRoot();
    await seedDocument(afterRenameRoot, input.expected);
    const afterRename = new LocalProjectAuthorityTupleStore({
      rootDir: afterRenameRoot,
      projectId,
      crashHook(point) {
        if (
          !crashed &&
          point ===
            LocalProjectAuthorityCrashPoint.AfterRenameBeforeDirectoryFsync
        ) {
          crashed = true;
          throw new Error("simulated_process_crash");
        }
      },
    });
    await expect(afterRename.compareAndSet(input))
      .rejects.toThrow("simulated_process_crash");
    await expect(new LocalProjectAuthorityTupleStore({
      rootDir: afterRenameRoot,
      projectId,
    }).compareAndSet(input)).resolves.toBe(ProjectAuthorityCasStatus.Noop);
  });

  it("fails closed on corrupt, partial, oversized, and symlinked state", async () => {
    const input = transition();
    for (const corrupt of [
      "{",
      JSON.stringify({ schemaVersion: 1, projectId, tuple: input.desired }) +
        "x".repeat(8_193),
      JSON.stringify({
        schemaVersion: 1,
        projectId,
        tuple: { ...input.desired, secret: "unexpected" },
      }),
    ]) {
      const rootDir = await authorityRoot();
      await mkdir(join(rootDir, projectId), { recursive: true, mode: 0o700 });
      await writeFile(authorityFile(rootDir), corrupt);
      await expect(new LocalProjectAuthorityTupleStore({
        rootDir,
        projectId,
      }).compareAndSet(input)).rejects.toThrow(
        /project_authority_state_(?:corrupt|unreadable)/,
      );
    }

    const rootDir = await authorityRoot();
    const outside = join(await testRoot(), "outside-state.json");
    await writeFile(outside, JSON.stringify({
      schemaVersion: 1,
      projectId,
      tuple: input.expected,
    }));
    await mkdir(join(rootDir, projectId), { recursive: true, mode: 0o700 });
    await symlink(outside, authorityFile(rootDir), "file");
    await expect(new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId,
    }).compareAndSet(input)).rejects.toThrow(
      "project_authority_state_unreadable",
    );
    expect(JSON.parse(await readFile(outside, "utf8")).tuple)
      .toEqual(input.expected);
  });

  it("fails closed before lock creation when filesystem certification rejects", async () => {
    const rootDir = await authorityRoot();
    const verifier = vi.fn(async () => { throw new Error("uncertified_test_filesystem"); });
    await expect(new LocalProjectAuthorityTupleStore({
      rootDir, projectId, filesystemVerifier: verifier,
    }).initialize(transition().expected)).rejects.toThrow("uncertified_test_filesystem");
    expect(verifier).toHaveBeenCalledOnce();
    await expect(readdir(join(rootDir, projectId))).resolves.not.toContain(".authority-tuple.flock");
  });

  it("rejects project and root path escapes before outside-root writes", async () => {
    const parent = await testRoot();
    const rootDir = join(parent, "authority");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(rootDir, { mode: 0o700 }), mkdir(outside, { mode: 0o700 })]);
    await symlink(outside, join(rootDir, projectId), "dir");

    await expect(new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId,
    }).compareAndSet(transition())).rejects.toThrow(
      "project_authority_path_outside_root",
    );
    expect(await readdir(outside)).toEqual([]);
    expect(() => new LocalProjectAuthorityTupleStore({
      rootDir,
      projectId: "../outside",
    })).toThrow("project_authority_project_id_invalid");
    expect(() => new LocalProjectAuthorityTupleStore({
      rootDir: rootDir + "/../authority",
      projectId,
    })).toThrow("project_authority_root_invalid");
  });
});

function transition(): {
  readonly expected: ProjectAuthorityPreState;
  readonly desired: ProjectAuthorityTuple;
} {
  return {
    expected: {
      packetRevision: "hosted-web-core-v1-r1",
      baseSha: "a".repeat(40),
      phaseStartSha: null,
      inputPatchHash: "b".repeat(64),
    },
    desired: {
      packetRevision: "hosted-web-core-v1-r1",
      baseSha: "a".repeat(40),
      phaseStartSha: "c".repeat(40),
      inputPatchHash: "b".repeat(64),
      reviewReceiptSha256: "d".repeat(64),
    },
  };
}

async function testRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "project-authority-test-"));
  temporaryRoots.push(path);
  return path;
}

async function authorityRoot(): Promise<string> {
  return join(await testRoot(), "authority");
}

function authorityFile(rootDir: string): string {
  return join(rootDir, projectId, "authority-tuple.json");
}

async function seedDocument(
  rootDir: string,
  tuple: ProjectAuthorityPreState | ProjectAuthorityTuple,
): Promise<void> {
  await mkdir(join(rootDir, projectId), { recursive: true, mode: 0o700 });
  await writeFile(authorityFile(rootDir), JSON.stringify({
    schemaVersion: 1,
    projectId,
    tuple,
  }) + "\n", { mode: 0o600 });
}
