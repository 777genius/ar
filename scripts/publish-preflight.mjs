#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const expectedPackageName = "@vioxen/subscription-runtime";
const defaultRegistryUrl = "https://npm.pkg.github.com";
const defaultGitHubApiUrl = "https://api.github.com";
const fetchTimeoutMs = 30_000;
const maxMetadataBytes = 2 * 1024 * 1024;
const maxRegistryMetadataBytes = 16 * 1024 * 1024;
const maxArtifactBytes = 128 * 1024 * 1024;

export async function runPublishPreflight(input) {
  const packageJsonPath = resolve(input.packageJsonPath ?? "package.json");
  const tarballPath = resolve(input.tarballPath);
  const manifest = parseJson(readFileSync(packageJsonPath, "utf8"), "package.json");
  assertManifest(manifest, "package.json");
  if (manifest.name !== expectedPackageName) {
    throw new Error(`publish_preflight_package_name_invalid:${String(manifest.name)}`);
  }

  const packedManifest = packedPackageManifest(tarballPath);
  assertManifest(packedManifest, "packed package.json");
  if (
    packedManifest.name !== manifest.name ||
    packedManifest.version !== manifest.version
  ) {
    throw new Error("publish_preflight_tarball_manifest_mismatch");
  }
  const releaseTag = input.releaseTag?.trim();
  if (!releaseTag) throw new Error("publish_preflight_release_tag_required");
  if (releaseTag !== `v${manifest.version}`) {
    throw new Error("publish_preflight_release_tag_version_mismatch");
  }
  const repository = requiredRepository(input.repository);

  const token = input.token?.trim();
  if (!token) throw new Error("publish_preflight_github_token_required");
  const artifact = artifactEvidence(readFileSync(tarballPath));
  const registryUrl = normalizedBaseUrl(input.registryUrl ?? defaultRegistryUrl);
  const packageAction = await inspectPublishedPackage({
    packageName: manifest.name,
    version: manifest.version,
    registryUrl,
    token,
    artifact,
  });

  const releaseAssetAction = await inspectReleaseAsset({
    repository,
    releaseTag,
    githubApiUrl: normalizedBaseUrl(
      input.githubApiUrl ?? defaultGitHubApiUrl,
    ),
    token,
    tarballName: basename(tarballPath),
    artifact,
  });

  return {
    packageName: manifest.name,
    version: manifest.version,
    tarballName: basename(tarballPath),
    tarballIntegrity: artifact.integrity,
    tarballSha512Hex: artifact.sha512Hex,
    packageAction,
    releaseAssetAction,
  };
}

async function inspectPublishedPackage(input) {
  const metadataUrl = new URL(
    encodedPackageName(input.packageName),
    input.registryUrl,
  );
  const response = await authenticatedFetch(metadataUrl, input.token, {
    Accept: "application/vnd.npm.install-v1+json, application/json",
  });
  if (response.status === 404) {
    await verifyRegistryAuthentication({
      registryUrl: input.registryUrl,
      token: input.token,
    });
    return "publish";
  }
  if (!response.ok) {
    throw new Error(`publish_preflight_registry_status:${response.status}`);
  }
  const packument = await safeResponseJson(
    response,
    "registry metadata",
    maxRegistryMetadataBytes,
  );
  const versions = assertRegistryPackument(packument, input.packageName);
  if (!Object.hasOwn(versions, input.version)) return "publish";
  const metadata = versions[input.version];
  if (
    !metadata || typeof metadata !== "object" ||
    metadata?.name !== input.packageName ||
    metadata?.version !== input.version
  ) {
    throw new Error("publish_preflight_existing_package_identity_invalid");
  }
  const remoteIntegrity = metadata?.dist?.integrity;
  const remoteTarball = metadata?.dist?.tarball;
  assertSha512Integrity(remoteIntegrity, "registry integrity");
  if (typeof remoteTarball !== "string" || remoteTarball.length === 0) {
    throw new Error("publish_preflight_registry_tarball_missing");
  }
  if (remoteIntegrity !== input.artifact.integrity) {
    throw new Error("publish_preflight_existing_package_mismatch");
  }
  assertSameOrigin(remoteTarball, input.registryUrl, "registry tarball");
  const tarballResponse = await authenticatedFetch(remoteTarball, input.token, {
    Accept: "application/octet-stream",
  });
  if (!tarballResponse.ok) {
    throw new Error(
      `publish_preflight_registry_tarball_status:${tarballResponse.status}`,
    );
  }
  const downloaded = artifactEvidence(
    await readResponseBytes(
      tarballResponse,
      "registry tarball",
      maxArtifactBytes,
    ),
  );
  if (
    downloaded.integrity !== remoteIntegrity ||
    downloaded.integrity !== input.artifact.integrity
  ) {
    throw new Error("publish_preflight_existing_package_download_mismatch");
  }
  return "skip";
}

