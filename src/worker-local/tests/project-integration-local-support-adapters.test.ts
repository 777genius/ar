import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  SecretScanStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalConsumedOutputLedgerWriter,
  LocalProjectCheckRunner,
  LocalWorkspaceIntegrationLock,
  SimpleSecretScanner,
} from "../index";
import {
  createGitFixture,
  tempRoots,
} from "./project-integration-local-adapters.fixture";

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("local project integration support adapters", () => {
  it("preserves a rejected attempt when a later attempt integrates the same worker", async () => {
    const fixture = await createGitFixture();
    const writer = new LocalConsumedOutputLedgerWriter();
    const ledgerRoot = join(fixture.rootDir, "ledger");
    const backup = {
      workspace: fixture.workspacePath,
      statusPath: "/archive/status",
      patchPath: "/archive/patch",
    };
    await writer.record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: "worker-1",
        attemptId: "rejected-attempt",
        status: "rejected",
        closedAt: "2026-07-12T00:00:00.000Z",
        archivePath: "/archive/rejected",
        note: "rejected metadata-only attempt",
        backup,
      },
    });
    const integrated = {
      schemaVersion: 1 as const,
      jobId: "worker-1",
      attemptId: "integrated-attempt",
      status: "integrated" as const,
      closedAt: "2026-07-12T01:00:00.000Z",
      commitSha: "abc123",
      archivePath: "/archive/integrated",
      note: "integrated reviewed output",
      backup,
    };

    await expect(writer.assertCanRecord({ ledgerRoot, decision: integrated }))
      .resolves.toBeUndefined();
    await writer.record({ ledgerRoot, decision: integrated });

    const integratedRecord = JSON.parse(await readFile(
      join(ledgerRoot, "items", "worker-1--integrated-attempt.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(integratedRecord).toMatchObject({
      status: "integrated",
      attemptId: "integrated-attempt",
      commitSha: "abc123",
    });
    await expect(readFile(
      join(ledgerRoot, "items", "worker-1--rejected-attempt.json"),
      "utf8",
    )).resolves.toContain('"status": "rejected"');
  });

  it("runs pnpm checks through corepack when pnpm is not directly installed", async () => {
    const fixture = await createGitFixture();
    const binDir = join(fixture.rootDir, "bin");
    await mkdir(binDir);
    const corepackPath = join(binDir, "corepack");
    await writeFile(
      corepackPath,
      "#!/bin/sh\nprintf '%s' \"$*\"\n",
      "utf8",
    );
    await chmod(corepackPath, 0o755);
    const runner = new LocalProjectCheckRunner({
      env: { PATH: binDir },
    });

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "pnpm-check",
        command: ["pnpm", "exec", "vitest", "run", "unit.test.ts"],
      },
    })).resolves.toMatchObject({
      checkId: "pnpm-check",
      status: CheckRunStatus.Passed,
      exitCode: 0,
      safeOutputTail: "pnpm exec vitest run unit.test.ts\n",
    });
  });

  it("fails checks whose cwd escapes the workspace", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "outside",
        command: [process.execPath, "-e", "process.exit(0)"],
        cwd: "..",
      },
    })).resolves.toMatchObject({
      checkId: "outside",
      status: CheckRunStatus.Failed,
      safeOutputTail: "check_cwd_outside_workspace",
    });
  });

  it("detects secret-like file contents without printing the secret", async () => {
    const fixture = await createGitFixture();
    await writeFile(
      join(fixture.workspacePath, "src", "secret.ts"),
      "export const token = 'sk-abcdefghijklmnopqrstuvwxyz';\n",
      "utf8",
    );
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath: fixture.workspacePath,
      files: ["src/secret.ts"],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: "secret_like_content:src/secret.ts",
    });
  });

  it("uses a real workspace lock store for integration locks", async () => {
    const fixture = await createGitFixture();
    const lock = new LocalWorkspaceIntegrationLock({
      rootDir: join(fixture.rootDir, "locks"),
    });
    const first = await lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-1",
    });

    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).rejects.toThrow("Workspace is already locked");

    await lock.release(first);
    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).resolves.toMatchObject({
      owner: "attempt-2",
    });
  });
});
