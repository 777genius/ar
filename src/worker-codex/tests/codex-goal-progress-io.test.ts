import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeCodexGoalProgress } from "../codex-goal-progress-io";
import type { CodexGoalProgressSnapshot } from "../codex-goal-runner";

const snapshot: CodexGoalProgressSnapshot = { schemaVersion: 1, taskId: "TEST-progress", status: "running",
  updatedAt: "2026-10-19T00:00:00.000Z", pid: 123 };

it("publishes a complete private progress snapshot before its first yield", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-progress-io-")), path = join(root, "nested", "TEST.progress.json");
  let pending: Promise<void> | undefined;
  try {
    pending = writeCodexGoalProgress(path, snapshot);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify(snapshot, null, 2) + "\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, "nested"))).toEqual(["TEST.progress.json"]);
    await pending;
    const terminal = { ...snapshot, status: "completed" as const };
    const next = writeCodexGoalProgress(path, terminal);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(terminal);
    await next;
  } finally { await pending?.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

it("preserves an existing target and propagates a failed progress publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-progress-failed-")), path = join(root, "parent");
  writeFileSync(path, "unchanged");
  try {
    await expect(writeCodexGoalProgress(join(path, "TEST.progress.json"), snapshot)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(path, "utf8")).toBe("unchanged");
    expect(readdirSync(root)).toEqual(["parent"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("closes actual progress descriptors before a strict launch census at the first yield", () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-progress-census-")), path = join(root, "TEST.progress.json");
  const producer = new URL("../../../dist/worker-codex/codex-goal-progress-io.js", import.meta.url).href;
  const census = new URL("../../../dist/provider-codex/app-server/adapters/hosted-process-descriptors.js", import.meta.url).href;
  const script = `import { readFileSync, readdirSync } from "node:fs";
import { writeCodexGoalProgress } from ${JSON.stringify(producer)};
import { assertHostedProcessDescriptors } from ${JSON.stringify(census)};
const path = process.argv[1], snapshot = ${JSON.stringify(snapshot)};
const pending = writeCodexGoalProgress(path, snapshot);
if (readFileSync(path, "utf8") !== JSON.stringify(snapshot, null, 2) + "\\n") throw new Error("TEST incomplete progress");
assertHostedProcessDescriptors();
await Promise.resolve();
assertHostedProcessDescriptors();
await pending;
if (readdirSync(process.argv[2]).some(name => name.endsWith(".tmp"))) throw new Error("TEST retained temp");
process.stdout.write("complete-and-closed");`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path, root], { encoding: "utf8", stdio: "pipe" });
    expect(result.status).toBe(0); expect(result.stdout).toBe("complete-and-closed"); expect(result.stderr).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snapshot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
