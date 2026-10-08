import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// npm test builds dist first. Missing operands fail before any owned action;
// this checks the actual installed adapter and emitted modules, without mocks.
it("retains closed built operator failure framing without launch or auth operands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "TEST-research-operator-cli-"));
  try {
    const cli = fileURLToPath(new URL("../../../host-integration/codex-research-egress.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "status-owned-research"], {
      cwd, env: {}, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("hosted_research_operator_action_failed\n" + JSON.stringify({
      operation: "status-owned-research", stage: "unknown", legacyCode: "unclassified",
      cause: "none", diagnostic: "unknown",
    }) + "\n");
    expect(readdirSync(cwd)).toEqual([]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
