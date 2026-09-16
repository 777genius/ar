import { describe, expect, it } from "vitest";
import {
  ledgerEpochProcessBlocks,
  type LedgerEpochProcessSnapshot,
} from "../application/project-control/codex-goal-ledger-epoch-process-guard";

const selector = {
  registryRootDir: "/var/data/social-monitor/worker-jobs/registry-v4",
  controllerJobId: "social-monitor-project-controller-v4",
  ledgerRoot: "/var/data/social-monitor/control/consumed-output-ledger",
  selfPid: 777,
};

describe("ledger epoch process selector", () => {
  it("allows foreign OpenAI and Infinity bridges", () => {
    expect(blocks(8890, ["node", "/app/openai-compatible-codex/cli.js"])).toBe(false);
    expect(blocks(8891, ["infinity-bridge", "--port", "8891"])).toBe(false);
  });

  it("blocks exact goal MCP entrypoints but not substring spoofs", () => {
    expect(blocks(10, ["node", "/app/worker-codex/codex-goal-mcp.js"])).toBe(true);
    expect(blocks(11, ["node", "/tmp/codex-goal-mcp.js.bak"])).toBe(false);
    expect(blocks(14, ["sh", "-c", "echo codex-goal-mcp.js"])).toBe(false);
    expect(blocks(15, ["node", "-e", "console.log('codex-goal-mcp.js')"])).toBe(false);
  });

  it("scopes direct CLI processes to the selected controller", () => {
    expect(blocks(12, [
      "subscription-runtime-codex-goal", "controller-supervise",
      "--registry-root", selector.registryRootDir,
    ])).toBe(true);
    expect(blocks(13, [
      "subscription-runtime-codex-goal", "controller-supervise",
      "--registry-root", "/var/data/other/registry-v4",
    ])).toBe(false);
  });

  it("excludes only the exact self pid", () => {
    expect(blocks(777, ["subscription-runtime-codex-goal-mcp"])).toBe(false);
  });
});

function blocks(pid: number, argv: readonly string[]): boolean {
  const snapshot: LedgerEpochProcessSnapshot = {
    pid,
    startTime: "1234",
    argv,
    executablePath: "/usr/bin/node",
    cwd: "/app",
    cgroup: "0::/system.slice/social-monitor.service",
  };
  return ledgerEpochProcessBlocks(snapshot, selector);
}
