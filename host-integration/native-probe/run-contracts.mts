import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkInputs, type CheckedInput } from "./check-inputs.mts";

const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const compiler = join(workspace, "node_modules/typescript/bin/tsc");
const config = join(workspace, "host-integration/native-probe/tsconfig.json");
const evidence = resolve(process.env.SR_NATIVE_PROBE_EVIDENCE ?? join(workspace, "delivery/a0-native-probe"));
await mkdir(evidence, { recursive: true });
const log: Array<{ command: readonly string[]; exit: number | null; signal: string | null; output: string }> = [];
async function run(command: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}, display = true, cwd = workspace): Promise<string> {
  const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", ...extra } });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (display) process.stdout.write(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); if (display) process.stderr.write(chunk); });
  const result = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
  });
  log.push({ command: [command, ...args], exit: result.code, signal: result.signal, output });
  if (result.code !== 0) throw new Error(`source check failed: ${command} (${result.code}/${result.signal})`);
  return output;
}
const temporary = await mkdtemp(join(process.env.SR_NATIVE_PROBE_TMP ?? tmpdir(), "sr-native-probe-contract-"));
let inputs: readonly CheckedInput[] = [], inputsStable = false, passed = false;
try {
  const graph = await run(process.execPath, [compiler, "--listFilesOnly", "-p", config], {}, false);
  inputs = await checkInputs(workspace, graph);
  await run(process.execPath, [compiler, "--noEmit", "--skipLibCheck", "false", "-p", config]);
  const build = join(temporary, "dist"), client = join(temporary, "contract-client");
  await run(process.execPath, [compiler, "-p", config, "--skipLibCheck", "false", "--noEmit", "false", "--outDir", build]);
  await writeFile(join(build, "package.json"), '{"type":"module"}\n');
  await run(process.execPath, [join(workspace, "scripts/rewrite-dist-esm-imports.mjs")], {}, true, temporary);
  const native = join(workspace, "host-integration/native-probe/native");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-pthread", ...["clock.c", "channel.c", "helper-profile.c", "publication.c", "resources.c", "stock-manager.c", "contract-client.c"].map(file => join(native, file)), "-Wl,-l:libsystemd.so.0", "-o", client]);
  const addon = join(temporary, "node-contract.node");
  await run("/usr/bin/cc", ["-std=c17", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-pthread", "-shared", "-fPIC", join(native, "helper-profile.c"), join(native, "node-contract-addon.c"), "-o", addon]);
  await run(process.execPath, ["--test", join(build, "host-integration/native-probe/contracts.test.mjs")], { NP_CLIENT: client, NP_FIXTURES: temporary, NP_NODE_SCRIPT: join(build, "host-integration/native-probe/node-contract.mjs"), NP_NODE_ADDON: addon });
  inputsStable = JSON.stringify(inputs) === JSON.stringify(await checkInputs(workspace, graph));
  if (!inputsStable) throw new Error("checked source changed during verification");
  passed = true;
} finally {
  await writeFile(join(evidence, `source-check-${Date.now()}.json`), JSON.stringify({ qualification: "harmless-source-contracts-only", passed, inputsStable, inputs, checks: log }, null, 2) + "\n", { flag: "wx" });
  await rm(temporary, { recursive: true, force: true });
}
