// Recheck the predecessor on NEW disposable source fixtures. No installed service
// or guest is used; Git/base identity remains the broker's independent gate.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporary = await mkdtemp(join(process.env.SR_NATIVE_PROBE_TMP ?? tmpdir(), "sr-native-probe-predecessor-"));
const evidence = join(workspace, "delivery/a0-native-probe");
const checks: Array<{ command: readonly string[]; cwd: string; exit: number | null; signal: string | null; output: string }> = [];
async function run(args: readonly string[]): Promise<void> {
  const child = spawn(process.execPath, [...args], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", SR_BOOTSTRAP_TEST_TMP: temporary } });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
  const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
  checks.push({ command: [process.execPath, ...args], cwd: temporary, exit: result.code, signal: result.signal, output });
  if (result.code !== 0) throw new Error(`predecessor source check failed (${result.code}/${result.signal})`);
}
async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; } }
async function rewriteGenerated(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await rewriteGenerated(path); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    let bytes = await readFile(path, "utf8");
    const matches = [...bytes.matchAll(/(?:from\s*["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)["']/g)];
    for (const match of matches) {
      const specifier = match[1]; if (!specifier || extname(specifier)) continue;
      const parent = resolve(path, ".."); let replacement: string;
      if (await exists(resolve(parent, specifier + ".js"))) replacement = specifier + ".js";
      else if (await exists(resolve(parent, specifier, "index.js"))) replacement = specifier + "/index.js";
      else continue;
      bytes = bytes.replaceAll(`"${specifier}"`, `"${replacement}"`).replaceAll(`'${specifier}'`, `'${replacement}'`);
    }
    await writeFile(path, bytes);
  }
}
try {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(temporary, "package.json"), '{"type":"module"}\n');
  await cp(join(workspace, "tsconfig.json"), join(temporary, "tsconfig.json"));
  await symlink(join(workspace, "node_modules"), join(temporary, "node_modules"), "dir");
  await cp(join(workspace, "host-integration/native-test-bootstrap"), join(temporary, "host-integration/native-test-bootstrap"), { recursive: true });
  for (const path of ["scripts/ops/host-job-cli.mjs", "scripts/ops/host-job-cli.d.mts", "scripts/ops/host-job-transport.mjs", "scripts/ops/host-job-transport.d.mts", "scripts/ops/host-job-lock.mjs", "host-integration/host-jobs/read-request.mjs", "host-integration/host-jobs/endpoint.mjs"]) {
    const destination = join(temporary, path); await mkdir(resolve(destination, ".."), { recursive: true }); await cp(join(workspace, path), destination);
  }
  const config = join(temporary, "source-build.json");
  await writeFile(config, JSON.stringify({ extends: join(workspace, "tsconfig.build.json"), compilerOptions: { outDir: join(temporary, "dist"), rootDir: join(workspace, "src") }, include: [join(workspace, "src/hosted-native-bootstrap/**/*.ts"), join(workspace, "src/worker-core/hosted-custody/ports/native-test-bootstrap.ts")], exclude: [join(workspace, "src/**/*.test.ts")] }, null, 2));
  const compiler = join(workspace, "node_modules/typescript/bin/tsc");
  await run([compiler, "-p", config]); await rewriteGenerated(join(temporary, "dist"));
  await run([compiler, "--noEmit", "-p", join(temporary, "host-integration/native-test-bootstrap/tsconfig.json")]);
  await run(["--experimental-strip-types", "--test", ...["bootstrap", "boundaries", "recovered-checkpoint"].map(name => join(temporary, `host-integration/native-test-bootstrap/${name}.test.mts`))]);
} finally {
  await writeFile(join(evidence, `source-check-bootstrap-${Date.now()}.json`), JSON.stringify({ qualification: "predecessor-source-fixtures-only", checks }, null, 2) + "\n", { flag: "wx" });
  await rm(temporary, { recursive: true, force: true });
}
