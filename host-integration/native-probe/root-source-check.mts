import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const compiler = join(workspace, "node_modules/typescript/bin/tsc");
const evidence = resolve(process.env.SR_NATIVE_PROBE_EVIDENCE ?? join(workspace, "delivery/a0-native-probe"));
const temporary = await mkdtemp(join(process.env.SR_NATIVE_PROBE_TMP ?? tmpdir(), "sr-native-probe-root-check-"));
const checks: Array<{ command: readonly string[]; exit: number | null; signal: string | null; output: string }> = [];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid compiler configuration");
  return value as Record<string, unknown>;
}
async function run(args: readonly string[]): Promise<void> {
  const child = spawn(process.execPath, [compiler, ...args], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stderr.write(chunk); });
  const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
  checks.push({ command: [process.execPath, compiler, ...args], exit: result.code, signal: result.signal, output });
  if (result.code !== 0) throw new Error("root source typecheck failed");
}
let passed = false;
try {
  // The normal root typecheck builds this existing workspace package first.
  // Emit it only in our disposable fixture, preserving other owners' bytes.
  const declarations = join(temporary, "account-declarations");
  await run(["--skipLibCheck", "false", "-p", "packages/agent-account-observability/tsconfig.json", "--outDir", declarations, "--incremental", "false"]);
  await readFile(join(declarations, "index.d.ts"));
  const root = object(JSON.parse(await readFile(join(workspace, "tsconfig.json"), "utf8")) as unknown);
  const originalPaths = object(object(root.compilerOptions).paths);
  const paths: Record<string, readonly string[]> = {};
  for (const [name, input] of Object.entries(originalPaths)) {
    if (!Array.isArray(input) || !input.every((entry: unknown) => typeof entry === "string")) throw new Error("invalid existing compiler alias");
    paths[name] = input;
  }
  paths["@vioxen/agent-account-observability"] = [join(declarations, "index.d.ts")];
  const config = join(temporary, "root-source-check.json");
  // Resolve the inherited node/vitest type libraries from the real workspace
  // dependency tree, just as the disposable predecessor source fixture does.
  await symlink(join(workspace, "node_modules"), join(temporary, "node_modules"), "dir");
  await writeFile(config, JSON.stringify({ extends: join(workspace, "tsconfig.json"), compilerOptions: { baseUrl: workspace, paths } }));
  await run(["--noEmit", "--skipLibCheck", "false", "--incremental", "false", "-p", config]);
  passed = true;
} finally {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, `source-check-root-${Date.now()}.json`), JSON.stringify({ qualification: "read-only-root-source-typecheck-with-existing-package-built-in-disposable-storage", passed, checks }, null, 2) + "\n", { flag: "wx" });
  await rm(temporary, { recursive: true, force: true });
}
