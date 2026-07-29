import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { spawn } from "node:child_process";

const maxGitOutputBytes = 256 * 1024 * 1024;
const fileReadBufferBytes = 64 * 1024;

/**
 * Fingerprints the exact Git-visible workspace effect: HEAD, staged and
 * unstaged tracked diffs, plus nonignored untracked paths and their contents.
 * Git-ignored filesystem state is intentionally outside this replay contract.
 */
export async function workspaceEffectFingerprint(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const [head, staged, unstaged, untrackedOutput] = await Promise.all([
    gitBytes(cwd, ["rev-parse", "--verify", "HEAD"], signal),
    gitBytes(
      cwd,
      ["diff", "--binary", "--cached", "--no-ext-diff", "--no-textconv"],
      signal,
    ),
    gitBytes(
      cwd,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv"],
      signal,
    ),
    gitBytes(
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      signal,
    ),
  ]);
  const hash = createHash("sha256");
  updateSection(hash, "head", head);
  updateSection(hash, "staged", staged);
  updateSection(hash, "unstaged", unstaged);
  const untrackedPaths = decodeNullTerminatedPaths(untrackedOutput);
  for (const path of untrackedPaths) {
    await updateUntrackedPath(hash, cwd, path);
  }
  return hash.digest("base64url");
}

async function updateUntrackedPath(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  relativePath: string,
): Promise<void> {
  const path = resolve(cwd, relativePath);
  assertContainedPath(cwd, path);
  const metadata = await lstat(path);
  updateSection(hash, "untracked-path", Buffer.from(relativePath, "utf8"));
  updateSection(
    hash,
    "untracked-mode",
    Buffer.from((metadata.mode & 0o7777).toString(8), "ascii"),
  );
  if (metadata.isSymbolicLink()) {
    updateSection(
      hash,
      "untracked-symlink",
      Buffer.from(await readlink(path), "utf8"),
    );
    return;
  }
  if (!metadata.isFile()) {
    throw new Error("workspace_effect_untracked_file_type_unsupported");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error("workspace_effect_untracked_file_changed");
    }
    updateSection(
      hash,
      "untracked-size",
      Buffer.from(String(openedMetadata.size), "ascii"),
    );
    const buffer = Buffer.allocUnsafe(fileReadBufferBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== openedMetadata.size) {
      throw new Error("workspace_effect_untracked_file_changed");
    }
  } finally {
    await handle.close();
  }
}

function updateSection(
  hash: ReturnType<typeof createHash>,
  name: string,
  value: Buffer,
): void {
  hash.update(Buffer.from(`${name}:${value.byteLength}\0`, "ascii"));
  hash.update(value);
  hash.update(Buffer.from("\0", "ascii"));
}

function decodeNullTerminatedPaths(output: Buffer): readonly string[] {
  if (output.byteLength === 0) return [];
  const parts = output.subarray(0, output.at(-1) === 0 ? -1 : undefined)
    .toString("utf8")
    .split("\0");
  if (parts.some((path) => path.length === 0 || path.includes("\uFFFD"))) {
    throw new Error("workspace_effect_untracked_path_invalid");
  }
  return parts;
}

function assertContainedPath(cwd: string, path: string): void {
  const relativePath = relative(resolve(cwd), path);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    throw new Error("workspace_effect_untracked_path_outside_workspace");
  }
}

async function gitBytes(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal === undefined ? {} : { signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxGitOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error("workspace_effect_git_output_too_large"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxGitOutputBytes) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, closeSignal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      reject(
        new Error(
          `workspace_effect_git_failed:${code ?? closeSignal ?? "unknown"}:${
            Buffer.concat(stderr).toString("utf8").trim()
          }`,
        ),
      );
    });
  });
}
