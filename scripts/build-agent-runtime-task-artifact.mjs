#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const defaultOutput = join(
  rootDir,
  "tmp",
  "artifacts",
  "subscription-runtime-run-agent-runtime-task",
);
const requiredArchiveEntries = [
  "package/package.json",
  "package/dist/worker-local/agent-runtime-task-runner-cli.js",
  "package/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
];

export async function buildAgentRuntimeTaskArtifact({
  outputPath = defaultOutput,
  packageTarball,
} = {}) {
  if (!packageTarball) assertCleanGitSource();
  const ownedPackRoot = packageTarball
    ? undefined
    : await mkdtemp(join(tmpdir(), "subscription-runtime-pack-"));
  try {
    const tarballPath = packageTarball
      ? resolve(packageTarball)
      : await packCurrentPackage(ownedPackRoot);
    await assertPackageTarball(tarballPath);
    const payload = await readFile(tarballPath);
    const header = renderLauncher();
    const bytes = Buffer.concat([Buffer.from(header, "utf8"), payload]);
    const resolvedOutput = resolve(outputPath);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await assertNotSymlink(resolvedOutput);
    const temporaryOutput = join(
      dirname(resolvedOutput),
      `.${basename(resolvedOutput)}.${process.pid}.tmp`,
    );
    await writeFile(temporaryOutput, bytes, { mode: 0o755, flag: "wx" });
    await chmod(temporaryOutput, 0o755);
    await rename(temporaryOutput, resolvedOutput);
    const source = gitSourceIdentity();
    return {
      schemaVersion: 1,
      outputPath: resolvedOutput,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      payloadSha256: sha256(payload),
      ...source,
    };
  } finally {
    if (ownedPackRoot) await rm(ownedPackRoot, { recursive: true, force: true });
  }
}

export async function packCurrentPackage(destination) {
  const resolvedDestination = resolve(destination);
  await mkdir(resolvedDestination, { recursive: true });
  const result = spawnSync(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--offline",
      "--json",
      "--pack-destination",
      resolvedDestination,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: buildPackEnvironment(),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || result.stderr.trim() !== "") {
    throw new Error(
      `npm pack failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`,
    );
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("npm pack returned non-JSON output");
  }
  const filename = Array.isArray(report) && report.length === 1
    ? report[0]?.filename
    : undefined;
  if (typeof filename !== "string" || basename(filename) !== filename) {
    throw new Error("npm pack returned an unsafe artifact filename");
  }
  const tarballPath = join(resolvedDestination, filename);
  const realDestination = await realpath(resolvedDestination);
  const realTarball = await realpath(tarballPath);
  if (!realTarball.startsWith(`${realDestination}${sep}`)) {
    throw new Error("npm pack artifact escaped its destination");
  }
  return realTarball;
}

function renderLauncher() {
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "artifact_path=$0",
    "runtime_dir=$(mktemp -d \"${TMPDIR:-/tmp}/subscription-runtime-artifact.XXXXXX\")",
    "child_pid=",
    "cleanup() {",
    "  case \"$runtime_dir\" in",
    "    \"${TMPDIR:-/tmp}\"/subscription-runtime-artifact.*) command rm -rf -- \"$runtime_dir\" ;;",
    "    *) exit 70 ;;",
    "  esac",
    "}",
    "forward_and_exit() {",
    "  signal=$1",
    "  status=$2",
    "  trap - HUP INT TERM",
    "  if [ -n \"$child_pid\" ]; then",
    "    kill -s \"$signal\" \"$child_pid\" 2>/dev/null || true",
    "    set +e",
    "    wait \"$child_pid\"",
    "    set -e",
    "  fi",
    "  exit \"$status\"",
    "}",
    "trap cleanup EXIT",
    "trap 'forward_and_exit HUP 129' HUP",
    "trap 'forward_and_exit INT 130' INT",
    "trap 'forward_and_exit TERM 143' TERM",
    "tail -n +__ARCHIVE_LINE__ \"$artifact_path\" | tar -xzf - -C \"$runtime_dir\"",
    "node \"$runtime_dir/package/dist/worker-local/agent-runtime-task-runner-cli.js\" \"$@\" &",
    "child_pid=$!",
    "set +e",
    "wait \"$child_pid\"",
    "status=$?",
    "set -e",
    "child_pid=",
    "exit \"$status\"",
    "__SUBSCRIPTION_RUNTIME_ARCHIVE_BELOW__",
  ];
  const archiveLine = lines.length + 1;
  return `${lines.join("\n").replace("__ARCHIVE_LINE__", String(archiveLine))}\n`;
}

async function assertPackageTarball(tarballPath) {
  const result = spawnSync("tar", ["-tzf", tarballPath], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: buildMinimalEnvironment(),
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "") {
    throw new Error(`invalid package tarball: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const entries = new Set(result.stdout.split("\n").filter(Boolean));
  for (const entry of requiredArchiveEntries) {
    if (!entries.has(entry)) throw new Error(`package tarball is missing ${entry}`);
  }
}

async function assertNotSymlink(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`refusing symlink output: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function buildPackEnvironment() {
  return {
    ...buildMinimalEnvironment(),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
  };
}

function buildMinimalEnvironment() {
  const keys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"];
  return Object.fromEntries(
    keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
}

function gitSourceIdentity() {
  return {
    sourceGitSha: gitOutput(["rev-parse", "HEAD"]),
    sourceGitTree: gitOutput(["rev-parse", "HEAD^{tree}"]),
  };
}

function assertCleanGitSource() {
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === null) throw new Error("artifact source is not a Git worktree");
  if (status !== "") {
    throw new Error("refusing to publish an artifact from a dirty Git worktree");
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: buildMinimalEnvironment(),
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.outputPath = requireValue(argv, ++index, argument);
    else if (argument === "--package-tarball") {
      options.packageTarball = requireValue(argv, ++index, argument);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildAgentRuntimeTaskArtifact(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
