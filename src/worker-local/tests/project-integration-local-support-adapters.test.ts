import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  SecretScanStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalConsumedOutputLedgerWriter,
  LocalConsumedOutputLedgerMutationLock,
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
  it("coordinates terminal writers with the consumed-output mutation lock", async () => {
    const fixture = await createGitFixture();
    const ledgerRoot = join(fixture.rootDir, "ledger-lock-test");
    await mkdir(ledgerRoot);
    const archivePath = join(fixture.rootDir, "archive");
    await mkdir(archivePath);
    const statusPath = join(archivePath, "status");
    const patchPath = join(archivePath, "patch");
    const numstatPath = join(archivePath, "numstat");
    await Promise.all([writeFile(statusPath, ""), writeFile(patchPath, ""), writeFile(numstatPath, "")]);
    const mutationLocks = new LocalConsumedOutputLedgerMutationLock();
    const lease = await mutationLocks.acquire({
      ledgerRoots: [ledgerRoot],
      owner: "repair-test",
    });
    const writer = new LocalConsumedOutputLedgerWriter(
      undefined,
      fixture.rootDir,
    );
    const decision = {
      schemaVersion: 1 as const,
      jobId: "worker-locked",
      status: "failed_no_output" as const,
      closedAt: "2026-08-08T00:00:00.000Z",
      failure: { category: "infrastructure", code: "no_output" },
      output: { authoredChanges: false as const, workspaceDirty: false as const },
      note: "writer must share the repair lock domain",
      backup: {
        workspace: fixture.workspacePath,
        statusPath,
        patchPath,
        numstatPath,
      },
    };
    try {
      await expect(writer.record({ ledgerRoot, decision })).rejects.toThrow(
        "Workspace is already locked",
      );
    } finally {
      await mutationLocks.release(lease);
    }
    await expect(writer.record({ ledgerRoot, decision })).resolves.toMatchObject({
      idempotentReplay: false,
    });
  });

  it("rejects a ledger mutation-lock symlink before outside-root writes", async () => {
    const fixture = await createGitFixture();
    const ledgerRoot = join(fixture.rootDir, "ledger-lock-symlink-test");
    const outside = join(fixture.rootDir, "outside-lock-root");
    await Promise.all([mkdir(ledgerRoot), mkdir(outside)]);
    await symlink(outside, join(ledgerRoot, ".mutation-locks"), "dir");
    const mutationLocks = new LocalConsumedOutputLedgerMutationLock();
    await expect(mutationLocks.acquire({
      ledgerRoots: [ledgerRoot],
      owner: "repair-test",
    })).rejects.toThrow("consumed_output_ledger_lock_root_unsafe");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects an intermediate ledger symlink before creating nested roots", async () => {
    const fixture = await createGitFixture();
    const custodyRoot = join(fixture.rootDir, "ledger-custody");
    const outside = join(fixture.rootDir, "outside-ledger-root");
    await Promise.all([mkdir(custodyRoot), mkdir(outside)]);
    await symlink(outside, join(custodyRoot, "redirect"), "dir");
    const writer = new LocalConsumedOutputLedgerWriter(undefined, custodyRoot);
    await expect(writer.record({
      ledgerRoot: join(custodyRoot, "redirect", "nested-ledger"),
      decision: {
        schemaVersion: 1,
        jobId: "worker-symlink",
        status: "failed_no_output",
        closedAt: "2026-08-08T00:00:00.000Z",
        failure: { category: "infrastructure", code: "no_output" },
        output: { authoredChanges: false, workspaceDirty: false },
        note: "intermediate symlinks must fail closed",
        backup: {
          workspace: fixture.workspacePath,
          statusPath: "/archive/status",
        },
      },
    })).rejects.toThrow("consumed_output_ledger_lock_root_unsafe");
    expect(await readdir(outside)).toEqual([]);
  });

  it("preserves a rejected attempt when a later attempt integrates the same worker", async () => {
    const fixture = await createGitFixture();
    const writer = new LocalConsumedOutputLedgerWriter(
      undefined,
      fixture.rootDir,
    );
    const ledgerRoot = join(fixture.rootDir, "ledger");
    const archivePath = join(fixture.rootDir, "archive");
    const rejectedArchivePath = join(archivePath, "rejected");
    const integratedArchivePath = join(archivePath, "integrated");
    await Promise.all([
      mkdir(rejectedArchivePath, { recursive: true }),
      mkdir(integratedArchivePath, { recursive: true }),
    ]);
    const statusPath = join(archivePath, "status");
    const patchPath = join(archivePath, "patch");
    await Promise.all([writeFile(statusPath, ""), writeFile(patchPath, "")]);
    const backup = {
      workspace: fixture.workspacePath,
      statusPath,
      patchPath,
    };
    await writer.record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: "worker-1",
        attemptId: "rejected-attempt",
        status: "rejected",
        closedAt: "2026-07-12T00:00:00.000Z",
        archivePath: rejectedArchivePath,
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
      archivePath: integratedArchivePath,
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
