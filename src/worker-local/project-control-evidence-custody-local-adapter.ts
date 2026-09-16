import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  EvidenceDirectoryEntry,
  EvidenceDirectoryInspection,
  EvidencePathKind,
  ImmutableEvidenceFile,
  ImmutablePatchEvidence,
  ProjectControlCustodyBootstrapCertification,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";
import { materializeApprovedProjectControlCustody } from
  "./project-control-evidence-custody-materialization";

export class LocalProjectControlEvidenceCustody implements
    ProjectControlEvidenceCustodyPort {
  constructor(private readonly crashHook?: PublicationCrashHook) {}

  async materializeApprovedProjectControlCustody(input: {
    readonly approvedAnchor: string;
    readonly ledgerRoots: readonly string[];
    readonly evidenceRoots: readonly string[];
    readonly deniedRoots: readonly string[];
  }): Promise<ProjectControlCustodyBootstrapCertification> {
    assertLocalProjectControlEvidenceCustodySupported();
    return await materializeApprovedProjectControlCustody(input, this.crashHook);
  }

  async canonicalDirectory(path: string, allowMissing = false): Promise<string> {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    try {
      const handle = await openAbsoluteDirectoryNoSymlinks(lexical);
      await handle.close();
      return lexical;
    } catch (error) {
      if (allowMissing && deepCode(error) === "ENOENT" &&
        await this.pathKind(lexical) === "absent") return lexical;
      throw error;
    }
  }

  async readImmutableFile(path: string, maxBytes: number): Promise<ImmutableEvidenceFile> {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    const held = await openAbsoluteFileNoSymlinks(lexical);
    const handle = held.handle;
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
      await this.crashHook?.("after_immutable_read_before_lexical_reopen", lexical);
      await assertHeldLexicalFile(held, before,
        "evidence_custody_file_changed_during_read");
      return {
        canonicalPath: lexical,
        sha256: hash.digest("hex"),
        length,
        bytes: Buffer.concat(chunks, length),
      };
    } finally {
      await closeHeldLexicalFile(held);
    }
  }

  async inspectImmutablePatch(path: string, maxBytes: number): Promise<ImmutablePatchEvidence> {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    const held = await openAbsoluteFileNoSymlinks(lexical);
    const handle = held.handle;
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
      await this.crashHook?.("after_immutable_read_before_lexical_reopen", lexical);
      await assertHeldLexicalFile(held, before,
        "evidence_custody_file_changed_during_read");
      return {
        canonicalPath: lexical,
        sha256: hash.digest("hex"),
        length,
        commits,
        baseCommits,
        changedPathPairs,
      };
    } finally { await closeHeldLexicalFile(held); }
  }

  async pathKind(path: string) {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    if (lexical === "/") return "directory" as const;
    let candidate = lexical;
    for (;;) {
      const parent = dirname(candidate);
      try {
        const inspection = await this.openDirectoryForInspection(parent);
        try {
          const kind = await inspection.pathKind(basename(candidate));
          if (candidate === lexical || kind === "absent") return kind;
          candidate = lexical;
        } finally {
          await inspection.close();
        }
      } catch (error) {
        if (deepCode(error) !== "ENOENT") throw error;
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
  }

  async openDirectoryForInspection(path: string): Promise<EvidenceDirectoryInspection> {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    const parentPath = dirname(lexical);
    const parent = lexical === "/"
      ? undefined
      : await openAbsoluteDirectoryNoSymlinks(parentPath);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = parent
        ? await open(`/proc/self/fd/${parent.fd}/${basename(lexical)}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        : await openAbsoluteDirectoryNoSymlinks(lexical);
    } catch (error) {
      await parent?.close();
      throw error;
    }
    let identity: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      identity = await handle.stat();
      await assertInspectionLexicalBinding({ lexical, handle, parent, identity });
    } catch (error) {
      await handle.close().catch(() => undefined);
      await parent?.close().catch(() => undefined);
      throw error;
    }
    let closed = false;
    return {
      canonicalPath: lexical,
      pathKind: async (entryName: string): Promise<EvidencePathKind> => {
        if (closed) throw new Error("evidence_custody_inspection_closed");
        safeSegment(entryName);
        await assertInspectionLexicalBinding({ lexical, handle, parent, identity });
        let kind: EvidencePathKind;
        try {
          const metadata = await lstat(`/proc/self/fd/${handle.fd}/${entryName}`);
          kind = metadata.isSymbolicLink() ? "symlink" :
            metadata.isFile() ? "file" :
            metadata.isDirectory() ? "directory" : "other";
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
          kind = "absent";
        }
        await this.crashHook?.(
          "after_path_classification_before_parent_revalidation",
          join(lexical, entryName),
        );
        await assertInspectionLexicalBinding({ lexical, handle, parent, identity });
        return kind;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.close();
        await parent?.close();
      },
    };
  }

  async listDirectory(path: string): Promise<readonly EvidenceDirectoryEntry[]> {
    assertLocalProjectControlEvidenceCustodySupported();
    const lexical = resolve(path);
    let held: HeldLexicalDirectory;
    try {
      held = await openHeldLexicalDirectory(lexical);
    } catch (error) {
      const missingDirectory = deepCode(error) === "ENOENT" ||
        (error instanceof Error &&
          error.message === "evidence_custody_root_noncanonical");
      if (missingDirectory && await this.pathKind(lexical) === "absent") {
        return [];
      }
      throw error;
    }
    try {
      const entries = (await readdir(`/proc/self/fd/${held.handle.fd}`,
        { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" as const :
          entry.isDirectory() ? "directory" as const :
          entry.isSymbolicLink() ? "symlink" as const : "other" as const,
      }));
      await this.crashHook?.("after_directory_listing_before_lexical_revalidation",
        lexical);
      await assertHeldLexicalDirectory(held);
      return entries;
    } finally {
      await closeHeldLexicalDirectory(held);
    }
  }

  async publishImmutableBytes(input: {
    readonly root: string; readonly directories: readonly string[];
    readonly fileName: string; readonly bytes: Uint8Array;
    readonly expectedSha256: string;
  }) {
    assertLocalProjectControlEvidenceCustodySupported();
    if (createHash("sha256").update(input.bytes).digest("hex") !==
      input.expectedSha256) throw new Error("evidence_custody_source_drift");
    const boundary = await openBoundary(input.root, input.directories,
      this.crashHook);
    try {
      return await publishThroughHandle({
        parentFd: boundary.handle.fd,
        lexicalPath: join(resolve(input.root), ...input.directories, input.fileName),
        fileName: input.fileName,
        expectedSha256: input.expectedSha256,
        expectedLength: input.bytes.byteLength,
        assertBoundary: boundary.assertBinding,
        assertSuccessBoundary: boundary.assertSuccessBinding,
        write: async (handle) => await writeAll(handle, input.bytes),
        ...(this.crashHook ? { crashHook: this.crashHook } : {}),
      });
    } finally {
      await boundary.close();
    }
  }

  async copyImmutableFile(input: {
    readonly sourcePath: string; readonly expectedSha256: string;
    readonly expectedLength: number; readonly maxBytes: number;
    readonly root: string; readonly directories: readonly string[];
    readonly fileName: string;
  }) {
    assertLocalProjectControlEvidenceCustodySupported();
    const sourcePath = resolve(input.sourcePath);
    const source = await openAbsoluteFileNoSymlinks(sourcePath);
    let boundary: Awaited<ReturnType<typeof openBoundary>> | undefined;
    try {
      boundary = await openBoundary(input.root, input.directories,
        this.crashHook);
      const before = await source.handle.stat();
      if (!before.isFile() || before.size !== input.expectedLength ||
        before.size > input.maxBytes) throw new Error("evidence_custody_source_drift");
      return await copyThroughHandle({
        source: source.handle,
        sourceBefore: before,
        assertSourceLexical: async () => {
          await this.crashHook?.(
            "after_copy_read_before_lexical_reopen",
            sourcePath,
          );
          await assertHeldLexicalFile(source, before,
            "evidence_custody_source_drift");
        },
        maxBytes: input.maxBytes,
        parentFd: boundary.handle.fd,
        lexicalPath: join(resolve(input.root), ...input.directories, input.fileName),
        fileName: input.fileName,
        expectedSha256: input.expectedSha256,
        expectedLength: input.expectedLength,
        assertBoundary: boundary.assertBinding,
        assertSuccessBoundary: boundary.assertSuccessBinding,
        ...(this.crashHook ? { crashHook: this.crashHook } : {}),
      });
    } finally {
      await closeHeldLexicalFile(source);
      await boundary?.close();
    }
  }
}

/**
 * This adapter uses Linux procfs fd paths so traversal stays relative to held
 * directory handles. Falling back to lexical paths would reintroduce TOCTOU
 * races at the evidence boundary, so unsupported hosts fail closed.
 */
export const localProjectControlEvidenceCustodySupported =
  process.platform === "linux";

export function assertLocalProjectControlEvidenceCustodySupported(): void {
  if (!localProjectControlEvidenceCustodySupported) {
    throw new Error("project_control_evidence_custody_platform_unsupported");
  }
}

async function openBoundary(root: string, directories: readonly string[],
  crashHook?: PublicationCrashHook) {
  const canonicalRoot = resolve(root);
  const rootHandle = await openAbsoluteDirectoryNoSymlinks(canonicalRoot);
  let rootIdentity: Awaited<ReturnType<FileHandle["stat"]>>;
  try {
    rootIdentity = await rootHandle.stat();
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    throw error;
  }
  const chain: HeldBoundaryDirectory[] = [{
    lexical: canonicalRoot,
    handle: rootHandle,
    parent: undefined,
    identity: rootIdentity,
  }];
  let handle = rootHandle;
  try {
    for (const [index, segment] of directories.entries()) {
      safeSegment(segment);
      const child = `/proc/self/fd/${handle.fd}/${segment}`;
      let created = false;
      try {
        await mkdir(child, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      let next: FileHandle | undefined;
      try {
        next = await open(child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        throw new Error("evidence_custody_ancestor_unsafe", { cause: error });
      }
      try {
        if (created) {
          await crashHook?.("after_ancestor_creation_before_parent_fsync",
            join(canonicalRoot, ...directories.slice(0, index + 1)));
        }
        await crashHook?.("before_ancestor_parent_fsync",
          join(canonicalRoot, ...directories.slice(0, index + 1)));
        await handle.sync();
        await crashHook?.("after_ancestor_parent_fsync",
          join(canonicalRoot, ...directories.slice(0, index + 1)));
        handle = next;
        chain.push({
          lexical: join(canonicalRoot, ...directories.slice(0, index + 1)),
          handle,
          parent: chain[index]!.handle,
          identity: await handle.stat(),
        });
        next = undefined;
      } finally {
        await next?.close().catch(() => undefined);
      }
    }
    return {
      handle,
      assertBinding: async () => await assertHeldBoundaryChain(chain),
      assertSuccessBinding: async () => {
        await crashHook?.("before_publication_success_boundary_revalidation",
          canonicalRoot);
        await assertHeldBoundaryChain(chain);
      },
      close: async () => {
        let closeError: unknown;
        for (const directory of [...chain].reverse()) {
          try {
            await directory.handle.close();
          } catch (error) {
            closeError ??= error;
          }
        }
        if (closeError) throw closeError;
      },
    };
  } catch (error) {
    for (const directory of [...chain].reverse()) {
      await directory.handle.close().catch(() => undefined);
    }
    throw error;
  }
}

type HeldBoundaryDirectory = Parameters<typeof assertInspectionLexicalBinding>[0];
async function assertHeldBoundaryChain(
  chain: readonly HeldBoundaryDirectory[]): Promise<void> {
  try {
    const root = chain[0]!;
    await assertHeldRootLexicalBinding(root.lexical, root.handle, root.identity);
    for (const directory of chain.slice(1)) {
      await assertInspectionLexicalBinding(directory);
    }

    const final = chain.at(-1)!;
    const reopenedFinal = await openAbsoluteDirectoryNoSymlinks(final.lexical);
    try {
      const identity = await reopenedFinal.stat();
      if (identity.dev !== final.identity.dev || identity.ino !== final.identity.ino) {
        throw new Error("evidence_custody_publication_boundary_drift");
      }
    } finally {
      await reopenedFinal.close();
    }
  } catch (error) {
    if (error instanceof Error &&
      (error.message === "evidence_custody_publication_boundary_drift" ||
        error.message === "evidence_custody_publication_root_drift")) throw error;
    throw new Error("evidence_custody_publication_boundary_drift", { cause: error });
  }
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

type HeldLexicalDirectory = {
  readonly lexical: string;
  readonly handle: FileHandle;
  readonly parent: FileHandle | undefined;
  readonly identity: Awaited<ReturnType<FileHandle["stat"]>>;
};

async function openHeldLexicalDirectory(
  lexical: string,
): Promise<HeldLexicalDirectory> {
  const parent = lexical === "/"
    ? undefined
    : await openAbsoluteDirectoryNoSymlinks(dirname(lexical));
  let handle: FileHandle | undefined;
  try {
    handle = parent
      ? await open(`/proc/self/fd/${parent.fd}/${basename(lexical)}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      : await openAbsoluteDirectoryNoSymlinks(lexical);
    const identity = await handle.stat();
    const held = { lexical, handle, parent, identity };
    await assertHeldLexicalDirectory(held);
    return held;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
    throw error;
  }
}

async function assertHeldLexicalDirectory(held: HeldLexicalDirectory): Promise<void> {
  await assertInspectionLexicalBinding(held);
}

async function closeHeldLexicalDirectory(held: HeldLexicalDirectory): Promise<void> {
  await held.handle.close().finally(async () => await held.parent?.close());
}

async function assertHeldRootLexicalBinding(
  lexical: string,
  handle: FileHandle,
  identity: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> {
  let reopened: FileHandle | undefined;
  try {
    const current = await handle.stat();
    if (current.dev !== identity.dev || current.ino !== identity.ino ||
      await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_publication_root_drift");
    }
    reopened = await openAbsoluteDirectoryNoSymlinks(lexical);
    const lexicalCurrent = await reopened.stat();
    if (lexicalCurrent.dev !== identity.dev || lexicalCurrent.ino !== identity.ino) {
      throw new Error("evidence_custody_publication_root_drift");
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_publication_root_drift");
    }
  } catch (error) {
    if (error instanceof Error &&
      error.message === "evidence_custody_publication_root_drift") throw error;
    throw new Error("evidence_custody_publication_root_drift", { cause: error });
  } finally {
    await reopened?.close();
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
    return { handle, parent, lexical, fileName: basename(lexical) };
  } catch (error) {
    await handle?.close();
    await parent.close();
    if (error instanceof Error &&
      error.message === "evidence_custody_file_noncanonical") throw error;
    throw custodyError("evidence_custody_file_noncanonical", error);
  }
}

type HeldLexicalFile = Awaited<ReturnType<typeof openAbsoluteFileNoSymlinks>>;

async function closeHeldLexicalFile(held: HeldLexicalFile): Promise<void> {
  await held.handle.close().finally(async () => await held.parent.close());
}

async function assertHeldLexicalFile(
  held: HeldLexicalFile,
  identity: Awaited<ReturnType<FileHandle["stat"]>>,
  errorCode: string,
): Promise<void> {
  try {
    if (await realpath(`/proc/self/fd/${held.parent.fd}`) !== dirname(held.lexical)) {
      throw new Error(errorCode);
    }
    const reopened = await open(
      `/proc/self/fd/${held.parent.fd}/${held.fileName}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const current = await reopened.stat();
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(errorCode);
      }
    } finally {
      await reopened.close();
    }
    if (await realpath(`/proc/self/fd/${held.parent.fd}`) !== dirname(held.lexical)) {
      throw new Error(errorCode);
    }
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
}

async function assertInspectionLexicalBinding(input: {
  readonly lexical: string;
  readonly handle: FileHandle;
  readonly parent: FileHandle | undefined;
  readonly identity: Awaited<ReturnType<FileHandle["stat"]>>;
}): Promise<void> {
  try {
    const current = await input.handle.stat();
    if (current.dev !== input.identity.dev || current.ino !== input.identity.ino ||
      await realpath(`/proc/self/fd/${input.handle.fd}`) !== input.lexical) {
      throw new Error("evidence_custody_inspection_parent_drift");
    }
    if (!input.parent) return;
    if (await realpath(`/proc/self/fd/${input.parent.fd}`) !==
      dirname(input.lexical)) {
      throw new Error("evidence_custody_inspection_parent_drift");
    }
    const reopened = await open(
      `/proc/self/fd/${input.parent.fd}/${basename(input.lexical)}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const lexicalCurrent = await reopened.stat();
      if (lexicalCurrent.dev !== input.identity.dev ||
        lexicalCurrent.ino !== input.identity.ino) {
        throw new Error("evidence_custody_inspection_parent_drift");
      }
    } finally {
      await reopened.close();
    }
  } catch (error) {
    if (error instanceof Error &&
      error.message === "evidence_custody_inspection_parent_drift") throw error;
    throw new Error("evidence_custody_inspection_parent_drift", { cause: error });
  }
}

async function copyThroughHandle(input: {
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly sourceBefore: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;
  readonly assertSourceLexical: () => Promise<void>;
  readonly maxBytes: number; readonly parentFd: number; readonly lexicalPath: string;
  readonly fileName: string; readonly expectedSha256: string;
  readonly expectedLength: number;
  readonly assertBoundary: () => Promise<void>;
  readonly assertSuccessBoundary: () => Promise<void>;
  readonly crashHook?: PublicationCrashHook;
}) {
  return await publishThroughHandle({
    parentFd: input.parentFd,
    lexicalPath: input.lexicalPath,
    fileName: input.fileName,
    expectedSha256: input.expectedSha256,
    expectedLength: input.expectedLength,
    assertBoundary: input.assertBoundary,
    assertSuccessBoundary: input.assertSuccessBoundary,
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
        await writeAll(target, exact);
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
      await input.assertSourceLexical();
    },
  });
}

export type PublicationCrashHook = (
  point:
    | "after_immutable_read_before_lexical_reopen"
    | "after_copy_read_before_lexical_reopen"
    | "after_path_classification_before_parent_revalidation"
    | "after_directory_listing_before_lexical_revalidation"
    | "after_temp_write"
    | "after_temp_fsync"
    | "after_ancestor_creation_before_parent_fsync"
    | "before_ancestor_parent_fsync"
    | "after_ancestor_parent_fsync"
    | "after_custody_directory_creation_before_parent_fsync"
    | "before_custody_manifest_publication_revalidation"
    | "after_publish_before_directory_fsync"
    | "after_directory_fsync"
    | "before_publication_success_boundary_revalidation",
  path: string,
) => Promise<void> | void;

async function publishThroughHandle(input: {
  readonly parentFd: number; readonly lexicalPath: string; readonly fileName: string;
  readonly expectedSha256: string; readonly expectedLength: number;
  readonly assertBoundary: () => Promise<void>;
  readonly assertSuccessBoundary: () => Promise<void>;
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
    await input.assertSuccessBoundary();
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
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
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
    const verified = await readViaOpenHandle(target, input.expectedLength);
    if (verified.length !== input.expectedLength ||
      verified.sha256 !== input.expectedSha256) {
      throw new Error("evidence_custody_publication_verification_failed");
    }
    try {
      await input.crashHook?.("after_temp_fsync", input.lexicalPath);
    } catch (error) {
      simulatedCrash = true;
      throw error;
    }
    await input.assertBoundary();
    try {
      await link(temporaryPath, path);
      published = true;
      const linked = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const linkedStat = await linked.stat();
        if (linkedStat.dev !== verified.dev || linkedStat.ino !== verified.ino) {
          throw new Error("evidence_custody_published_inode_mismatch");
        }
      } finally {
        await linked.close();
      }
      await input.assertBoundary();
    } catch (error) {
      if (error instanceof Error &&
        error.message === "evidence_custody_publication_boundary_drift") throw error;
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
      await input.assertSuccessBoundary();
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
    await input.assertBoundary();
    await syncDirectory(parent);
    await target.close();
    targetClosed = true;
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
    await input.assertSuccessBoundary();
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
    const read = await readViaOpenHandle(handle, maxBytes);
    let reopened: FileHandle | undefined;
    try {
      reopened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const lexical = await reopened.stat();
      if (lexical.dev !== read.dev || lexical.ino !== read.ino) {
        throw new Error("evidence_custody_file_changed_during_read");
      }
    } catch (error) {
      if (error instanceof Error &&
        error.message === "evidence_custody_file_changed_during_read") throw error;
      throw new Error("evidence_custody_file_changed_during_read", { cause: error });
    } finally {
      await reopened?.close();
    }
    return read;
  } finally { await handle.close(); }
}

async function readViaOpenHandle(handle: FileHandle, maxBytes: number) {
  const before = await handle.stat();
  if (!before.isFile() || before.size > maxBytes) {
    throw new Error("evidence_custody_file_invalid");
  }
  const hash = createHash("sha256");
  let length = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024,
      Math.max(1, maxBytes - length + 1)));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    length += bytesRead;
    if (length > maxBytes) throw new Error("evidence_custody_file_invalid");
  }
  const after = await handle.stat();
  if (before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || after.size !== length) {
    throw new Error("evidence_custody_file_changed_during_read");
  }
  return {
    dev: after.dev,
    ino: after.ino,
    length,
    sha256: hash.digest("hex"),
  };
}

/** Write the complete buffer even when the filesystem reports short writes. */
export async function writeAll(
  handle: Pick<FileHandle, "write">,
  bytes: Uint8Array,
): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer, offset, buffer.length - offset, null,
    );
    if (bytesWritten <= 0) {
      throw new Error("evidence_custody_write_no_progress");
    }
    offset += bytesWritten;
  }
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
