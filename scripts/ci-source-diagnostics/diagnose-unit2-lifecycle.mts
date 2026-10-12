import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

// Failure-only SOURCE observation. Never qualification, native authority or a fix.
const kind = "SOURCE_DIAGNOSTIC_ONLY_NOT_QUALIFICATION";
const files = ["src/worker-codex/tests/hosted-lifecycle-composition.test.ts", "src/worker-codex/tests/hosted-readonly-goal-launch.test.ts"] as const;
const ops = "src/worker-codex/codex-goal-ops.ts";
const emittedOps = "dist/worker-codex/codex-goal-ops.js";
const errorCodes = ["hosted_readonly_host_operator_required", "hosted_test_egress_host_operator_required", "hosted_dependency_fixed_goal_composition_required", "hosted_readonly_dependency_egress_denied", "hosted_test_egress_admission_invalid", "hosted_test_egress_identity_invalid", "hosted_test_egress_custody_invalid", "hosted_test_egress_grant_invalid", "hosted_readonly_policy_binding_mismatch", "hosted_readonly_policy_invalid", "codex_goal_provider_egress_admission_mismatch", "ENOENT", "EACCES", "EPERM"];
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
function refuse(): never { throw new Error("source_diagnostic_preparation_refused"); }
function git(root: string, args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function replaceOnce(source: string, needle: string, replacement: string): string {
  if (source.split(needle).length !== 2) refuse();
  return source.replace(needle, replacement);
}
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) refuse();
      if (stat.isDirectory()) visit(path);
      else hash.update(path.slice(root.length + 1)).update("\0").update(sha(readFileSync(path))).update("\n");
    }
  };
  visit(root); return hash.digest("hex");
}
function assertPlainTree(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
  for (const entry of readdirSync(root)) {
    const path = join(root, entry), child = lstatSync(path);
    if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) refuse();
    if (child.isDirectory()) assertPlainTree(path);
  }
}
function main(): void {
  const args = process.argv.slice(2), prepareOnly = args[2] === "--prepare-only";
  if ((args.length !== 2 && !prepareOnly) || args.length > 3 || !args[0] || !args[1]) refuse();
  if (!prepareOnly && process.platform !== "linux") refuse();
  const checkout = realpathSync(args[0]), target = resolve(args[1]), parent = realpathSync(dirname(target));
  if (parent !== dirname(target) || existsSync(target) || !/^subscription-unit2-SOURCE-diagnostic-[a-zA-Z0-9_-]+$/.test(basename(target))) refuse();
  const head = git(checkout, ["rev-parse", "HEAD"]), tree = git(checkout, ["rev-parse", "HEAD^{tree}"]);
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(tree) || git(checkout, ["diff", "HEAD", "--name-only", "--", "src", "packages"]) !== "") refuse();
  // Dirty source cannot be silently treated as the tested checkout snapshot.
  for (const file of [...files, ops]) {
    const tracked = execFileSync("git", ["-C", checkout, "show", `${head}:${file}`], { stdio: ["ignore", "pipe", "ignore"] });
    if (!tracked.equals(readFileSync(join(checkout, file)))) refuse();
  }
  for (const path of ["dist", "packages/agent-account-observability/dist"]) assertPlainTree(join(checkout, path));
  mkdirSync(target, { mode: 0o700 });
  const source = join(target, "source"), evidence = join(target, "evidence");
  mkdirSync(evidence, { mode: 0o700 });
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", "--quiet", checkout, source], { stdio: "ignore" });
  execFileSync("git", ["-C", source, "checkout", "--quiet", "--detach", head], { stdio: "ignore" });
  if (git(source, ["rev-parse", "HEAD"]) !== head) refuse();
  // Preserve this job's build context; do not install/rebuild or write shared dist.
  for (const path of ["dist", "packages/agent-account-observability/dist"]) cpSync(join(checkout, path), join(source, path), { recursive: true });
  const buildContext: Record<string, string> = {};
  for (const path of ["dist", "packages/agent-account-observability/dist"]) {
    const original = treeDigest(join(checkout, path)), copied = treeDigest(join(source, path));
    if (original !== copied) refuse(); buildContext[path] = copied;
  }
  const installed = realpathSync(join(checkout, "node_modules")), deps = join(source, "node_modules");
  mkdirSync(deps);
  for (const entry of readdirSync(installed)) {
    if (["@vioxen", ".cache", ".vite", ".vite-temp"].includes(entry)) continue;
    symlinkSync(join(installed, entry), join(deps, entry));
  }
  mkdirSync(join(deps, "@vioxen"));
  const scope = join(installed, "@vioxen");
  for (const entry of readdirSync(scope)) symlinkSync(entry === "agent-account-observability" ? join(source, "packages", entry) : join(scope, entry), join(deps, "@vioxen", entry));
  const events = join(evidence, "events.jsonl"), summary = join(evidence, "summary.json"), manifest = join(evidence, "manifest.json");
  writeFileSync(events, "", { mode: 0o600, flag: "wx" });
  const before: Record<string, string> = {}, after: Record<string, string> = {};
  const save = (file: string, transform: (body: string) => string): void => {
    const path = join(source, file), bytes = readFileSync(path, "utf8"); if (bytes.includes("sourceDiagnostic")) refuse(); before[file] = sha(bytes);
    const changed = transform(bytes); after[file] = sha(changed); writeFileSync(path, changed);
  };
  const sink = JSON.stringify(events);
  const emit = (object: string): string => `try { sourceDiagnosticAppend(${sink}, JSON.stringify(${object}) + "\\n"); } catch { /* observation cannot change the tested outcome */ }`;
  for (const file of [ops, emittedOps]) save(file, body => {
    const typed = file === ops;
    body = replaceOnce(body, 'import { constants, lstatSync } from "node:fs";', 'import { constants, lstatSync, appendFileSync as sourceDiagnosticAppend } from "node:fs";');
    body = replaceOnce(body, 'import { promisify } from "node:util";', 'import { promisify, types as sourceDiagnosticTypes } from "node:util";');
    const needle = 'const result = await runCodexGoal(input.config).catch(() => ({ status: "failed" }));';
    const errorType = typed ? ": unknown" : "";
    return replaceOnce(body, needle, `${emit('{ phase: "ops-runner-attempt" }')}\n    const result = await runCodexGoal(input.config).catch((error${errorType}) => {\n      try {\n        const allowed = ${JSON.stringify(errorCodes)};\n        const inspectable = error !== null && typeof error === "object" && !sourceDiagnosticTypes.isProxy(error);\n        const messageDescriptor = inspectable ? Object.getOwnPropertyDescriptor(error, "message") : undefined;\n        const codeDescriptor = inspectable ? Object.getOwnPropertyDescriptor(error, "code") : undefined;\n        const message = messageDescriptor && Object.hasOwn(messageDescriptor, "value") && typeof messageDescriptor.value === "string" ? messageDescriptor.value : undefined;\n        const systemCode = codeDescriptor && Object.hasOwn(codeDescriptor, "value") && typeof codeDescriptor.value === "string" ? codeDescriptor.value : undefined;\n        const code = message && allowed.includes(message) ? message : systemCode && allowed.includes(systemCode) ? systemCode : "unclassified";\n        ${emit('{ phase: "ops-runner-catch", code }')}\n      } catch { /* never persist an unclassified exception */ }\n      return { status: "failed" };\n    });\n    ${emit('{ phase: "ops-runner-result", status: result.status === "completed" ? "completed" : "not-completed" }')}`);
  });
  const fixtureSink = (fixture: string, object: string): string => `try { ${fixture}.sourceDiagnosticAppend(JSON.stringify(${object}) + "\\n"); } catch { /* observation cannot change the tested outcome */ }`;
  const writerNeedle = 'const real = await original<typeof import("node:fs")>();';
  const bindFixtureWriter = (body: string, fixture: string): string => replaceOnce(body, writerNeedle, `${writerNeedle}\n  ${fixture}.sourceDiagnosticAppend = (payload: string): void => { try { real.appendFileSync(${sink}, payload); } catch { /* finite TEST telemetry only */ } };`);
  save(files[0], body => {
    body = replaceOnce(body, 'activationEnabled:true,run:vi.fn()}));', 'activationEnabled:true,run:vi.fn(),sourceDiagnosticAppend:(_payload:string):void=>{}}));');
    body = bindFixtureWriter(body, "h");
    return replaceOnce(body, 'afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()});', `afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()});\nlet sourceDiagnosticOrdinal = 0;\nafterEach(() => { ${fixtureSink("h", '{ phase: "lifecycle-fixture-end", ordinal: ++sourceDiagnosticOrdinal, goalCalls: h.events.filter(event => event === "goal-effect").length, admits: h.events.filter(event => event === "admit").length, doctors: h.events.filter(event => event === "doctor").length }')} });`);
  });
  save(files[1], body => {
    body = replaceOnce(body, 'activationEnabled: true }));', 'activationEnabled: true, sourceDiagnosticAppend: (_payload: string): void => {} }));');
    body = bindFixtureWriter(body, "f");
    body = replaceOnce(body, 'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";', 'import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";');
    return body + `\nlet sourceDiagnosticOrdinal = 0;\nafterEach(() => { ${fixtureSink("f", '{ phase: "readonly-fixture-end", ordinal: ++sourceDiagnosticOrdinal, goalCalls: f.run.mock.calls.length, admits: f.admit.mock.calls.length }')} });\n`;
  });
  const reporter = join(source, "source-diagnostic-reporter.mts");
  writeFileSync(reporter, `import { writeFileSync } from "node:fs";\nimport type { Reporter } from "vitest/reporters";\nexport default class implements Reporter {\n  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]> = (modules, errors, reason) => {\n    const counts = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };\n    for (const module of modules) for (const test of module.children.allTests()) {\n      counts.total++; const state = test.result().state;\n      if (state === "passed") counts.passed++; else if (state === "failed") counts.failed++; else if (state === "skipped") counts.skipped++; else counts.pending++;\n    }\n    writeFileSync(${JSON.stringify(summary)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, ...counts, unhandledErrorCount: errors.length, interrupted: reason === "interrupted" }) + "\\n", { mode: 0o600 });\n  };\n}\n`, { flag: "wx", mode: 0o600 });
  const installedVersion = (packageName: string): string => {
    const decoded: unknown = JSON.parse(readFileSync(join(installed, packageName, "package.json"), "utf8"));
    if (!decoded || typeof decoded !== "object" || !("version" in decoded) || typeof decoded.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(decoded.version)) refuse();
    return decoded.version;
  };
  const metadata = { kind, instrumentedSourceOnly: true, qualification: false, parentUnitFailureRetention: "caller-exits-original-status-unconditionally", vitestVersion: installedVersion("vitest"), typescriptVersion: installedVersion("typescript"), sourceHead: head, sourceTree: tree, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, buildContext, before, after, errorCodeWhitelist: errorCodes, prepareOnly };
  writeFileSync(manifest, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (prepareOnly) { console.info(JSON.stringify({ kind, prepared: true, sourceHead: head })); return; }
  const result = spawnSync(process.execPath, [join(deps, "vitest/vitest.mjs"), "run", ...files, "--maxWorkers=1", "--no-cache", "--configLoader", "runner", "--reporter", reporter, "--silent"], { cwd: source, stdio: "ignore", timeout: 180_000 });
  const exit = result.status ?? 125;
  appendFileSync(events, JSON.stringify({ phase: "diagnostic-process-end", exitCode: exit, timedOutOrAbnormal: result.status === null }) + "\n");
  if (git(checkout, ["rev-parse", "HEAD"]) !== head) refuse();
  console.info(JSON.stringify({ kind, sourceHead: head, diagnosticExitCode: exit, summaryPresent: existsSync(summary) }));
  // The caller must preserve the ORIGINAL unit failure, irrespective of this code.
  process.exitCode = exit;
}
try { main(); } catch { console.error("source_diagnostic_preparation_refused"); process.exitCode = 125; }
