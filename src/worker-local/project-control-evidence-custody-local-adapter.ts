import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  EvidenceDirectoryEntry,
  ImmutableEvidenceFile,
  ImmutablePatchEvidence,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";

export class LocalProjectControlEvidenceCustody implements
    ProjectControlEvidenceCustodyPort {
  constructor(private readonly crashHook?: PublicationCrashHook) {}

  async canonicalDirectory(path: string, allowMissing = false): Promise<string> {
    const lexical = resolve(path);
    try {
      const handle = await openAbsoluteDirectoryNoSymlinks(lexical);
      await handle.close();
      return lexical;
    } catch (error) {
      if (allowMissing && deepCode(error) === "ENOENT") return lexical;
      throw error;
    }
  }

  async readImmutableFile(path: string, maxBytes: number): Promise<ImmutableEvidenceFile> {
    const lexical = resolve(path);
    const handle = await openAbsoluteFileNoSymlinks(lexical);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) {
        throw new Error("evidence_custody_file_invalid");
      }
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes - length + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
        if (bytesRead === 0) break;
        const exact = chunk.subarray(0, bytesRead);
        chunks.push(exact);
        hash.update(exact);
        length += bytesRead;
        if (length > maxBytes) throw new Error("evidence_custody_file_invalid");
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || after.size !== length) {
        throw new Error("evidence_custody_file_changed_during_read");
      }
      return {
        canonicalPath: lexical,
        sha256: hash.digest("hex"),
        length,
        bytes: Buffer.concat(chunks, length),
      };
    } finally {
      await handle.close();
    }
  }

  async inspectImmutablePatch(path: string, maxBytes: number): Promise<ImmutablePatchEvidence> {
    const lexical = resolve(path);
    const handle = await openAbsoluteFileNoSymlinks(lexical);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) {
        throw new Error("evidence_custody_file_invalid");
      }
      const hash = createHash("sha256");
      const commits: string[] = [];
      const baseCommits: string[] = [];
      const changedPathPairs: [string, string][] = [];
      let pending = Buffer.alloc(0);
      let length = 0;
      const consume = (line: string) => {
        const commit = /^From ([a-f0-9]{40}(?:[a-f0-9]{24})?) /i.exec(line);
        if (commit) commits.push(commit[1]!.toLowerCase());
        const base = /^base-commit: ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.exec(line);
        if (base) baseCommits.push(base[1]!.toLowerCase());
        const paths = /^diff --git a\/([^\n]+) b\/([^\n]+)$/.exec(line);
        if (paths) changedPathPairs.push([paths[1]!, paths[2]!]);
      };
      const stream = handle.createReadStream({ autoClose: false });
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        hash.update(chunk);
        length += chunk.length;
        if (length > maxBytes) throw new Error("evidence_custody_file_invalid");
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) break;
          consume(pending.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
          pending = pending.subarray(newline + 1);
        }
        if (pending.length > 16 * 1024) {
          throw new Error("evidence_custody_patch_line_too_long");
        }
      }
      if (pending.length > 0) consume(pending.toString("utf8").replace(/\r$/, ""));
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || after.size !== length) {
        throw new Error("evidence_custody_file_changed_during_read");
      }
      return {
        canonicalPath: lexical,
        sha256: hash.digest("hex"),
        length,
        commits,
        baseCommits,
        changedPathPairs,
      };
    } finally { await handle.close(); }
  }

  async pathKind(path: string) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) return "symlink" as const;
      if (metadata.isFile()) return "file" as const;
      if (metadata.isDirectory()) return "directory" as const;
      return "other" as const;
    } catch (error) {
      if (code(error) === "ENOENT") return "absent" as const;
      throw error;
    }
  }

  async listDirectory(path: string): Promise<readonly EvidenceDirectoryEntry[]> {
    let handle;
    try {
      handle = await openAbsoluteDirectoryNoSymlinks(path);
      return (await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true }))
        .map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" as const :
          entry.isDirectory() ? "directory" as const : "other" as const,
        }));
    } catch (error) {
      if (deepCode(error) === "ENOENT") return [];
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async publishImmutableBytes(input: {
    readonly root: string; readonly directories: readonly string[];
    readonly fileName: string; readonly bytes: Uint8Array;
    readonly expectedSha256: string;
  }) {
    if (createHash("sha256").update(input.bytes).digest("hex") !==
      input.expectedSha256) throw new Error("evidence_custody_source_drift");
    const boundary = await openBoundary(input.root, input.directories);
    try {
      return await publishThroughHandle({
        parentFd: boundary.handle.fd,
        lexicalPath: join(resolve(input.root), ...input.directories, input.fileName),
        fileName: input.fileName,
        expectedSha256: input.expectedSha256,
        expectedLength: input.bytes.byteLength,
        write: async (handle) => await handle.writeFile(input.bytes),
        ...(this.crashHook ? { crashHook: this.crashHook } : {}),
      });
    } finally {
      await boundary.handle.close();
    }
  }

  async copyImmutableFile(input: {
    readonly sourcePath: string; readonly expectedSha256: string;
    readonly expectedLength: number; readonly maxBytes: number;
    readonly root: string; readonly directories: readonly string[];
    readonly fileName: string;
  }) {
    const sourcePath = resolve(input.sourcePath);
    const source = await openAbsoluteFileNoSymlinks(sourcePath);
    let boundary: Awaited<ReturnType<typeof openBoundary>> | undefined;
    try {
      boundary = await openBoundary(input.root, input.directories);
      const before = await source.stat();
      if (!before.isFile() || before.size !== input.expectedLength ||
        before.size > input.maxBytes) throw new Error("evidence_custody_source_drift");
      return await copyThroughHandle({
        source,
        sourceBefore: before,
        maxBytes: input.maxBytes,
        parentFd: boundary.handle.fd,
        lexicalPath: join(resolve(input.root), ...input.directories, input.fileName),
        fileName: input.fileName,
        expectedSha256: input.expectedSha256,
        expectedLength: input.expectedLength,
        ...(this.crashHook ? { crashHook: this.crashHook } : {}),
      });
    } finally {
      await source.close();
      await boundary?.handle.close();
    }
  }
}

