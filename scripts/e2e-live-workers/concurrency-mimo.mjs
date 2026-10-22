#!/usr/bin/env node
// Concurrency e2e for the codex-goal MiMo chain: launches several live workers
// at once (distinct job-roots/workspaces/task-ids) and verifies every one of
// them completes, that a keyless run fails closed without poisoning the shared
// account capacity record, and that a sentinel run after the batch still works.
//
// Usage: MIMO_TOKEN_PLAN_API_KEY=... node scripts/e2e-live-workers/concurrency-mimo.mjs \
//          [--runs N] [--out DIR] [--include-keyless] [--accounts account-a]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const healthyRuns = Number(argValue("--runs", "3"));
const outDir = resolve(argValue("--out", join("/tmp", `concurrency-mimo-${Date.now()}`)));
const includeKeyless = args.includes("--include-keyless");
const accounts = argValue("--accounts", "account-a");

const promptText = "Create a file named ok.txt in the workspace root whose entire content is exactly OK followed by a newline. Write the file first, then reply done.\n";
const cliPath = join(process.cwd(), "dist/worker-codex/codex-goal-cli.js");

if (!includeKeyless && !process.env.MIMO_TOKEN_PLAN_API_KEY) {
  console.error("MIMO_TOKEN_PLAN_API_KEY is required for healthy runs (or pass --include-keyless to only exercise the keyless path).");
  process.exit(2);
}

function seedRun(name, { withKey }) {
  const dir = join(outDir, name);
  const jobRoot = join(dir, "job-root");
  const workspace = join(dir, "workspace");
  mkdirSync(jobRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dir, "prompt.md"), promptText);
  return { name, dir, jobRoot, workspace, withKey, taskId: `mimo-concurrency-${name}-${createHash("sha256").update(name + Date.now()).digest("hex").slice(0, 8)}` };
}

function gitStep(run, args) {
  return new Promise((done, fail) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: run.workspace, stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`git ${args[0]} exited ${code}`))));
  });
}

function commitSeed(run) {
  writeFileSync(join(run.workspace, "README.md"), "# concurrency e2e seed\n");
  return gitStep(run, ["init", "-q"])
    .then(() => gitStep(run, ["add", "README.md"]))
    .then(() => gitStep(run, ["-c", "user.name=iliya", "-c", "user.email=iliyazelenkog@gmail.com",
      "commit", "-q", "-m", "seed base commit"]));
}

function launch(run) {
  const startedAt = Date.now();
  const env = { ...process.env };
  if (!run.withKey) delete env.MIMO_TOKEN_PLAN_API_KEY;
  const logPath = join(run.dir, "launch.log");
  writeFileSync(logPath, "");
  return new Promise((done) => {
    const child = spawn(process.execPath, [
      cliPath, "run",
      "--job-root", run.jobRoot,
      "--workspace", run.workspace,
      "--prompt", join(run.dir, "prompt.md"),
      "--task-id", run.taskId,
      "--accounts", accounts,
      "--model-backend", "xiaomi-mimo-token-plan",
      "--model", "mimo-v2.6-flash",
      "--effort", "high",
      "--no-tmux", "--timeout", "15m",
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stdout += chunk; });
    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      writeFileSync(logPath, stdout);
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"));
      let task;
      try { task = JSON.parse(line).task; } catch { /* non-json failure path */ }
      done({
        name: run.name, taskId: run.taskId, withKey: run.withKey, exitCode: code, durationMs,
        status: task?.status ?? "no-result",
        attemptCount: task?.attempts?.length ?? 0,
        changedFiles: task?.attempts?.[0]?.changedFiles ?? [],
        failureMessage: task ? undefined : stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 400),
      });
    });
  });
}

const runs = [];
for (let i = 1; i <= healthyRuns; i += 1) runs.push(seedRun(`healthy-${i}`, { withKey: true }));
if (includeKeyless) runs.push(seedRun("keyless", { withKey: false }));
await Promise.all(runs.map(commitSeed));

console.log(`launching ${runs.length} workers concurrently -> ${outDir}`);
const results = await Promise.all(runs.map(launch));

// Sentinel: after the batch (including any keyless failure) a fresh healthy run
// must still complete - a poisoned shared account capacity record fails here.
const sentinel = seedRun("sentinel", { withKey: true });
await commitSeed(sentinel);
console.log("launching sentinel run after the batch");
results.push(await launch(sentinel));

const healthy = results.filter((r) => r.withKey);
const problems = [];
for (const result of healthy) {
  if (result.exitCode !== 0 || result.status !== "completed" || !result.changedFiles.includes("ok.txt")) {
    problems.push(`${result.name}: exit=${result.exitCode} status=${result.status}`);
  }
}
const keyless = results.find((r) => !r.withKey);
if (keyless && keyless.status === "completed") {
  problems.push("keyless run unexpectedly completed (must fail closed)");
}
const keylessLog = keyless ? readFileSync(join(outDir, "keyless", "launch.log"), "utf8") : "";
if (keyless && /provider_session_invalid/.test(`${keyless.failureMessage ?? ""}${keylessLog}`)) {
  problems.push("keyless run still reports provider_session_invalid (capacity poisoning risk)");
}

const summary = { outDir, healthyRuns, includeKeyless, accounts, problems, results };
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
for (const result of results) {
  console.log(`${result.name.padEnd(10)} exit=${result.exitCode} status=${result.status} attempts=${result.attemptCount} files=${JSON.stringify(result.changedFiles)} ${result.durationMs}ms${result.failureMessage ? ` failure=${result.failureMessage}` : ""}`);
}
console.log(problems.length === 0 ? "CONCURRENCY E2E: OK" : `CONCURRENCY E2E: FAILED\n- ${problems.join("\n- ")}`);
process.exit(problems.length === 0 ? 0 : 1);