export async function verifyRegistryPackageAccess(input) {
  const token = input.token?.trim();
  if (!token) throw new Error("publish_preflight_github_token_required");
  const registryUrl = normalizedBaseUrl(input.registryUrl ?? defaultRegistryUrl);
  const packageName = input.packageName ?? expectedPackageName;
  const metadataUrl = new URL(encodedPackageName(packageName), registryUrl);
  const response = await authenticatedFetch(metadataUrl, token, {
    Accept: "application/vnd.npm.install-v1+json, application/json",
  });
  if (response.status === 404) {
    const auth = await verifyRegistryAuthentication({ registryUrl, token });
    return {
      ...auth,
      packageName,
      packagePresent: false,
      versionCount: 0,
    };
  }
  if (!response.ok) {
    throw new Error(`publish_preflight_registry_status:${response.status}`);
  }
  const packument = await safeResponseJson(
    response,
    "registry metadata",
    maxRegistryMetadataBytes,
  );
  const versions = assertRegistryPackument(packument, packageName);
  return {
    registryOrigin: registryUrl.origin,
    authenticated: true,
    packageName,
    packagePresent: true,
    versionCount: Object.keys(versions).length,
  };
}

export async function verifyRegistryAuthentication(input) {
  const token = input.token?.trim();
  if (!token) throw new Error("publish_preflight_github_token_required");
  const registryUrl = normalizedBaseUrl(input.registryUrl ?? defaultRegistryUrl);
  const authUrl = new URL(
    "-/whoami",
    registryUrl,
  );
  const response = await authenticatedFetch(authUrl, token, {
    Accept: "application/vnd.npm.install-v1+json, application/json",
  });
  if (!response.ok) {
    throw new Error(`publish_preflight_registry_auth_probe_status:${response.status}`);
  }
  const metadata = await safeResponseJson(response, "registry auth probe");
  if (typeof metadata?.username !== "string" || !metadata.username.trim()) {
    throw new Error("publish_preflight_registry_auth_probe_identity_invalid");
  }
  return { registryOrigin: registryUrl.origin, authenticated: true };
}

async function inspectReleaseAsset(input) {
  const releaseUrl = new URL(
    `repos/${input.repository}/releases/tags/${encodeURIComponent(input.releaseTag)}`,
    input.githubApiUrl,
  );
  const response = await authenticatedFetch(releaseUrl, input.token, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (!response.ok) {
    throw new Error(`publish_preflight_release_status:${response.status}`);
  }
  const release = await safeResponseJson(response, "GitHub release");
  if (!Array.isArray(release?.assets)) {
    throw new Error("publish_preflight_release_assets_invalid");
  }
  const matches = release.assets.filter(
    (asset) => asset?.name === input.tarballName,
  );
  if (matches.length === 0) return "upload";
  if (matches.length !== 1) {
    throw new Error("publish_preflight_release_asset_ambiguous");
  }
  const assetUrl = matches[0]?.url;
  if (typeof assetUrl !== "string" || assetUrl.length === 0) {
    throw new Error("publish_preflight_release_asset_url_missing");
  }
  assertSameOrigin(assetUrl, input.githubApiUrl, "release asset");
  const assetResponse = await authenticatedFetch(assetUrl, input.token, {
    Accept: "application/octet-stream",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (!assetResponse.ok) {
    throw new Error(
      `publish_preflight_release_asset_status:${assetResponse.status}`,
    );
  }
  const downloaded = artifactEvidence(
    await readResponseBytes(
      assetResponse,
      "release asset",
      maxArtifactBytes,
    ),
  );
  if (downloaded.integrity !== input.artifact.integrity) {
    throw new Error("publish_preflight_existing_release_asset_mismatch");
  }
  return "skip";
}

function packedPackageManifest(tarballPath) {
  let output;
  try {
    output = execFileSync(
      "tar",
      ["-xOf", tarballPath, "package/package.json"],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    throw new Error("publish_preflight_tarball_manifest_unreadable");
  }
  return parseJson(output, "packed package.json");
}

function artifactEvidence(bytes) {
  const digest = createHash("sha512").update(bytes).digest();
  return {
    integrity: `sha512-${digest.toString("base64")}`,
    sha512Hex: digest.toString("hex"),
  };
}

function assertSha512Integrity(value, label) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`publish_preflight_${label.replaceAll(" ", "_")}_invalid`);
  }
  const digest = Buffer.from(value.slice("sha512-".length), "base64");
  if (digest.length !== 64) {
    throw new Error(`publish_preflight_${label.replaceAll(" ", "_")}_invalid`);
  }
}

function assertManifest(value, label) {
  if (
    !value || typeof value !== "object" ||
    typeof value.name !== "string" || value.name.length === 0 ||
    typeof value.version !== "string" || value.version.length === 0
  ) {
    throw new Error(`publish_preflight_${label.replaceAll(" ", "_")}_invalid`);
  }
}

function assertRegistryPackument(value, packageName) {
  if (
    !value || typeof value !== "object" ||
    value.name !== packageName ||
    !value.versions || typeof value.versions !== "object" ||
    Array.isArray(value.versions)
  ) {
    throw new Error("publish_preflight_registry_packument_invalid");
  }
  return value.versions;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`publish_preflight_${label.replaceAll(" ", "_")}_json_invalid`);
  }
}

