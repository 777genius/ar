import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileBackendCodexSeedWriteback } from "../file-backend-codex-seed-writeback";
import { CodexAccountCapacityRechecker } from "../application/codex-account-capacity-rechecker";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";

function auth(refresh: string) {
  return JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date().toISOString(), tokens: {
    account_id: "NOT-AN-ACCOUNT-PROBE", refresh_token: `NOT-A-CREDENTIAL-PROBE-${refresh}`,
    access_token: "test-fixture-literal", expiry: "2035-01-01T00:00:00Z",
  } });
}

describe("supported effective quota readers", () => {
  // R3 red for two actual readers of the shared observability contract: each
  // external synthetic app-server accepts only R and records opaque imports.
  it.each(["rechecker", "goal-live", "operator-materialized"])("uses rotated provider refresh in %s", async reader => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-effective-reader-"));
    try {
      const authRoot = join(root, "auth");
      const path = join(authRoot, "synthetic", "auth.json");
      await mkdir(join(authRoot, "synthetic"), { recursive: true });
      const seed = auth("S0"), rotated = auth("R");
      await writeFile(path, seed, { mode: 0o600 });
      expect(await new FileBackendCodexSeedWriteback(path).publish({ source: seed, expected: seed, next: rotated })).toBe(true);
      const binary = join(root, "fake-provider.mts");
      await copyFile(fileURLToPath(new URL("./codex-fake-external-provider.mts", import.meta.url)), binary);
      await chmod(binary, 0o700);
      if (reader === "rechecker") {
        const result = await new CodexAccountCapacityRechecker({ accountId: "synthetic", authJsonPath: path,
          codexBinaryPath: binary, timeoutMs: 3000, appServerLaunchMinIntervalMs: 0,
        }).recheck({ accountId: "synthetic", now: new Date() });
        expect(result.availability).toBe("available");
      } else if (reader === "goal-live") {
        const result = await listCodexGoalAccountStatuses({ authRootDir: authRoot, accounts: ["synthetic"], liveCheck: true,
          codexBinaryPath: binary, liveCheckTimeoutMs: 3000 });
        expect(result[0]?.schedulerEligible).toBe(true);
        expect(result[0]?.liveCheck).toBe("passed");
      } else {
        // Explicit migration of the external source-reader contract: the
        // unchanged quota CLI accepts the effective private home through its
        // already supported --codex-home input. No production script is edited.
        // Exact 5ec lacks this contract and its original source home goes red.
        const module = new URL("../../../dist/worker-codex/codex-effective-seed.js", import.meta.url);
        const present = await access(fileURLToPath(module)).then(() => true, () => false);
        const api = present ? await import(module.href) as typeof import("../codex-effective-seed") : null;
        const effective = api ? await api.materializeCodexEffectiveSeed(path) : null;
        const bin = join(root, "bin"); await mkdir(bin); await symlink(binary, join(bin, "codex"));
        let successful = false;
        try {
          const output = await promisify(execFile)(process.execPath, [
            fileURLToPath(new URL("../../../scripts/ops/codex-account-quota-table.mjs", import.meta.url)),
            "--codex-home", effective?.home ?? join(authRoot, "synthetic"), "--json", "--timeout-ms", "3000", "--min-launch-interval-ms", "0",
          ], { env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` }, timeout: 10_000 });
          const rows = (JSON.parse(output.stdout) as { rows: { available: boolean }[] }).rows;
          successful = rows[0]?.available === true;
          expect(successful).toBe(true);
        } finally { await effective?.finish(successful); }
      }
      const imports = (await readFile(join(root, "imports.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { digest: string });
      const expected = createHash("sha256").update(rotated).digest("hex");
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.every(item => item.digest === expected)).toBe(true);
      expect(await readFile(path, "utf8") === seed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
