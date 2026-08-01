#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { runPublishPreflight } from "./publish-preflight.mjs";

const root = await mkdtemp(join(tmpdir(), "subscription-runtime-publish-preflight-"));
const packageJsonPath = join(root, "package.json");
await writeFile(packageJsonPath, JSON.stringify({
  name: "@vioxen/subscription-runtime",
  version: "0.1.0-test.1",
  files: ["fixture.txt"],
}), "utf8");
await writeFile(join(root, "fixture.txt"), "fixture\n", "utf8");
const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});
if (packed.status !== 0) {
  throw new Error(`npm pack fixture failed: ${packed.stderr}`);
}
const [{ filename }] = JSON.parse(packed.stdout);
const tarballPath = join(root, filename);
const tarball = await readFile(tarballPath);
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
const differentTarball = Buffer.from("different remote artifact");

const state = {
  authProbeStatus: 200,
  authProbeUsername: "github-actions[bot]",
  authProbeRequests: 0,
  packageStatus: 404,
  packageIntegrity: integrity,
  packageBytes: tarball,
  releaseStatus: 200,
  releaseAssetCount: 1,
  releaseBytes: tarball,
};
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer test-token");
  const base = `http://127.0.0.1:${server.address().port}`;
  if (request.url === "/registry/-/whoami") {
    state.authProbeRequests += 1;
    response.statusCode = state.authProbeStatus;
    response.setHeader("content-type", "application/json");
    response.end(state.authProbeStatus === 200
      ? JSON.stringify({
          username: state.authProbeUsername,
        })
      : JSON.stringify({ error: "not found or unauthorized" }));
    return;
  }
  if (request.url.startsWith("/registry/@vioxen%2Fsubscription-runtime/")) {
    response.statusCode = state.packageStatus;
    response.setHeader("content-type", "application/json");
    response.end(state.packageStatus === 404
      ? JSON.stringify({ error: "not found" })
      : JSON.stringify({
          name: "@vioxen/subscription-runtime",
          version: "0.1.0-test.1",
          dist: {
            ...(state.packageIntegrity === undefined
              ? {}
              : { integrity: state.packageIntegrity }),
            tarball: `${base}/registry/download/package.tgz`,
          },
        }));
    return;
  }
  if (request.url === "/registry/download/package.tgz") {
    response.end(state.packageBytes);
    return;
  }
  if (request.url === "/api/repos/vioxen/subscription-runtime/releases/tags/v0.1.0-test.1") {
    response.statusCode = state.releaseStatus;
    response.setHeader("content-type", "application/json");
    response.end(state.releaseStatus === 200
      ? JSON.stringify({
        assets: Array.from({ length: state.releaseAssetCount }, (_, index) => ({
        name: filename,
          url: `${base}/api/repos/vioxen/subscription-runtime/releases/assets/${index + 1}`,
        })),
      })
      : JSON.stringify({ error: "release unavailable" }));
    return;
  }
  if (request.url.startsWith("/api/repos/vioxen/subscription-runtime/releases/assets/")) {
    response.end(state.releaseBytes);
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const common = {
  packageJsonPath,
  tarballPath,
  registryUrl: `${base}/registry/`,
  releaseTag: "v0.1.0-test.1",
  repository: "vioxen/subscription-runtime",
  githubApiUrl: `${base}/api/`,
  token: "test-token",
};

try {
  const absent = await runPublishPreflight(common);
  assert.equal(absent.packageAction, "publish");
  assert.equal(absent.releaseAssetAction, "skip");
  assert.equal(state.authProbeRequests, 1);

  state.authProbeStatus = 404;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_registry_auth_probe_status:404/,
  );
  state.authProbeStatus = 200;

  state.authProbeUsername = "";
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_registry_auth_probe_identity_invalid/,
  );
  state.authProbeUsername = "github-actions[bot]";

  state.packageStatus = 200;
  const authProbeRequestsBeforeExisting = state.authProbeRequests;
  const identical = await runPublishPreflight(common);
  assert.equal(identical.packageAction, "skip");
  assert.equal(identical.releaseAssetAction, "skip");
  assert.equal(identical.tarballIntegrity, integrity);
  assert.equal(state.authProbeRequests, authProbeRequestsBeforeExisting);

  await assert.rejects(
    runPublishPreflight({
      ...common,
      releaseTag: "wrong-tag",
      repository: "vioxen/subscription-runtime",
      githubApiUrl: `${base}/api/`,
    }),
    /publish_preflight_release_tag_version_mismatch/,
  );

  const { releaseTag: _releaseTag, ...withoutReleaseTag } = common;
  await assert.rejects(
    runPublishPreflight(withoutReleaseTag),
    /publish_preflight_release_tag_required/,
  );

  state.releaseAssetCount = 0;
  const missingAsset = await runPublishPreflight(common);
  assert.equal(missingAsset.releaseAssetAction, "upload");

  state.releaseAssetCount = 2;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_release_asset_ambiguous/,
  );

  state.releaseAssetCount = 1;
  state.releaseStatus = 503;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_release_status:503/,
  );
  state.releaseStatus = 200;

  state.packageIntegrity = `sha512-${createHash("sha512")
    .update(differentTarball).digest("base64")}`;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_existing_package_mismatch/,
  );

  state.packageIntegrity = undefined;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_registry_integrity_invalid/,
  );

  state.packageIntegrity = integrity;
  state.packageBytes = differentTarball;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_existing_package_download_mismatch/,
  );

  state.packageBytes = tarball;
  state.releaseBytes = differentTarball;
  await assert.rejects(
    runPublishPreflight(common),
    /publish_preflight_existing_release_asset_mismatch/,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  await rm(root, { recursive: true, force: true });
}

console.log("publish preflight self-tests OK.");
