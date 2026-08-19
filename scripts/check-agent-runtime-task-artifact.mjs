#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentRuntimeTaskArtifact,
  packCurrentPackage,
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
const checkRoot = await mkdtemp(join(tmpdir(), "subscription-runtime-artifact-check-"));

try {
  const firstTarball = await packCurrentPackage(join(checkRoot, "pack-first"));
  const secondTarball = await packCurrentPackage(join(checkRoot, "pack-second"));
  const first = await buildAgentRuntimeTaskArtifact({
    packageTarball: firstTarball,
    outputPath: join(checkRoot, "first", "subscription-runtime-run-agent-runtime-task"),
  });
  const second = await buildAgentRuntimeTaskArtifact({
    packageTarball: secondTarball,
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
