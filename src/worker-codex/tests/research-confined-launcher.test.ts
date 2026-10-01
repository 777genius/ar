import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

// Execute the actual adapter source in fresh Node children with real pipe/fd
// checks. Only TS syntax/import suffixes are translated; no systemd/unshare,
// provider, auth or network process is started in this offline fixture.
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "TEST-research-ready-r9-"));
  const helper = join(root, "TEST-helper");
  mkdirSync(join(helper, "host-integration"), { recursive: true }); mkdirSync(join(helper, "dist/worker-codex"), { recursive: true });
  writeFileSync(join(helper, "package.json"), '{"type":"module"}');
  writeFileSync(join(helper, "host-integration/research-provider-launch.mjs"), readFileSync("host-integration/research-provider-launch.mjs"));
  // Only the module invocation is observed; no admission/service/provider runs.
  writeFileSync(join(helper, "dist/worker-codex/research-provider-service.js"),
    'export async function runResearchProviderService(...args) { process.stdout.write(JSON.stringify(args)); }');
  for (const name of ["hosted-app-server-launcher", "hosted-app-server-launch-frame", "hosted-process-descriptors"]) {
    const source = readFileSync(join(process.cwd(), "src/provider-codex/app-server/adapters", name + ".ts"), "utf8");
    const translated = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
      .replace(/from "\.\/(hosted-[a-z-]+)"/g, 'from "./$1.mjs"');
    writeFileSync(join(root, name + ".mjs"), translated);
  }
});
describe("actual fixed research helper selected-home transport (TEST service stub)", () => {
  it("forwards exactly job, unit and selected nominal home", () => {
    const args = ["TEST-job", "subscription-runtime-research-provider-12345678-1234-1234-1234-123456789abc.service", "/TEST-job/home/TEST-a"];
    const result = spawnSync(process.execPath, [join(root, "TEST-helper/host-integration/research-provider-launch.mjs"), ...args], { encoding: "utf8" });
    expect(result.status).toBe(0); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toEqual(args);
  });
  it.each([{ args: [] }, { args: ["TEST-job", "TEST-unit"] }, { args: ["TEST-job", "TEST-unit", "/TEST-home", "--property=Delegate=yes"] }])("rejects wrong fixed arity $args before invoking the service", ({ args }) => {
    const result = spawnSync(process.execPath, [join(root, "TEST-helper/host-integration/research-provider-launch.mjs"), ...args], { encoding: "utf8" });
    expect(result.status).toBe(70); expect(result.stdout).toBe(""); expect(result.stderr).toBe("hosted_research_provider_launch_denied\n");
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ready = "subscription-runtime-research-provider-ready-v1\n";
function launch(args: string[] = ["--research-ready-v1"], ignoreInput = false) {
  const child = spawn(process.execPath, [join(root, "hosted-app-server-launcher.mjs"), ...args], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: [ignoreInput ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += String(chunk); }); child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const first = new Promise<string>((resolve, reject) => {
    const onData = (): void => { if (stdout.includes("\n")) { child.stdout!.off("data", onData); resolve(stdout); } };
    child.stdout!.on("data", onData); child.once("error", reject);
    child.once("close", () => { if (!stdout.includes("\n")) reject(new Error("TEST readiness absent")); });
  });
  void first.catch(() => {});
  return { child, exited, first, output: () => ({ stdout, stderr }) };
}
function bootstrap(): string {
  return JSON.stringify({ schemaVersion: 1, command: process.execPath, args: ["-e",
    'process.stdin.resume();process.stdin.on("data",b=>process.stdout.write("TEST-native:"+b));process.stdin.on("end",()=>process.exit(0));'],
    cwd: root, env: { PATH: "/usr/bin:/bin" } }) + "\n";
}
describe("fixed pre-bootstrap ready mode in the actual launcher (real isolated children/streams)", () => {
  it("emits exactly the fixed frame before native bootstrap and then preserves protocol bytes", async () => {
    const probe = launch();
    try {
      expect(await probe.first).toBe(ready); expect(probe.output().stdout).not.toContain("TEST-native");
      probe.child.stdin!.end(bootstrap() + "request\n");
      expect(await probe.exited).toBe(0);
      expect(probe.output()).toEqual({ stdout: ready + "TEST-native:request\n", stderr: "" });
    } finally { if (probe.child.exitCode === null) probe.child.kill("SIGTERM"); }
  });
  it("keeps the ordinary no-argument protocol free of ready frames", async () => {
    const probe = launch([]); probe.child.stdin!.end(bootstrap() + "ordinary\n");
    expect(await probe.exited).toBe(0); expect(probe.output().stdout).toBe("TEST-native:ordinary\n");
  });
  it.each(["--foreign-ready", "--research-ready-v1 extra"])("refuses unknown launcher mode %s without launching input", async mode => {
    const probe = launch(mode.split(" ")); probe.child.stdin!.end();
    expect(await probe.exited).toBe(70); expect(probe.output()).toEqual({ stdout: "", stderr: "hosted_app_server_launch_mode_invalid\n" });
  });
  it("checks actual descriptors before readiness even without a bootstrap", async () => {
    const probe = launch(["--research-ready-v1"], true);
    expect(await probe.exited).toBe(70); expect(probe.output()).toEqual({ stdout: "", stderr: "hosted_app_server_descriptor_boundary_invalid\n" });
  });
  it("cancels the actual waiting launcher before any native/bootstrap execution", async () => {
    const probe = launch();
    expect(await probe.first).toBe(ready);
    probe.child.kill("SIGTERM");
    expect(await probe.exited).toBeNull(); expect(probe.child.signalCode).toBe("SIGTERM");
    expect(probe.output()).toEqual({ stdout: ready, stderr: "" });
  });
  it.each(["eof", "invalid", "oversize", "timeout"])("bounds %s bootstrap after readiness without native execution", async fault => {
    const probe = launch();
    try {
      expect(await probe.first).toBe(ready);
      probe.child.stdin!.on("error", () => {}); // Oversize refusal may close this real pipe mid-write.
      if (fault === "eof") probe.child.stdin!.end();
      if (fault === "invalid") probe.child.stdin!.end("{}\n");
      if (fault === "oversize") probe.child.stdin!.end("x".repeat(4 * 1024 * 1024 + 1));
      if (fault === "timeout") probe.child.stdin!.write("{");
      expect(await probe.exited).toBe(70);
      expect(probe.output().stdout).toBe(ready);
      expect(probe.output().stderr).toContain(fault === "timeout" ? "research_bootstrap_timeout" :
        fault === "eof" ? "launch_frame_missing" : fault === "oversize" ? "launch_frame_too_large" : "launch_frame_invalid");
    } finally { if (probe.child.exitCode === null) probe.child.kill("SIGTERM"); }
  });
});
