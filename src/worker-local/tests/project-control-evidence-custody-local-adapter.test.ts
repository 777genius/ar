import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LocalProjectControlEvidenceCustody,
  writeAll,
} from "../project-control-evidence-custody-local-adapter";

const fixturePath = fileURLToPath(new URL(
  "./project-control-evidence-custody-crash-fixture.ts", import.meta.url,
));

describe("local project-control evidence custody durability", () => {
  it("writeAll completes deterministic short writes and rejects zero progress", async () => {
    const output = Buffer.alloc(11);
    let position = 0;
    await writeAll({
      write: async (buffer: Uint8Array, offset: number, length: number) => {
        const count = Math.min(2, length);
        Buffer.from(buffer).copy(output, position, offset, offset + count);
        position += count;
        return { bytesWritten: count, buffer };
      },
    } as never, Buffer.from("hello world"));
    expect(output.toString()).toBe("hello world");
    await expect(writeAll({
      write: async (buffer: Uint8Array) => ({ bytesWritten: 0, buffer }),
    } as never, Buffer.from("x"))).rejects.toThrow("write_no_progress");
  });

  it.each([
    ["bytes", "after_temp_fsync"],
    ["copy", "after_publish_before_directory_fsync"],
    ["bytes", "after_ancestor_creation_before_parent_fsync"],
  ] as const)("replays exact %s publication after hard termination at %s",
    async (operation, crashPoint) => {
      const outer = await mkdtemp(join(tmpdir(), "custody-hard-crash-"));
      const root = join(outer, "root");
      await mkdir(root);
      const source = join(outer, "source.bin");
      const expected = operation === "copy"
        ? Buffer.from("copy source exact bytes\n")
        : Buffer.from("durable publication bytes\n");
      await writeFile(source, expected);
      const proofPath = crashPoint === "after_ancestor_creation_before_parent_fsync"
        ? join(outer, "ancestor-fsync-proof.txt")
        : undefined;
      const terminated = await runFixture({ root, source, operation, crashPoint });
      expect(terminated.signal).toBe("SIGKILL");
      const replay = await runFixture({ root, source, operation,
        ...(proofPath === undefined ? {} : { proofPath }) });
      expect(replay).toMatchObject({ code: 0, signal: null });
      const target = operation === "copy"
        ? join(root, "copy", "nested", "copy.bin")
        : join(root, "one", "two", "evidence.bin");
      const published = await readFile(target);
      expect(published).toEqual(expected);
      expect(sha(published)).toBe(sha(expected));
      expect(await publicationTemps(dirname(target))).toEqual([]);
      if (proofPath !== undefined) {
        expect((await readFile(proofPath, "utf8")).trim().split("\n")).toEqual([
          join(root, "one"),
          join(root, "one", "two"),
        ]);
      }

      const custody = new LocalProjectControlEvidenceCustody();
      if (operation === "copy") {
        await custody.copyImmutableFile({
          sourcePath: source,
          expectedSha256: sha(expected),
          expectedLength: expected.length,
          maxBytes: 1024 * 1024,
          root,
          directories: ["copy", "nested"],
          fileName: "copy.bin",
        });
      } else {
        await custody.publishImmutableBytes({
          root,
          directories: ["one", "two"],
          fileName: "evidence.bin",
          bytes: expected,
          expectedSha256: sha(expected),
        });
      }
      expect(await readFile(target)).toEqual(expected);
    });

  it("fsyncs each ensured ancestor parent when every mkdir returns EEXIST", async () => {
    const outer = await mkdtemp(join(tmpdir(), "custody-existing-ancestors-"));
    const root = join(outer, "root");
    await mkdir(join(root, "one", "two"), { recursive: true });
    const ensured: string[] = [];
    const custody = new LocalProjectControlEvidenceCustody((point, path) => {
      if (point === "before_ancestor_parent_fsync") ensured.push(path);
    });
    const bytes = Buffer.from("existing ancestors\n");
    await custody.publishImmutableBytes({
      root,
      directories: ["one", "two"],
      fileName: "evidence.bin",
      bytes,
      expectedSha256: sha(bytes),
    });
    expect(ensured).toEqual([join(root, "one"), join(root, "one", "two")]);
  });
});

async function runFixture(input: {
  readonly root: string;
  readonly source: string;
  readonly operation: "bytes" | "copy";
  readonly crashPoint?: string;
  readonly proofPath?: string;
}): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", fixturePath], {
      env: {
        ...process.env,
        CUSTODY_FIXTURE_ROOT: input.root,
        CUSTODY_FIXTURE_SOURCE: input.source,
        CUSTODY_FIXTURE_OPERATION: input.operation,
        ...(input.crashPoint
          ? { CUSTODY_FIXTURE_CRASH_POINT: input.crashPoint }
          : {}),
        ...(input.proofPath
          ? { CUSTODY_FIXTURE_PROOF_PATH: input.proofPath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code && signal === null) reject(new Error(stderr));
      else resolve({ code, signal });
    });
  });
}

async function publicationTemps(path: string): Promise<readonly string[]> {
  return (await readdir(path)).filter((name) =>
    name.startsWith(".custody-publish-") && name.endsWith(".tmp")
  );
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
