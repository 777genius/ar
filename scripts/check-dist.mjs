#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const requiredDistFiles = new Set();

addDistPath(packageJson.main);
addDistPath(packageJson.types);

for (const exportTarget of Object.values(packageJson.exports ?? {})) {
  collectExportDistPaths(exportTarget);
}

for (const binTarget of Object.values(packageJson.bin ?? {})) {
  addDistPath(binTarget);
}

const missing = [];
for (const distFile of [...requiredDistFiles].sort()) {
  try {
    await access(join(rootDir, distFile));
  } catch {
    missing.push(distFile);
  }
}

if (missing.length > 0) {
  console.error("dist is missing package entrypoints. Run npm run build.");
  for (const distFile of missing) {
    console.error(`- ${distFile}`);
  }
  process.exit(1);
}

console.log(`dist contains ${requiredDistFiles.size} package entrypoints.`);

function collectExportDistPaths(exportTarget) {
  if (typeof exportTarget === "string") {
    addDistPath(exportTarget);
    return;
  }

  if (!exportTarget || typeof exportTarget !== "object") return;

  for (const value of Object.values(exportTarget)) {
    collectExportDistPaths(value);
  }
}

function addDistPath(value) {
  if (typeof value !== "string") return;
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (normalized.startsWith("dist/")) {
    requiredDistFiles.add(normalized);
  }
}
