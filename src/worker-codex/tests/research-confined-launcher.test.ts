import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { TestBootstrapClockReport } from "./research-confined-launcher-test-clock";

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
  // Closed runtime dependency set; launch-frame is only a type import here.
  for (const name of ["hosted-app-server-launcher", "hosted-app-server-launch-frame-decoder", "hosted-process-descriptors", "hosted-fd-prelude", "hosted-blocking-output", "managed-provider-scratch-environment", "hosted-mimo-coding-bootstrap"]) {
    const sourceDirectory = name === "hosted-mimo-coding-bootstrap" ? "src/provider-codex" : "src/provider-codex/app-server/adapters";
    const source = readFileSync(join(process.cwd(), sourceDirectory, name + ".ts"), "utf8");
    const translated = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
      .replace(/from "\.\/((?:hosted-|managed-provider-scratch-)[a-z-]+)"/g, 'from "./$1.mjs"')
      .replace(/from "\.\.\/\.\.\/hosted-mimo-coding-bootstrap"/g, 'from "./hosted-mimo-coding-bootstrap.mjs"');
    writeFileSync(join(root, name + ".mjs"), translated);
  }
  const testClockSource = readFileSync(join(process.cwd(), "src/worker-codex/tests/research-confined-launcher-test-clock.ts"), "utf8");
  writeFileSync(join(root, "TEST-bootstrap-clock.mjs"), transpileModule(testClockSource, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText);
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
function launch(args: string[] = ["--research-ready-v1"], ignoreInput = false, testClock = false) {
  const child = spawn(process.execPath, [
    ...(testClock ? ["--import", join(root, "TEST-bootstrap-clock.mjs")] : []),
    join(root, "hosted-app-server-launcher.mjs"), ...args,
  ], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: [ignoreInput ? "ignore" : "pipe", "pipe", "pipe", ...(testClock ? ["ipc" as const] : [])],
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
  const clock = testClock ? observeTestClock(child) : undefined;
  return { child, exited, first, clock, output: () => ({ stdout, stderr }) };
}
function observeTestClock(child: ReturnType<typeof spawn>) {
  function report<K extends keyof TestBootstrapClockReport>(key: K) {
    const received = new Promise<TestBootstrapClockReport[K]>((resolve, reject) => {
      child.on("message", message => {
        if (typeof message === "object" && message !== null && key in message) {
          resolve((message as TestBootstrapClockReport)[key]);
        }
      });
      child.once("error", reject);
      child.once("close", () => reject(new Error(`TEST clock report absent: ${key}`)));
    });
    void received.catch(() => {});
    return received;
  }
  return {
    requestedDelay: report("testBootstrapDelayMs"),
    partialInputBytes: report("testObservedInputBytes"),
    expire: () => child.send("TEST-expire-bootstrap-timer"),
  };
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
  it("keeps the real launcher ready while final Host verification takes more than ten seconds", async () => {
    const probe = launch();
    try {
      expect(await probe.first).toBe(ready);
      await new Promise(resolve => setTimeout(resolve, 11_000));
      expect(probe.child.exitCode).toBeNull();
      expect(probe.output()).toEqual({ stdout: ready, stderr: "" });
      probe.child.stdin!.end(bootstrap() + "verified\n");
      expect(await probe.exited).toBe(0);
      expect(probe.output()).toEqual({ stdout: ready + "TEST-native:verified\n", stderr: "" });
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
  it.each(["eof", "invalid", "oversize"])("bounds %s bootstrap after readiness without native execution", async fault => {
    const probe = launch();
    try {
      expect(await probe.first).toBe(ready);
      probe.child.stdin!.on("error", () => {}); // Oversize refusal may close this real pipe mid-write.
      if (fault === "eof") probe.child.stdin!.end();
      if (fault === "invalid") probe.child.stdin!.end("{}\n");
      if (fault === "oversize") probe.child.stdin!.end("x".repeat(4 * 1024 * 1024 + 1));
      expect(await probe.exited).toBe(70);
      expect(probe.output().stdout).toBe(ready);
      expect(probe.output().stderr).toContain(fault === "eof" ? "launch_frame_missing" : fault === "oversize" ? "launch_frame_too_large" : "launch_frame_invalid");
    } finally { if (probe.child.exitCode === null) probe.child.kill("SIGTERM"); }
  });
  it("expires the actual five-minute bootstrap timer after readiness without native execution", async () => {
    const probe = launch(["--research-ready-v1"], false, true);
    try {
      expect(await probe.first).toBe(ready);
      // Assert the production scheduling contract independently before advancing
      // only this isolated child's clock. The 11-second case above stays real.
      expect(await probe.clock!.requestedDelay).toBe(300_000);
      probe.child.stdin!.write("{");
      expect(await probe.clock!.partialInputBytes).toBe(1);
      expect(probe.child.exitCode).toBeNull();
      expect(probe.output()).toEqual({ stdout: ready, stderr: "" });
      probe.clock!.expire();
      expect(await probe.exited).toBe(70);
      expect(probe.output()).toEqual({ stdout: ready, stderr: "hosted_app_server_research_bootstrap_timeout\n" });
    } finally { if (probe.child.exitCode === null) probe.child.kill("SIGTERM"); }
  });
});
