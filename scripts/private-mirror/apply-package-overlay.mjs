#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = new URL("../..", import.meta.url).pathname;
const scriptPath = fileURLToPath(import.meta.url);
const privatePackageName =
  process.env.PRIVATE_MIRROR_PACKAGE_NAME ?? "@777genius/subscription-runtime";
const legacyPackageName =
  process.env.PRIVATE_MIRROR_LEGACY_PACKAGE_NAME ?? "@vioxen/subscription-runtime";
const privateRegistryScope =
  process.env.PRIVATE_MIRROR_REGISTRY_SCOPE ?? "@777genius";
const legacyRegistryScope =
  process.env.PRIVATE_MIRROR_LEGACY_REGISTRY_SCOPE ?? "@vioxen";
const privateRepositoryUrl =
  process.env.PRIVATE_MIRROR_REPOSITORY_URL ??
  "git+https://github.com/777genius/ar.git";
const packageVersion =
  process.env.PRIVATE_MIRROR_PACKAGE_VERSION ||
  process.env.PRIVATE_MIRROR_BASE_VERSION ||
  "";

const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".e2e-cache",
]);
const textExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

await applyTextOverlay(rootDir);
await applyPackageJsonOverlay();
await repairBoundaryLegacyChecks();
await alignDocumentedVersion();

async function applyTextOverlay(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await applyTextOverlay(fullPath);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    if (fullPath === scriptPath) continue;

    const before = await readFile(fullPath, "utf8");
    const after = before
      .replaceAll(legacyPackageName, privatePackageName)
      .replaceAll(`${legacyRegistryScope}:`, `${privateRegistryScope}:`);
    if (after !== before) {
      await writeFile(fullPath, after);
    }
  }
}

async function applyPackageJsonOverlay() {
  const packageJsonPath = join(rootDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.name = privatePackageName;
  if (packageVersion) {
    packageJson.version = packageVersion;
  }
  packageJson.repository = {
    type: "git",
    url: privateRepositoryUrl,
  };
  packageJson.publishConfig = {
    ...(packageJson.publishConfig ?? {}),
    registry: "https://npm.pkg.github.com",
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function repairBoundaryLegacyChecks() {
  const checkerPath = join(rootDir, "scripts/check-boundaries.mjs");
  await rewriteIfExists(checkerPath, (text) =>
    text.replace(
      /const legacyPackageNames = \[[^\n]*\];/,
      `const legacyPackageNames = [${JSON.stringify(legacyPackageName)}];`,
    ),
  );

  const selfTestPath = join(rootDir, "scripts/check-boundaries-self-test.mjs");
  await rewriteIfExists(selfTestPath, (text) =>
    text.replace(
      /(name: "legacy package scope violation"[\s\S]*?"src\/provider-claude\/bad\.ts": ")import '[^']+\/core';(\\n",)/,
      `$1import '${legacyPackageName}/core';$2`,
    ),
  );
}

async function alignDocumentedVersion() {
  if (!packageVersion) return;
  const escapedPackageName = escapeRegExp(privatePackageName);
  const dependencyPattern = new RegExp(
    `("${escapedPackageName}"\\s*:\\s*")[^"]+(")`,
    "g",
  );
  for (const relPath of ["README.md", "docs/package-consumption.md"]) {
    await rewriteIfExists(join(rootDir, relPath), (text) =>
      text.replace(dependencyPattern, `$1${packageVersion}$2`),
    );
  }
}

async function rewriteIfExists(path, transform) {
  let before;
  try {
    before = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  const after = transform(before);
  if (after !== before) {
    await writeFile(path, after);
  }
}

function isTextFile(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex !== -1 && textExtensions.has(fileName.slice(dotIndex));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
