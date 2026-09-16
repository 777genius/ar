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
  "package/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json",
];
const claudeNativePackagePrefix =
  "package/node_modules/@anthropic-ai/claude-agent-sdk-";
const expectedClaudeNativePackage =
  "package/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json";
const expectedClaudeSdkVersion = "0.3.237";
const expectedClaudeCodeVersion = "2.1.237";

export async function buildAgentRuntimeTaskArtifact({
  outputPath = defaultOutput,
} = {}) {
  assertLinuxX64BuildHost();
  const source = cleanGitSourceIdentity();
  const buildRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-build-"));
  try {
    const tarballPath = await packCleanPackage(buildRoot, source.sourceGitSha);
    await assertPackageTarball(tarballPath);
    const payload = await readFile(tarballPath);
    const header = renderLauncher();
    const bytes = Buffer.concat([Buffer.from(header, "utf8"), payload]);
    const resolvedOutput = resolve(outputPath);
    assertUnchangedGitSource(source);
    await mkdir(dirname(resolvedOutput), { recursive: true });
    await assertNotSymlink(resolvedOutput);
    const temporaryOutput = join(
      dirname(resolvedOutput),
      `.${basename(resolvedOutput)}.${process.pid}.tmp`,
    );
    await writeFile(temporaryOutput, bytes, { mode: 0o755, flag: "wx" });
    await chmod(temporaryOutput, 0o755);
    await rename(temporaryOutput, resolvedOutput);
    return {
      schemaVersion: 1,
      outputPath: resolvedOutput,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      payloadSha256: sha256(payload),
      ...source,
    };
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

async function packCleanPackage(buildRoot, sourceGitSha) {
  const sourceArchive = join(buildRoot, "source.tar");
  const sourceRoot = join(buildRoot, "source");
  const packRoot = join(buildRoot, "pack");
  const buildHome = join(buildRoot, "home");
  const buildTmp = join(buildRoot, "tmp");
  await mkdir(sourceRoot);
  await mkdir(packRoot);
  await mkdir(buildHome);
  await mkdir(buildTmp);
  runChecked(
    "git",
    ["archive", "--format=tar", "--output", sourceArchive, sourceGitSha],
    { cwd: rootDir, env: buildMinimalEnvironment() },
  );
  runChecked("tar", ["-xf", sourceArchive, "-C", sourceRoot], {
    cwd: buildRoot,
    env: buildMinimalEnvironment(),
  });
  const npmEnvironment = buildNpmEnvironment(buildRoot, buildHome, buildTmp);
  runChecked(
    "npm",
    [
      "ci",
      "--ignore-scripts",
      "--include=optional",
      "--os=linux",
      "--cpu=x64",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: sourceRoot, env: npmEnvironment, timeout: 300_000 },
  );
  runChecked("npm", ["run", "build"], {
    cwd: sourceRoot,
    env: npmEnvironment,
    timeout: 300_000,
  });
  const result = runChecked(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packRoot,
    ],
    {
      cwd: sourceRoot,
      env: npmEnvironment,
      timeout: 120_000,
    },
  );
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
  const tarballPath = join(packRoot, filename);
  const realDestination = await realpath(packRoot);
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
    "exec 3<&0",
    "node \"$runtime_dir/package/dist/worker-local/agent-runtime-task-runner-cli.js\" \"$@\" <&3 3<&- &",
    "child_pid=$!",
    "exec 3<&-",
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
  assertLinuxX64ArchiveEntries(entries);
  for (const entry of requiredArchiveEntries) {
    if (!entries.has(entry)) throw new Error(`package tarball is missing ${entry}`);
  }
  assertClaudeSdkVersions({
    sdkManifest: readArchiveEntry(
      tarballPath,
      "package/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    ),
    nativeManifest: readArchiveEntry(tarballPath, expectedClaudeNativePackage),
  });
}

export function assertClaudeSdkVersions({ sdkManifest, nativeManifest }) {
  let sdk;
  let native;
  try {
    sdk = JSON.parse(sdkManifest);
    native = JSON.parse(nativeManifest);
  } catch {
    throw new Error("Claude SDK artifact manifests must be valid JSON");
  }
  if (
    sdk?.version !== expectedClaudeSdkVersion ||
    sdk?.claudeCodeVersion !== expectedClaudeCodeVersion ||
    native?.version !== expectedClaudeSdkVersion
  ) {
    throw new Error("Claude SDK artifact versions do not match the pinned runtime");
  }
}

function readArchiveEntry(tarballPath, entry) {
  const result = spawnSync("tar", ["-xOzf", tarballPath, entry], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: buildMinimalEnvironment(),
  });
  if (result.error || result.status !== 0 || result.stderr.trim() !== "") {
    throw new Error(`unable to read Claude SDK artifact manifest: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

export function assertLinuxX64ArchiveEntries(entries) {
  const nativePackages = [...entries].filter((entry) =>
    entry.startsWith(claudeNativePackagePrefix) && entry.endsWith("/package.json")
  );
  if (
    nativePackages.length !== 1 ||
    nativePackages[0] !== expectedClaudeNativePackage
  ) {
    throw new Error(
      `package tarball must contain only the Linux x64 Claude SDK binary; found ${nativePackages.join(",") || "none"}`,
    );
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

function buildNpmEnvironment(buildRoot, buildHome, buildTmp) {
  return {
    ...buildMinimalEnvironment(),
    HOME: buildHome,
    TMPDIR: buildTmp,
    npm_config_audit: "false",
    npm_config_cache: join(buildRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: "/dev/null",
  };
}

function buildMinimalEnvironment() {
  const keys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"];
  return Object.fromEntries(
    keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
}

function cleanGitSourceIdentity() {
  const sourceGitSha = gitOutput(["rev-parse", "HEAD"]);
  if (sourceGitSha === null) throw new Error("artifact source is not a Git worktree");
  const sourceGitTree = gitOutput(["rev-parse", `${sourceGitSha}^{tree}`]);
  if (sourceGitTree === null) throw new Error("artifact source tree is unavailable");
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === null) throw new Error("artifact source is not a Git worktree");
  if (status !== "") {
    throw new Error("refusing to publish an artifact from a dirty Git worktree");
  }
  return { sourceGitSha, sourceGitTree };
}

function assertUnchangedGitSource(expected) {
  const current = cleanGitSourceIdentity();
  assertMatchingGitSourceIdentity(expected, current);
}

export function assertMatchingGitSourceIdentity(expected, current) {
  if (
    current.sourceGitSha !== expected.sourceGitSha ||
    current.sourceGitTree !== expected.sourceGitTree
  ) {
    throw new Error("artifact Git source changed during the build");
  }
}

function assertLinuxX64BuildHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `agent runtime artifact must be built on Linux x64, got ${process.platform}/${process.arch}`,
    );
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

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`,
    );
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.outputPath = requireValue(argv, ++index, argument);
    else throw new Error(`unknown argument: ${argument}`);
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
