import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveNpmPackTarball } from "./build-agent-runtime-task-artifact.mjs";

const unsafeFilename = /npm pack returned an unsafe artifact filename/u;

async function withPackRoot(run: (packRoot: string, scratch: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "issue333-pack-test-"));
  try {
    const packRoot = join(scratch, "pack");
    await mkdir(packRoot);
    await run(packRoot, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("legacy and keyed reports resolve the same canonical artifact", async () => {
  await withPackRoot(async (packRoot) => {
    const filename = "public-test-1.0.0.tgz";
    await writeFile(join(packRoot, filename), "test payload");
    const expected = await realpath(join(packRoot, filename));
    for (const report of [[{ filename }], { "public-test": { filename } },
      { "@public/test": { filename } }]) {
      assert.equal(await resolveNpmPackTarball(packRoot, JSON.stringify(report)), expected);
    }
  });
});

test("rejects non-JSON, malformed reports and zero or multiple packages", async () => {
  await withPackRoot(async (packRoot) => {
    await assert.rejects(resolveNpmPackTarball(packRoot, "not JSON"), /non-JSON/u);
    const valid = { filename: "test.tgz" };
    const malformed: unknown[] = [null, true, 12, "test.tgz", [], {}, [null], [false],
      ["test.tgz"], [[]], [{}], [valid, valid], { one: valid, two: valid },
      { one: null }, { one: false }, { one: 12 }, { one: "test.tgz" },
      { one: [] }, { one: [valid] }, { one: {} }, { one: { report: valid } },
      { "": valid }, { " ": valid }, valid];
    for (const report of malformed) {
      await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), unsafeFilename,
        JSON.stringify(report));
    }
  });
});

test("rejects invalid and unsafe filenames in both report formats", async () => {
  await withPackRoot(async (packRoot) => {
    const filenames: unknown[] = [null, false, 12, [], {}, "", " ", ".", "..",
      "/absolute.tgz", "../escape.tgz", "sub/file.tgz", "sub\\file.tgz",
      "..\\escape.tgz", "C:\\absolute.tgz", "C:/absolute.tgz", "nul\0.tgz"];
    for (const filename of filenames) {
      for (const report of [[{ filename }], { one: { filename } }]) {
        await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), unsafeFilename,
          JSON.stringify(report));
      }
    }
  });
});

test("safe basename cannot escape through a real symlink or destination prefix sibling", async () => {
  await withPackRoot(async (packRoot, scratch) => {
    const sibling = join(scratch, "pack-sibling");
    await mkdir(sibling);
    const outside = join(sibling, "outside.tgz");
    await writeFile(outside, "outside payload");
    await symlink(outside, join(packRoot, "safe.tgz"));
    await symlink(packRoot, join(packRoot, "directory.tgz"));
    for (const filename of ["safe.tgz", "directory.tgz"]) {
      for (const report of [[{ filename }], { one: { filename } }]) {
        await assert.rejects(resolveNpmPackTarball(packRoot, JSON.stringify(report)), /escaped its destination/u);
      }
    }
  });
});

test("containment resolves a symlinked pack root canonically and requires an existing file", async () => {
  await withPackRoot(async (packRoot, scratch) => {
    const alias = join(scratch, "alias");
    await symlink(packRoot, alias);
    await writeFile(join(packRoot, "inside.tgz"), "inside payload");
    assert.equal(await resolveNpmPackTarball(alias, '[{"filename":"inside.tgz"}]'),
      await realpath(join(packRoot, "inside.tgz")));
    await assert.rejects(resolveNpmPackTarball(alias, '[{"filename":"missing.tgz"}]'), { code: "ENOENT" });
  });
});

// Provide the untouched stdout and destination from an actual disposable npm pack.
const realReport = process.env.ISSUE333_PACK_REPORT;
const realPackRoot = process.env.ISSUE333_PACK_ROOT;
test("accepts the retained actual npm12.2.0 pack stdout", { skip: !realReport || !realPackRoot }, async () => {
  assert.ok(realReport && realPackRoot);
  const stdout = await readFile(realReport, "utf8");
  assert.equal(await resolveNpmPackTarball(realPackRoot, stdout),
    await realpath(join(realPackRoot, "newtest-issue333-public-pack-test-1.0.0.tgz")));
});