async function openBoundary(root: string, directories: readonly string[]) {
  const canonicalRoot = resolve(root);
  let handle = await openAbsoluteDirectoryNoSymlinks(canonicalRoot);
  for (const segment of directories) {
    safeSegment(segment);
    const child = `/proc/self/fd/${handle.fd}/${segment}`;
    try {
      await mkdir(child, { mode: 0o700 });
      await handle.sync();
    } catch (error) {
      if (code(error) !== "EEXIST") {
        await handle.close();
        throw error;
      }
    }
    let next;
    try {
      next = await open(child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      await handle.close();
      throw new Error("evidence_custody_ancestor_unsafe", { cause: error });
    }
    await handle.close();
    handle = next;
  }
  return { handle };
}

async function openAbsoluteDirectoryNoSymlinks(path: string) {
  const lexical = resolve(path);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const segments = lexical.split("/").filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      safeSegment(segment);
      let next;
      try {
        next = await open(`/proc/self/fd/${handle.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (index === segments.length - 1) {
          throw custodyError("evidence_custody_root_noncanonical", error);
        }
        throw error;
      }
      await handle.close();
      handle = next;
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_root_noncanonical");
    }
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof Error &&
      error.message === "evidence_custody_root_noncanonical") throw error;
    throw custodyError("evidence_custody_ancestor_unsafe", error);
  }
}

async function openAbsoluteFileNoSymlinks(path: string) {
  const lexical = resolve(path);
  const parent = await openAbsoluteDirectoryNoSymlinks(dirname(lexical));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(`/proc/self/fd/${parent.fd}/${basename(lexical)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW);
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      await handle.close();
      handle = undefined;
      throw new Error("evidence_custody_file_noncanonical");
    }
    return handle;
  } catch (error) {
    await handle?.close();
    if (error instanceof Error &&
      error.message === "evidence_custody_file_noncanonical") throw error;
    throw custodyError("evidence_custody_file_noncanonical", error);
  } finally {
    await parent.close();
  }
}

async function copyThroughHandle(input: {
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly sourceBefore: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;
  readonly maxBytes: number; readonly parentFd: number; readonly lexicalPath: string;
  readonly fileName: string; readonly expectedSha256: string;
  readonly expectedLength: number;
  readonly crashHook?: PublicationCrashHook;
}) {
  return await publishThroughHandle({
    parentFd: input.parentFd,
    lexicalPath: input.lexicalPath,
    fileName: input.fileName,
    expectedSha256: input.expectedSha256,
    expectedLength: input.expectedLength,
    ...(input.crashHook ? { crashHook: input.crashHook } : {}),
    write: async (target) => {
      const hash = createHash("sha256");
      let length = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        const { bytesRead } = await input.source.read(
          chunk,
          0,
          chunk.length,
          length,
        );
        if (bytesRead === 0) break;
        const exact = chunk.subarray(0, bytesRead);
        hash.update(exact);
        await target.write(exact);
        length += bytesRead;
        if (length > input.maxBytes) {
          throw new Error("evidence_custody_source_drift");
        }
      }
      const after = await input.source.stat();
      if (input.sourceBefore.dev !== after.dev || input.sourceBefore.ino !== after.ino ||
        input.sourceBefore.size !== after.size || length !== input.expectedLength ||
        hash.digest("hex") !== input.expectedSha256) {
        throw new Error("evidence_custody_source_drift");
      }
    },
  });
}

type PublicationCrashHook = (
  point:
    | "after_temp_write"
    | "after_temp_fsync"
    | "after_publish_before_directory_fsync"
    | "after_directory_fsync",
  path: string,
) => Promise<void> | void;

