#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentRuntimeTaskArtifact,
  assertClaudeSdkVersions,
  assertLinuxX64ArchiveEntries,
  assertMatchingGitSourceIdentity,
} from "./build-agent-runtime-task-artifact.mjs";

const expectedCapabilities = {
  schemaVersion: 1,
  protocolVersions: [2],
  inlineOutputSchema: true,
  reasoningEffort: true,
  serviceTier: true,
  boundedReadOnlyWorkspace: true,
  instructionPathDeny: true,
};
assertWrongPlatformPackageFails();
assertWrongClaudeSdkVersionFails();
assertSourceMovementFails();
if (process.platform !== "linux" || process.arch !== "x64") {
  process.stdout.write(`${JSON.stringify({
    status: "skipped",
    reason: `Linux x64 artifact check cannot run on ${process.platform}/${process.arch}`,
  })}\n`);
} else {
  await runArtifactCheck();
}

async function runArtifactCheck() {
  const checkRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-artifact-check-"));
  try {
    const first = await buildAgentRuntimeTaskArtifact({
      outputPath: join(checkRoot, "first", "subscription-runtime-run-agent-runtime-task"),
    });
    const second = await buildAgentRuntimeTaskArtifact({
      outputPath: join(checkRoot, "second", "subscription-runtime-run-agent-runtime-task"),
    });
    if (first.payloadSha256 !== second.payloadSha256) {
      throw new Error("package payload hash is not deterministic");
    }
    if (first.sha256 !== second.sha256) throw new Error("artifact hash is not deterministic");
    if (!Buffer.from(await readFile(first.outputPath)).equals(await readFile(second.outputPath))) {
      throw new Error("artifact bytes are not deterministic");
    }
    const runtimeTmp = join(checkRoot, "runtime-tmp");
    await mkdir(runtimeTmp);
    for (const artifact of [first, second]) {
      assertCapabilities(artifact.outputPath, checkRoot, runtimeTmp);
      assertStdinForwarding(artifact.outputPath, checkRoot, runtimeTmp);
    }
    const leftovers = (await readdir(runtimeTmp)).filter((name) =>
      name.startsWith("subscription-runtime-artifact.")
    );
    if (leftovers.length !== 0) {
      throw new Error(`artifact launcher left runtime directories: ${leftovers.join(",")}`);
    }
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      sha256: first.sha256,
      payloadSha256: first.payloadSha256,
      sizeBytes: first.sizeBytes,
      capabilities: expectedCapabilities,
    })}\n`);
  } finally {
    await rm(checkRoot, { recursive: true, force: true });
  }
}

function assertWrongPlatformPackageFails() {
  const wrongPlatformEntries = new Set([
    "package/package.json",
    "package/dist/worker-local/agent-runtime-task-runner-cli.js",
    "package/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "package/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json",
  ]);
  try {
    assertLinuxX64ArchiveEntries(wrongPlatformEntries);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Linux x64")) return;
    throw error;
  }
  throw new Error("wrong-platform Claude SDK package was accepted");
}

function assertWrongClaudeSdkVersionFails() {
  try {
    assertClaudeSdkVersions({
      sdkManifest: JSON.stringify({
        version: "0.3.236",
        claudeCodeVersion: "2.1.236",
      }),
      nativeManifest: JSON.stringify({ version: "0.3.236" }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("pinned runtime")) return;
    throw error;
  }
  throw new Error("wrong Claude SDK artifact versions were accepted");
}

function assertSourceMovementFails() {
  try {
    assertMatchingGitSourceIdentity(
      { sourceGitSha: "a".repeat(40), sourceGitTree: "b".repeat(40) },
      { sourceGitSha: "c".repeat(40), sourceGitTree: "d".repeat(40) },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("changed during")) return;
    throw error;
  }
  throw new Error("artifact source movement was accepted");
}

function assertCapabilities(artifactPath, home, runtimeTmp) {
  const result = spawnSync(artifactPath, ["--capabilities-json", "1"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    env: Object.fromEntries(
      ["PATH", "LANG", "LC_ALL"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]
      ).concat([["HOME", home], ["TMPDIR", runtimeTmp]]),
    ),
  });
  if (result.error || result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `capabilities probe failed: ${result.error?.message ?? (result.stderr || `exit ${result.status}`)}`,
    );
  }
  const capabilities = JSON.parse(result.stdout);
  if (JSON.stringify(capabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error(`unexpected capabilities: ${result.stdout.trim()}`);
  }
}

function assertStdinForwarding(artifactPath, home, runtimeTmp) {
  const result = spawnSync(
    "/bin/dash",
    [
      artifactPath,
      "--provider",
      "claude",
      "--ephemeral",
      "--format",
      "result-json",
    ],
    {
      encoding: "utf8",
      input: "{}\n",
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      env: Object.fromEntries(
        ["PATH", "LANG", "LC_ALL"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]]]
        ).concat([["HOME", home], ["TMPDIR", runtimeTmp]]),
      ),
    },
  );
  if (result.error || result.status !== 2 || result.stdout === "") {
    throw new Error(
      `stdin probe did not reach request parsing: ${result.error?.message ?? `exit ${result.status}`}`,
    );
  }
  if (
    result.stderr.includes("Unexpected end of JSON input") ||
    result.stdout.includes("Unexpected end of JSON input")
  ) {
    throw new Error("artifact launcher replaced request stdin with /dev/null");
  }
}
