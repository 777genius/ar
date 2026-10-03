import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTerminalCheckpointAdmission } from "../terminal-checkpoint/local-terminal-checkpoint-admission";

const identity = { projectId: "test-project", workstreamId: "test-workstream",
  jobId: "test-job", taskId: "test-task", executionGeneration: "test-generation",
  attemptNumber: 1, ownershipEpoch: 1, runtimeSha: "a".repeat(40),
  registryRevisionSha256: "b".repeat(64) };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "test-checkpoint-admission-"));
  return { root, a: new LocalTerminalCheckpointAdmission(root),
    b: new LocalTerminalCheckpointAdmission(root),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("durable terminal checkpoint job admission", () => {
  it("keeps admission through the writer's final publication and fences a claim", async () => {
    const f = await fixture();
    try {
      let publish!: () => void;
      let entered!: () => void;
      const publication = new Promise<void>((resolve) => { publish = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const writing = f.a.withWriter(async () => { entered(); await publication; });
      await inside;
      await expect(f.b.claim("test-checkpoint-1", identity)).rejects.toThrow("writers_active");
      publish();
      await writing;
      const claim = await f.b.claim("test-checkpoint-1", identity);
      await expect(f.a.withWriter(async () => {})).rejects.toThrow("job_fenced");
      await f.b.assertClaim(claim);
      await f.b.release(claim, true);
      await f.a.withWriter(async () => {});
      await expect(f.b.assertClaim(claim)).rejects.toThrow("stale_fence");
      const next = await f.a.claim("test-checkpoint-2", identity);
      expect(next.fence).toBe(claim.fence + 1);
      await expect(f.b.release(claim, false)).rejects.toThrow("stale_fence");
      await f.a.release(next, false);
      const state = JSON.parse(await readFile(join(f.root, ".terminal-checkpoint-admission", "state.json"), "utf8"));
      expect(state).toMatchObject({ phase: "open", fence: next.fence });
    } finally { await f.cleanup(); }
  });

  it("lets an unrelated job write while another job is claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-checkpoint-jobs-"));
    const { mkdir } = await import("node:fs/promises");
    try {
      const jobA = join(root, "job-a");
      const jobB = join(root, "job-b");
      await mkdir(jobA); await mkdir(jobB);
      const a = new LocalTerminalCheckpointAdmission(jobA);
      const b = new LocalTerminalCheckpointAdmission(jobB);
      const claim = await a.claim("test-checkpoint-a", identity);
      let wrote = false;
      await b.withWriter(async () => { wrote = true; });
      expect(wrote).toBe(true);
      await expect(a.withWriter(async () => {})).rejects.toThrow("job_fenced");
      await a.release(claim, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains an unproven claim across new adapter instances", async () => {
    const f = await fixture();
    try {
      const claim = await f.a.claim("test-checkpoint-crash", identity);
      const restarted = new LocalTerminalCheckpointAdmission(f.root);
      await expect(restarted.claim(claim.checkpointId, identity)).rejects.toThrow("job_fenced");
      await expect(restarted.withWriter(async () => {})).rejects.toThrow("job_fenced");
      await expect(restarted.claim("test-other", identity)).rejects.toThrow("job_fenced");
    } finally { await f.cleanup(); }
  });

  it("refuses a live claim while controller writer inventory is incomplete", async () => {
    const f = await fixture();
    try {
      await expect(f.a.claim("checkpoint-live", { ...identity, projectId: "production" }))
        .rejects.toThrow("live_claim_unsupported");
    } finally { await f.cleanup(); }
  });
});