async function publishThroughHandle(input: {
  readonly parentFd: number; readonly lexicalPath: string; readonly fileName: string;
  readonly expectedSha256: string; readonly expectedLength: number;
  readonly write: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
  readonly crashHook?: PublicationCrashHook;
}) {
  safeSegment(input.fileName);
  const parent = `/proc/self/fd/${input.parentFd}`;
  const path = `${parent}/${input.fileName}`;
  try {
    const existing = await readViaHandle(path, input.expectedLength);
    if (existing.sha256 !== input.expectedSha256 ||
      existing.length !== input.expectedLength) {
      throw new Error("evidence_custody_immutable_conflict");
    }
    await syncDirectory(parent);
    if (await cleanPublicationTemps({
      parent,
      fileName: input.fileName,
      expectedSha256: input.expectedSha256,
      expectedLength: input.expectedLength,
      removeMatching: true,
    })) await syncDirectory(parent);
    return { path: input.lexicalPath, created: false };
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  if (await cleanPublicationTemps({
    parent,
    fileName: input.fileName,
    expectedSha256: input.expectedSha256,
    expectedLength: input.expectedLength,
    removeMatching: false,
  })) await syncDirectory(parent);
  const temporaryName = publicationTemporaryName(input.fileName);
  const temporaryPath = `${parent}/${temporaryName}`;
  const target = await open(temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600);
  let targetClosed = false;
  let temporaryExists = true;
  let simulatedCrash = false;
  let published = false;
  try {
    await input.write(target);
    try {
      await input.crashHook?.("after_temp_write", input.lexicalPath);
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    await target.sync();
    await target.close();
    targetClosed = true;
    try {
      await input.crashHook?.("after_temp_fsync", input.lexicalPath);
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    try {
      await link(temporaryPath, path);
      published = true;
    } catch (error) {
      if (code(error) !== "EEXIST" && code(error) !== "ENOENT") throw error;
      const existing = await readViaHandle(path, input.expectedLength);
      if (existing.sha256 !== input.expectedSha256 ||
        existing.length !== input.expectedLength) {
        throw new Error("evidence_custody_immutable_conflict");
      }
      await unlink(temporaryPath).catch((unlinkError) => {
        if (code(unlinkError) !== "ENOENT") throw unlinkError;
      });
      temporaryExists = false;
      await syncDirectory(parent);
      return { path: input.lexicalPath, created: false };
    }
    try {
      await input.crashHook?.(
        "after_publish_before_directory_fsync",
        input.lexicalPath,
      );
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    await syncDirectory(parent);
    try {
      await input.crashHook?.("after_directory_fsync", input.lexicalPath);
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    await syncDirectory(parent);
    if (await cleanPublicationTemps({
      parent,
      fileName: input.fileName,
      expectedSha256: input.expectedSha256,
      expectedLength: input.expectedLength,
      removeMatching: true,
    })) await syncDirectory(parent);
    return { path: input.lexicalPath, created: true };
  } finally {
    if (!targetClosed) await target.close().catch(() => undefined);
    if (temporaryExists && !simulatedCrash && !published) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function publicationTemporaryName(fileName: string): string {
  const identity = createHash("sha256").update(fileName).digest("hex").slice(0, 16);
  return `.custody-publish-${identity}-${process.pid}-${Date.now()}-${Math.random()
    .toString(16).slice(2)}.tmp`;
}

async function cleanPublicationTemps(input: {
  readonly parent: string;
  readonly fileName: string;
  readonly expectedSha256: string;
  readonly expectedLength: number;
  readonly removeMatching: boolean;
}): Promise<boolean> {
  const identity = createHash("sha256").update(input.fileName).digest("hex")
    .slice(0, 16);
  const prefix = `.custody-publish-${identity}-`;
  const staleBefore = Date.now() - 60 * 60_000;
  let removed = false;
  for (const entry of await readdir(input.parent, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".tmp")) continue;
    const path = `${input.parent}/${entry.name}`;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    let matching = false;
    try {
      const identity = await readViaHandle(path, input.expectedLength);
      matching = identity.length === input.expectedLength &&
        identity.sha256 === input.expectedSha256;
    } catch (error) {
      if (code(error) === "ENOENT") continue;
    }
    if (!(input.removeMatching && matching) && metadata.mtimeMs >= staleBefore) {
      continue;
    }
    await unlink(path).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
    });
    removed = true;
  }
  return removed;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readViaHandle(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error("evidence_custody_file_invalid");
    }
    const bytes = await handle.readFile();
    return {
      length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally { await handle.close(); }
}

function safeSegment(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") ||
    value.includes("\\")) throw new Error("evidence_custody_path_invalid");
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

function deepCode(error: unknown): string | undefined {
  const direct = code(error);
  if (direct) return direct;
  return error instanceof Error && error.cause !== undefined
    ? deepCode(error.cause)
    : undefined;
}

function custodyError(message: string, cause: unknown): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(message, { cause });
  const causeCode = deepCode(cause);
  if (causeCode !== undefined) error.code = causeCode;
  return error;
}
