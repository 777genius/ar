import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as effects from "../../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { createCodexGoalRuntimeEventWriter } from "../codex-goal-runtime-events";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "TEST-runtime-events-")); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const identity = { projectId: "test-events", workstreamId: "test-events", jobId: "test-job", taskId: "test-task",
  executionGeneration: "test-generation", attemptNumber: 1, ownershipEpoch: 1, runtimeSha: "a".repeat(40), registryRevisionSha256: "b".repeat(64) };

describe("queued runtime event publication", () => {
  it("retains ordered payloads and private publication modes", async () => {
    const root = fixture(), eventPath = join(root, "events", "runtime.jsonl");
    const writer = createCodexGoalRuntimeEventWriter({ eventPath, taskId: "test-task" });
    const first = writer.write("first", { level: "warning", empty: "", zero: 0, off: false, value: "kept" });
    const second = writer.write("second");
    await Promise.all([first, second]);
    const events = readFileSync(eventPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.event)).toEqual(["first", "second"]);
    expect(events[0]).toMatchObject({ schemaVersion: 1, taskId: "test-task", level: "warning", pid: process.pid,
      attributes: { zero: 0, off: false, value: "kept" } });
    expect(events[1]).not.toHaveProperty("attributes");
    expect(events[1].level).toBe("info");
    expect(Number.isNaN(Date.parse(events[0].timestamp))).toBe(false);
    expect(statSync(join(root, "events")).mode & 0o777).toBe(0o700);
    expect(statSync(eventPath).mode & 0o777).toBe(0o600);
  });

  it("rechecks the effect path before append and rejects the entire pending queue on failure", async () => {
    const root = fixture(), eventPath = join(root, "events", "runtime.jsonl");
    let guards = 0;
    vi.spyOn(effects, "assertHostedOrdinaryEffectPaths").mockImplementation(paths => {
      expect(paths).toEqual([eventPath]);
      if (++guards === 2) throw new Error("TEST-path-revoked-before-append");
    });
    const writer = createCodexGoalRuntimeEventWriter({ eventPath, taskId: "test-task" });
    const first = writer.write("refused"), later = writer.write("must-not-publish");
    await expect(first).rejects.toThrow("TEST-path-revoked-before-append");
    await expect(later).rejects.toThrow("TEST-path-revoked-before-append");
    expect(guards).toBe(2);
    expect(existsSync(eventPath)).toBe(false);
  });

  it("keeps append errors rejected without advancing later events", async () => {
    const root = fixture(), eventPath = join(root, "directory-instead-of-file"); mkdirSync(eventPath);
    const writer = createCodexGoalRuntimeEventWriter({ eventPath, taskId: "test-task" });
    const failed = writer.write("failed"), queued = writer.write("queued");
    await expect(failed).rejects.toMatchObject({ code: "EISDIR" });
    await expect(queued).rejects.toMatchObject({ code: "EISDIR" });
    expect(statSync(eventPath).isDirectory()).toBe(true);
  });

  it("still honors a claimed terminal checkpoint before publishing", async () => {
    const root = fixture(), eventPath = join(root, "events", "runtime.jsonl");
    const gate = new LocalTerminalCheckpointAdmission(root), claim = await gate.claim("test-checkpoint", identity);
    try {
      const writer = createCodexGoalRuntimeEventWriter({ eventPath, taskId: "test-task", terminalCheckpointJobRootDir: root });
      await expect(writer.write("fenced")).rejects.toThrow("terminal_checkpoint_job_fenced");
      expect(existsSync(eventPath)).toBe(false);
    } finally { await gate.release(claim, false); }
  });

  it("publishes bytes before yielding from the admitted callback", async () => {
    const root = fixture(), eventPath = join(root, "events", "runtime.jsonl");
    const original = LocalTerminalCheckpointAdmission.prototype.withWriter;
    let publishedAtCallbackReturn = false;
    vi.spyOn(LocalTerminalCheckpointAdmission.prototype, "withWriter").mockImplementation(function (this: LocalTerminalCheckpointAdmission, effect) {
      return original.call(this, async () => {
        const pending = effect();
        publishedAtCallbackReturn = existsSync(eventPath);
        return await pending;
      });
    });
    const writer = createCodexGoalRuntimeEventWriter({ eventPath, taskId: "test-task", terminalCheckpointJobRootDir: root });
    await writer.write("admitted");
    expect(publishedAtCallbackReturn).toBe(true);
    expect(JSON.parse(readFileSync(eventPath, "utf8")).event).toBe("admitted");
  });

  // Actual compiled writer and kernel FD observation, not source-text assertions
  // or fake filesystem completion. CI builds dist before its ordinary unit lanes.
  it.skipIf(process.platform !== "linux")("leaves no event descriptor at async census boundaries in the compiled writer", () => {
    const source = fileURLToPath(new URL("./fixtures/runtime-event-fd-census.mts", import.meta.url));
    const writer = resolve("dist/worker-codex/codex-goal-runtime-events.js");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", source, writer], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "passed", eventDescriptorObservations: 0, eventCount: 4 });
  });
});
