import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
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
const fixtureDeadlineMs = 10_000;
const fixtureMaxStderrBytes = 64 * 1024;

describe("local project-control evidence custody durability", () => {
  it("classifies a leaf relative to an open no-follow parent capability", async () => {
    const outer = await mkdtemp(join(tmpdir(), "custody-inspection-"));
    const parent = join(outer, "parent");
    const moved = join(outer, "moved-parent");
    const outside = join(outer, "outside");
    await Promise.all([parent, outside].map((path) => mkdir(path)));
    await writeFile(join(parent, "file"), "inside\n");
    await mkdir(join(parent, "directory"));
    await symlink(join(parent, "file"), join(parent, "symlink"));
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(join(parent, "other"), resolve);
    });
    await writeFile(join(outside, "sentinel"), "outside\n");
    const custody = new LocalProjectControlEvidenceCustody();
    const inspection = await custody.openDirectoryForInspection(parent);
    expect(inspection.canonicalPath).toBe(parent);
    expect(await inspection.pathKind("file")).toBe("file");
    expect(await inspection.pathKind("directory")).toBe("directory");
    expect(await inspection.pathKind("symlink")).toBe("symlink");
    expect(await inspection.pathKind("other")).toBe("other");
    expect(await inspection.pathKind("absent")).toBe("absent");
    for (const invalid of ["", ".", "..", "/absolute", "a/b", "a\\b"]) {
      await expect(inspection.pathKind(invalid)).rejects.toThrow("path_invalid");
    }
    await rename(parent, moved);
    await symlink(outside, parent, "dir");
    await expect(inspection.pathKind("sentinel")).rejects.toThrow(
      "inspection_parent_drift",
    );
    await inspection.close();
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => error ? reject(error) : resolve())
    );
    await expect(inspection.pathKind("file")).rejects.toThrow(
      "inspection_closed",
    );
  });

  it("rejects a symlinked inspection parent", async () => {
    const outer = await mkdtemp(join(tmpdir(), "custody-inspection-link-"));
    const outside = join(outer, "outside");
    await mkdir(outside);
    await symlink(outside, join(outer, "linked"), "dir");
    const custody = new LocalProjectControlEvidenceCustody();
    await expect(custody.openDirectoryForInspection(join(outer, "linked")))
      .rejects.toThrow();
  });

  it("rejects a parent swap during custody pathKind absence proof", async () => {
    const outer = await mkdtemp(join(tmpdir(), "custody-path-kind-race-"));
    const parent = join(outer, "parent");
    const moved = join(outer, "moved-parent");
    const outside = join(outer, "outside");
    await Promise.all([parent, outside].map((path) => mkdir(path)));
    const candidate = join(parent, "missing");
    let swapped = false;
    const custody = new LocalProjectControlEvidenceCustody(async (point, path) => {
      if (point !== "after_path_classification_before_parent_revalidation" ||
        path !== candidate || swapped) return;
      swapped = true;
      await rename(parent, moved);
      await symlink(outside, parent, "dir");
    });
    await expect(custody.pathKind(candidate)).rejects.toThrow(
      "inspection_parent_drift",
    );
    expect(swapped).toBe(true);
  });

  it.each(["read", "inspect", "copy"] as const)(
    "rejects deterministic lexical leaf replacement after a held-FD %s",
    async (operation) => {
      const outer = await mkdtemp(join(tmpdir(), "custody-leaf-race-"));
      const source = join(outer, "source.patch");
      const displaced = join(outer, "source.original.patch");
      const oldBytes = Buffer.from("diff --git a/old b/old\nold bytes\n");
      const replacement = Buffer.from("diff --git a/new b/new\nnew bytes\n");
      await writeFile(source, oldBytes);
      let replaced = false;
      const custody = new LocalProjectControlEvidenceCustody(
        async (point, path) => {
          const expectedPoint = operation === "copy"
            ? "after_copy_read_before_lexical_reopen"
            : "after_immutable_read_before_lexical_reopen";
          if (point !== expectedPoint || path !== source || replaced) return;
          replaced = true;
          await rename(source, displaced);
          await writeFile(source, replacement);
        },
      );
      if (operation === "read") {
        await expect(custody.readImmutableFile(source, 1024 * 1024))
          .rejects.toThrow("file_changed_during_read");
      } else if (operation === "inspect") {
        await expect(custody.inspectImmutablePatch(source, 1024 * 1024))
          .rejects.toThrow("file_changed_during_read");
      } else {
        const root = join(outer, "evidence");
        await mkdir(root);
        await expect(custody.copyImmutableFile({
          sourcePath: source,
          expectedSha256: sha(oldBytes),
          expectedLength: oldBytes.length,
          maxBytes: 1024 * 1024,
          root,
          directories: ["copies"],
          fileName: "source.patch",
        })).rejects.toThrow("source_drift");
        await expect(readFile(join(root, "copies", "source.patch")))
          .rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(replaced).toBe(true);
      expect(await readFile(source)).toEqual(replacement);
      expect(await readFile(displaced)).toEqual(oldBytes);
    },
  );

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

  it("kills and reaps a fixture that exceeds its evidence deadline", async () => {
    const outer = await mkdtemp(join(tmpdir(), "custody-deadline-"));
    const root = join(outer, "root");
    await mkdir(root);
    let fixturePid: number | undefined;
    await expect(runFixture({
      root,
      source: join(outer, "unused-source"),
      operation: "bytes",
      hang: true,
      deadlineMs: 100,
      onSpawn: (pid) => { fixturePid = pid; },
    })).rejects.toThrow("custody_fixture_deadline_exceeded");
    expect(fixturePid).toBeDefined();
    let reapError: NodeJS.ErrnoException | undefined;
    try {
      process.kill(fixturePid!, 0);
    } catch (error) {
      reapError = error as NodeJS.ErrnoException;
    }
    expect(reapError?.code).toBe("ESRCH");
  });
});

async function runFixture(input: {
  readonly root: string;
  readonly source: string;
  readonly operation: "bytes" | "copy";
  readonly crashPoint?: string;
  readonly proofPath?: string;
  readonly hang?: boolean;
  readonly deadlineMs?: number;
  readonly onSpawn?: (pid: number) => void;
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
        ...(input.hang ? { CUSTODY_FIXTURE_HANG: "1" } : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid !== undefined) input.onSpawn?.(child.pid);
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    const onStderr = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = fixtureMaxStderrBytes - stderrBytes;
      if (remaining <= 0) return;
      const captured = chunk.subarray(0, remaining);
      stderr.push(captured);
      stderrBytes += captured.length;
    };
    const cleanup = () => {
      if (deadline !== undefined) clearTimeout(deadline);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onError = (error: Error) => {
      spawnError = error;
      if (child.pid === undefined) {
        cleanup();
        reject(error);
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (timedOut) {
        reject(new Error("custody_fixture_deadline_exceeded"));
      } else if (spawnError !== undefined) {
        reject(spawnError);
      } else if (code && signal === null) {
        reject(new Error(Buffer.concat(stderr, stderrBytes).toString("utf8")));
      } else {
        resolve({ code, signal });
      }
    };
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.deadlineMs ?? fixtureDeadlineMs);
    deadline.unref();
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