async function safeResponseJson(response, label, limit = maxMetadataBytes) {
  const bytes = await readResponseBytes(response, label, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`publish_preflight_${label.replaceAll(" ", "_")}_json_invalid`);
  }
}

async function readResponseBytes(response, label, limit) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)
  ) {
    throw new Error(
      `publish_preflight_${label.replaceAll(" ", "_")}_body_too_large`,
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(
          `publish_preflight_${label.replaceAll(" ", "_")}_body_too_large`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function authenticatedFetch(url, token, headers) {
  return fetch(url, {
    headers: {
      ...headers,
      Authorization: `Bearer ${token}`,
      "User-Agent": "vioxen-subscription-runtime-publish-preflight",
    },
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
}

function encodedPackageName(name) {
  return encodeURIComponent(name).replace(/^%40/, "@");
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
    throw new Error("publish_preflight_endpoint_insecure");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function assertSameOrigin(candidate, base, label) {
  if (new URL(candidate).origin !== new URL(base).origin) {
    throw new Error(
      `publish_preflight_${label.replaceAll(" ", "_")}_origin_invalid`,
    );
  }
}

function isLoopbackHttp(url) {
  return url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

function requiredRepository(value) {
  const repository = value?.trim();
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("publish_preflight_repository_invalid");
  }
  return repository.split("/").map(encodeURIComponent).join("/");
}

function writeGitHubOutputs(path, result) {
  if (!path) throw new Error("publish_preflight_github_output_required");
  for (const [key, value] of Object.entries({
    package_action: result.packageAction,
    release_asset_action: result.releaseAssetAction,
    package_version: result.version,
    tarball_integrity: result.tarballIntegrity,
    tarball_sha512: result.tarballSha512Hex,
  })) {
    appendFileSync(path, `${key}=${value}\n`, "utf8");
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      tarball: { type: "string" },
      "package-json": { type: "string" },
      registry: { type: "string" },
      "release-tag": { type: "string" },
      repository: { type: "string" },
      "github-api-url": { type: "string" },
    },
    strict: true,
  });
  if (!values.tarball) throw new Error("publish_preflight_tarball_required");
  const result = await runPublishPreflight({
    tarballPath: values.tarball,
    packageJsonPath: values["package-json"],
    registryUrl: values.registry,
    releaseTag: values["release-tag"] ?? process.env.RELEASE_TAG,
    repository: values.repository ?? process.env.GITHUB_REPOSITORY,
    githubApiUrl: values["github-api-url"] ?? process.env.GITHUB_API_URL,
    token: process.env.GITHUB_TOKEN,
  });
  writeGitHubOutputs(process.env.GITHUB_OUTPUT, result);
  console.log(JSON.stringify({
    ok: true,
    package: `${result.packageName}@${result.version}`,
    tarball: result.tarballName,
    packageAction: result.packageAction,
    releaseAssetAction: result.releaseAssetAction,
    integrity: result.tarballIntegrity,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "publish_preflight_failed");
    process.exitCode = 1;
  });
}
