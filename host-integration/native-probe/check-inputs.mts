import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
export interface CheckedInput { readonly path: string; readonly sha256: string }
export async function checkInputs(workspace: string, compilerFileList: string): Promise<readonly CheckedInput[]> {
  const native = join(workspace, "host-integration/native-probe/native");
  const paths = [
    ...compilerFileList.trim().split(/\r?\n/),
    ...(await readdir(native)).filter(name => /\.(c|h)$/.test(name)).map(name => join(native, name)),
    ...["host-integration/host-jobs/manager.mjs", "host-integration/host-jobs/contract.mjs", "host-integration/host-jobs/storage-policy.mjs", "host-integration/managed-launcher/launch.mjs", "host-integration/managed-launcher/profiles.mjs", "host-integration/managed-launcher/payload-guard.mjs", "host-integration/host-jobs/read-request.mjs", "host-integration/host-jobs/read-request.d.mts", "host-integration/host-jobs/endpoint.mjs", "host-integration/host-jobs/install", "host-integration/native-probe/installed-data-package.json", "host-integration/host-jobs/host-jobs.node-test.mjs", "scripts/rewrite-dist-esm-imports.mjs", "package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml", "host-integration/native-probe/tsconfig.json", "host-integration/native-probe/README.md", "host-integration/native-probe/RED-CONDITIONS.md"].map(name => join(workspace, name)),
  ];
  if (paths.length > 2048) throw new Error("source input graph capacity exceeded");
  const result: CheckedInput[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const name = relative(workspace, resolve(path));
    if (!isAbsolute(path) || !name || name.startsWith("../") || name === ".." || isAbsolute(name)) throw new Error("unexpected compiler input outside workspace");
    result.push({ path: name, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
  }
  return Object.freeze(result);
}
