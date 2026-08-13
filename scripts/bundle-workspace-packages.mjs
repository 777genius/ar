#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const rootDist = "dist";
const packageName = "@vioxen/agent-account-observability";
const sourceDir = "packages/agent-account-observability/dist";
const targetDir = join(rootDist, "internal", "agent-account-observability");
const targetEntry = join(targetDir, "index.js");

if (!existsSync(sourceDir)) {
  throw new Error(`${sourceDir} is missing; build workspace packages first`);
}

rmSync(targetDir, { force: true, recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

let rewritten = 0;
walk(rootDist);

if (rewritten === 0) {
  throw new Error(`No compiled imports of ${packageName} were found`);
}

console.log(
  `Bundled ${packageName} and rewrote ${rewritten} compiled references.`,
);

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (fullPath !== targetDir) walk(fullPath);
      continue;
    }
    if (
      !entry.isFile() ||
      (!fullPath.endsWith(".js") && !fullPath.endsWith(".d.ts"))
    ) {
      continue;
    }
    rewriteFile(fullPath);
  }
}

function rewriteFile(filePath) {
  const before = readFileSync(filePath, "utf8");
  const specifier = toModuleSpecifier(relative(dirname(filePath), targetEntry));
  const after = before
    .replaceAll(`"${packageName}"`, `"${specifier}"`)
    .replaceAll(`'${packageName}'`, `'${specifier}'`);
  if (after === before) return;
  writeFileSync(filePath, after);
  rewritten += 1;
}

function toModuleSpecifier(path) {
  const normalized = path.split(sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
