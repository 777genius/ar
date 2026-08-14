#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRepository = "vioxen/subscription-runtime";
const authorityGuard = `github.repository == '${canonicalRepository}'`;
const guardedWorkflows = [
  ".github/workflows/publish.yml",
  ".github/workflows/publish-registry-contract.yml",
];

for (const path of guardedWorkflows) {
  const source = await readFile(resolve(root, path), "utf8");
  if (!source.includes(authorityGuard)) {
    throw new Error(`publish_authority_guard_missing:${path}`);
  }
}

const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
if (
  manifest.repository?.url !==
  `git+https://github.com/${canonicalRepository}.git`
) {
  throw new Error("publish_authority_manifest_repository_mismatch");
}

console.log(`Publish authority is restricted to ${canonicalRepository}.`);
