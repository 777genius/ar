import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
const moduleUrl = new URL("../../../scripts/ops/host-job-transport.mjs", import.meta.url).href;
type Adapter = { hostTransport(input: { host: string; machineId: string; socketDir: string;
  run: (args: readonly string[], stdin?: string) => Promise<string> }): { request(request: unknown): Promise<unknown> } };
describe("restricted host transport MiMo finite extension", () => {
  it("accepts typed create on the forced endpoint and rejects generic create before any transport effect", async () => {
    const socketDir = await mkdtemp(join(tmpdir(), "mimo-transport-test-"));
    try {
      const adapter = await import(moduleUrl) as Adapter;
      const bodies: string[] = [], argv: readonly string[][] = [];
      const run = async (args: readonly string[], stdin = "") => {
        (argv as string[][]).push([...args]);
        if (!stdin) return "existing master";
        bodies.push(stdin); return JSON.stringify({ ok: true, result: { pending: true } });
      };
      const transport = adapter.hostTransport({ host: "test-mimo-" + process.pid, machineId: "a".repeat(32), socketDir, run });
      await expect(transport.request({ kind: "Other", operation: "create", machineId: "a".repeat(32) })).rejects.toThrow("invalid operation");
      expect(argv).toHaveLength(0);
      const request: MimoProjectBridgeRequest = { kind: "MimoProject", schemaVersion: 1,
        machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-work", jobId: "test-job",
        operation: MimoProjectBridgeOperation.Create, prompt: "Harmless TEST edit", sourceCommit: "b".repeat(40) };
      expect(await transport.request(request)).toEqual({ pending: true });
      expect(bodies.map(body => JSON.parse(body))).toEqual([request]);
      expect(argv.at(-1)).toContain("sr-transport@test-mimo-" + process.pid);
      expect(argv.at(-1)).toContain("-oProxyCommand=false");
    } finally { await rm(socketDir, { recursive: true, force: true }); }
  });
});
