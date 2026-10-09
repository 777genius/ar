import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ files: new Map<string, string>(), command: vi.fn(), handler: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: (p: string) => state.files.has(p), mkdirSync: (p: string) => state.files.set(p, ""),
  realpathSync: (p: string) => p, lstatSync: () => ({ isFile: () => true, uid: 0, mode: 0o100600 }),
  writeFileSync: (p: string, bytes: string, options: { flag: string }) => { if (options.flag === "wx" && state.files.has(p)) throw new Error("TEST retained"); state.files.set(p, bytes); },
  renameSync: (a: string, b: string) => { state.files.set(b, state.files.get(a)!); state.files.delete(a); } }));
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: state.command }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: vi.fn() }));
vi.mock("../hosted-mimo-project-bridge", () => ({ handleHostedMimoProjectBridge: state.handler,
  hostedMimoBridgeMetadataBytes: (p: string) => Buffer.from(state.files.get(p)!), parseHostedMimoProjectBinding: () => ({ operationTimeoutMs: 900000 }) }));
import { submitHostedMimoProjectBridge, executeHostedMimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-operation";
import { MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
const request = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-stream", operation: MimoProjectBridgeOperation.Create, jobId: "test-job", prompt: "TEST private prompt", sourceCommit: "b".repeat(40) };
const prefix = "/srv/worker-state/jobs/test-project/test-stream/mimo-bridge-operations/test-job.create";
const entry = "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
beforeEach(() => { state.files.clear(); vi.clearAllMocks(); state.files.set("/etc/machine-id", request.machineId); state.files.set("/etc/subscription-runtime/mimo-projects/test-project/test-stream.json", "{}"); state.command.mockReturnValue("LoadState=not-found\nActiveState=inactive"); state.handler.mockResolvedValue({ ok: true }); });
it("retains an exact owner before uncertain submission and never launches replacement", async () => {
  state.command.mockImplementationOnce(() => { expect(state.files.has(prefix + ".owner.json")).toBe(true); throw new Error("TEST transport timeout"); });
  await expect(submitHostedMimoProjectBridge(request)).rejects.toThrow("TEST transport timeout");
  await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ state: "unresolved" });
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
});
it("schedules a finite owned service with a fixed entry and no prompt in argv", async () => {
  await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ pending: true });
  const args = state.command.mock.calls[0]![1] as string[];
  expect(args).toContain("--property=RuntimeMaxSec=900"); expect(args).toContain(entry); expect(args).toContain("--execute-owned"); expect(args.join(" ")).not.toContain(request.prompt);
});
it("refuses start when create settled with a semantic refusal", async () => {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: false } }));
  const { prompt: _prompt, sourceCommit: _commit, ...control } = request;
  await expect(submitHostedMimoProjectBridge({ ...control, operation: MimoProjectBridgeOperation.Start })).rejects.toThrow("mimo_project_bridge_creation_pending");
});
it("checks the service PID and strips private error detail from durable results", async () => {
  await submitHostedMimoProjectBridge(request);
  const owner = JSON.parse(state.files.get(prefix + ".owner.json")!);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=1\nDescription=" + owner.description);
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).rejects.toThrow("mimo_project_bridge_operation_invalid");
    expect(state.handler).not.toHaveBeenCalled();
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockRejectedValue(new Error("project_control_source_invalid: TEST private path/prompt"));
    await executeHostedMimoProjectBridgeOperation(prefix + ".request.json");
    expect(JSON.parse(state.files.get(prefix + ".result.json")!)).toEqual({ ok: false, error: "project_control_source_invalid" });
  } finally { process.argv[1] = previous!; }
});
