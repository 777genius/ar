import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SEARCH_FILES = 5_000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;

export type WorkspaceSearchMatch = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
};

export type BoundedWorkspaceFilesOptions = {
  readonly maxFileBytes?: number;
  readonly maxSearchBytes?: number;
  readonly maxSearchFiles?: number;
  readonly maxSearchResults?: number;
};

export class BoundedWorkspaceFiles {
  private readonly writeTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly root: string,
    private readonly limits: Required<BoundedWorkspaceFilesOptions>,
  ) {}

  static async create(
    workspaceRoot: string,
    options: BoundedWorkspaceFilesOptions = {},
  ): Promise<BoundedWorkspaceFiles> {
    const root = await realpath(workspaceRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("workspace_root_must_be_a_real_directory");
    }
    return new BoundedWorkspaceFiles(root, {
      maxFileBytes: positiveLimit(
        options.maxFileBytes,
        DEFAULT_MAX_FILE_BYTES,
        "maxFileBytes",
      ),
      maxSearchBytes: positiveLimit(
        options.maxSearchBytes,
        DEFAULT_MAX_SEARCH_BYTES,
        "maxSearchBytes",
      ),
      maxSearchFiles: positiveLimit(
        options.maxSearchFiles,
        DEFAULT_MAX_SEARCH_FILES,
        "maxSearchFiles",
      ),
      maxSearchResults: positiveLimit(
        options.maxSearchResults,
        DEFAULT_MAX_SEARCH_RESULTS,
        "maxSearchResults",
      ),
    });
  }

  async readFile(path: string): Promise<string> {
    const absolutePath = await this.resolveRegularFile(path, true);
    return this.readUtf8File(absolutePath);
  }

  async editFile(input: {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly replaceAll?: boolean;
  }): Promise<{ readonly replacements: number }> {
    if (input.oldText.length === 0) {
      throw new Error("workspace_edit_old_text_must_not_be_empty");
    }
    const absolutePath = await this.resolveRegularFile(input.path, true);
    return this.withWriteLock(absolutePath, async () => {
      const current = await this.readUtf8File(absolutePath);
      const replacements = occurrenceCount(current, input.oldText);
      if (replacements === 0) {
        throw new Error("workspace_edit_old_text_not_found");
      }
      if (input.replaceAll !== true && replacements !== 1) {
        throw new Error("workspace_edit_old_text_must_match_once");
      }
      const next = input.replaceAll === true
        ? current.split(input.oldText).join(input.newText)
        : current.replace(input.oldText, input.newText);
      await this.atomicWrite(absolutePath, next, true);
      return { replacements: input.replaceAll === true ? replacements : 1 };
    });
  }

  async writeFile(input: {
    readonly path: string;
    readonly content: string;
    readonly overwrite?: boolean;
  }): Promise<void> {
    const absolutePath = await this.resolveRegularFile(input.path, false);
    await this.withWriteLock(absolutePath, () =>
      this.atomicWrite(absolutePath, input.content, input.overwrite === true)
    );
  }

  async searchFiles(input: {
    readonly query: string;
    readonly path?: string;
    readonly maxResults?: number;
  }): Promise<readonly WorkspaceSearchMatch[]> {
    if (input.query.length === 0 || input.query.length > 512) {
      throw new Error("workspace_search_query_length_invalid");
    }
    const maxResults = positiveLimit(
      input.maxResults,
      this.limits.maxSearchResults,
      "maxResults",
    );
    if (maxResults > this.limits.maxSearchResults) {
      throw new Error("workspace_search_result_limit_exceeded");
    }
    const searchRoot = await this.resolveDirectory(input.path ?? ".");
    const matches: WorkspaceSearchMatch[] = [];
    let scannedBytes = 0;
    let scannedFiles = 0;

    for await (const absolutePath of walkRegularFiles(searchRoot)) {
      scannedFiles += 1;
      if (scannedFiles > this.limits.maxSearchFiles) {
        throw new Error("workspace_search_file_limit_exceeded");
      }
      let content: string;
      try {
        content = await this.readUtf8File(absolutePath);
      } catch (error) {
        if (isSkippableSearchFileError(error)) continue;
        throw error;
      }
      scannedBytes += Buffer.byteLength(content);
      if (scannedBytes > this.limits.maxSearchBytes) {
        throw new Error("workspace_search_byte_limit_exceeded");
      }
      const relativePath = relative(this.root, absolutePath);
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index]!.indexOf(input.query);
        if (column < 0) continue;
        matches.push({
          path: relativePath,
          line: index + 1,
          column: column + 1,
          preview: lines[index]!.slice(0, 300),
        });
        if (matches.length >= maxResults) return matches;
      }
    }
    return matches;
  }

  private async readUtf8File(absolutePath: string): Promise<string> {
    const handle = await open(
      absolutePath,
      constants.O_RDONLY | noFollowFlag(),
    );
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw new Error("workspace_path_is_not_a_regular_file");
      if (fileStat.size > this.limits.maxFileBytes) {
        throw new Error("workspace_file_size_limit_exceeded");
      }
      const value = await handle.readFile();
      if (value.includes(0)) throw new Error("workspace_binary_file_rejected");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch {
        throw new Error("workspace_non_utf8_file_rejected");
      }
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(
    absolutePath: string,
    content: string,
    overwrite: boolean,
  ): Promise<void> {
    const encoded = Buffer.from(content, "utf8");
    if (encoded.byteLength > this.limits.maxFileBytes) {
      throw new Error("workspace_file_size_limit_exceeded");
    }
    const existing = await optionalLstat(absolutePath);
    if (existing?.isSymbolicLink()) throw new Error("workspace_symlink_rejected");
    if (existing && !existing.isFile()) {
      throw new Error("workspace_path_is_not_a_regular_file");
    }
    if (existing && !overwrite) throw new Error("workspace_file_already_exists");

    const parent = dirname(absolutePath);
    await this.assertRealDirectoryWithinRoot(parent);
    const temporaryPath = join(
      parent,
      `.${basename(absolutePath)}.runtime-${randomUUID()}.tmp`,
    );
    const mode = existing ? existing.mode & 0o777 : 0o600;
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollowFlag(),
      mode,
    );
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (overwrite) {
        await rename(temporaryPath, absolutePath);
      } else {
        await link(temporaryPath, absolutePath);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async resolveRegularFile(
    path: string,
    mustExist: boolean,
  ): Promise<string> {
    const absolutePath = this.resolveLexicalPath(path, false);
    await this.assertRealDirectoryWithinRoot(dirname(absolutePath));
    const fileStat = await optionalLstat(absolutePath);
    if (!fileStat) {
      if (mustExist) throw new Error("workspace_file_not_found");
      return absolutePath;
    }
    if (fileStat.isSymbolicLink()) throw new Error("workspace_symlink_rejected");
    if (!fileStat.isFile()) throw new Error("workspace_path_is_not_a_regular_file");
    return absolutePath;
  }

  private async resolveDirectory(path: string): Promise<string> {
    const absolutePath = this.resolveLexicalPath(path, true);
    await this.assertRealDirectoryWithinRoot(absolutePath);
    return absolutePath;
  }

  private resolveLexicalPath(path: string, allowRoot: boolean): string {
    if (!path || path.includes("\0") || isAbsolute(path)) {
      throw new Error("workspace_path_must_be_relative");
    }
    const absolutePath = resolve(this.root, path);
    const relativePath = relative(this.root, absolutePath);
    if (
      (!allowRoot && relativePath === "") ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error("workspace_path_outside_root");
    }
    if (relativePath.split(sep).some((segment) => segment.toLowerCase() === ".git")) {
      throw new Error("workspace_git_metadata_rejected");
    }
    return absolutePath;
  }

  private async assertRealDirectoryWithinRoot(path: string): Promise<void> {
    const lexicalRelative = relative(this.root, path);
    if (
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(lexicalRelative)
    ) {
      throw new Error("workspace_path_outside_root");
    }
    let current = this.root;
    for (const segment of lexicalRelative.split(sep).filter(Boolean)) {
      current = join(current, segment);
      const currentStat = await optionalLstat(current);
      if (!currentStat) throw new Error("workspace_parent_not_found");
      if (currentStat.isSymbolicLink()) throw new Error("workspace_symlink_rejected");
      if (!currentStat.isDirectory()) {
        throw new Error("workspace_parent_is_not_a_directory");
      }
    }
    const canonical = await realpath(path);
    if (!isWithin(this.root, canonical)) {
      throw new Error("workspace_path_outside_root");
    }
  }

  private async withWriteLock<T>(
    path: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writeTails.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeTails.set(path, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.writeTails.get(path) === current) this.writeTails.delete(path);
    }
  }
}

async function* walkRegularFiles(root: string): AsyncGenerator<string> {
  const directory = await opendir(root);
  const entries = [];
  for await (const entry of directory) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name.toLowerCase() === ".git" || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkRegularFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name}_must_be_a_positive_integer`);
  }
  return resolved;
}

function occurrenceCount(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !isAbsolute(value)
  );
}

function isSkippableSearchFileError(error: unknown): boolean {
  return error instanceof Error && [
    "workspace_binary_file_rejected",
    "workspace_file_size_limit_exceeded",
    "workspace_non_utf8_file_rejected",
  ].includes(error.message);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
