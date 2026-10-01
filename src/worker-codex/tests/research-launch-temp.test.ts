import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { parseFlags } from "../codex-goal-cli-support";
import { ensureCodexAgentTempRoot } from "../../provider-codex/codex-runtime-temp";
import { codexAgentTempRootFromEnv, codexAppServerSandboxPolicy, codexAppServerThreadRuntimePolicy } from "../../provider-codex/app-server/domain/app-server-types";
import { trustedResearchRuntimeLaunch } from "../trusted-custody-systemd-launch";
import { researchName } from "../research-launch-files";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("research uses the actual fixed CLI agent temp contract (isolated files, no Host mounts)", () => {
  it.each([false, true])("creates the agent leaf and selects its actual writable root (sandboxTraverse=%s)", async sandboxTraverse => {
    root = await mkdtemp(join(tmpdir(), "TEST-research-temp-r9-"));
    const jobRootDir = join(root, "job"), workspacePath = join(jobRootDir, "workspace"), authRootDir = join(root, "auth");
    await mkdir(workspacePath, { recursive: true, mode: 0o700 }); await mkdir(authRootDir, { mode: 0o700 });
    const request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: "TEST-temp-r9", taskId: "TEST-temp-r9", jobRootDir, workspacePath,
      promptPath: join(jobRootDir, "prompt.md"), authRootDir, accounts: ["TEST-a"], codexBinaryPath: process.execPath,
      model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default", taskTimeoutMs: 1000 });
    const config = researchRunConfig(request), runtimeTemp = join(jobRootDir, "tmp"), agentTemp = join(runtimeTemp, "agent");
    const cli = runConfigFromFlags(parseFlags(["--accounts", "TEST-a", "--workspace", workspacePath, "--prompt", request.promptPath,
      "--auth-root", authRootDir]), {}, root, jobRootDir, request.taskId);
    for (const key of ["SUBSCRIPTION_RUNTIME_JOB_ROOT", "SUBSCRIPTION_RUNTIME_TMPDIR", "TMPDIR", "TMP", "TEMP"]) {
      expect(config.sourceEnv![key]).toBe(cli.sourceEnv![key]);
    }
    expect(config.sourceEnv).toEqual({ PATH: "/usr/bin:/bin", HOME: join(jobRootDir, "home"),
      SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRootDir, SUBSCRIPTION_RUNTIME_TMPDIR: runtimeTemp,
      TMPDIR: agentTemp, TMP: agentTemp, TEMP: agentTemp, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" });
    expect(codexAgentTempRootFromEnv(config.sourceEnv)).toBe(agentTemp);
    expect(await ensureCodexAgentTempRoot({ sourceEnv: config.sourceEnv, sandboxTraverse })).toBe(agentTemp);
    for (const path of [jobRootDir, runtimeTemp, agentTemp]) expect((await lstat(path)).mode & 0o777).toBe(sandboxTraverse ? 0o701 : 0o700);
    expect(codexAppServerSandboxPolicy({ workspacePath, sourceEnv: config.sourceEnv!, sandboxMode: "workspace-write" })).toMatchObject({
      writableRoots: [workspacePath, agentTemp], excludeSlashTmp: true, excludeTmpdirEnvVar: false,
    });
    expect(codexAppServerThreadRuntimePolicy({ workspacePath, sourceEnv: config.sourceEnv!, sandboxMode: "workspace-write",
      allowExtraWritableRoots: false, baseDeveloperInstructions: null }).runtimeWorkspaceRoots).toEqual([workspacePath, agentTemp]);
    // Observe the actual runtime plan. Authenticated provider selected binds
    // are checked separately with prepared scratch Host facts.
    const startId = "12345678-1234-1234-1234-123456789abc";
    const spec = { schemaVersion: 1 as const, startId, request, runtimeDirectory: root, artifactSha256: "a".repeat(64),
      grantSha256: "b".repeat(64), requestSha256: "c".repeat(64), nodeSha256: "d".repeat(64), codexSha256: "e".repeat(64),
      unit: `subscription-runtime-research-${startId}.service`, jobDirectory: { path: jobRootDir, device: 1, inode: 1 },
      workspaceDirectory: { path: workspacePath, device: 1, inode: 2 } };
    const runtime = trustedResearchRuntimeLaunch(spec, "f".repeat(64));
    expect(runtime.args).toContain(`--property=BindPaths=/run/user/subscription-runtime-research-v1/${researchName(request.jobId)}/starts/${startId}/pins/job:${jobRootDir}:norbind`);
    // Old config used TMPDIR=jobRoot/tmp and omitted both markers: both helpers
    // returned null and the real thread sandbox selected only workspace.
    const oldEnv = { PATH: "/usr/bin:/bin", TMPDIR: runtimeTemp };
    expect(await ensureCodexAgentTempRoot({ sourceEnv: oldEnv })).toBeNull();
    expect(codexAppServerSandboxPolicy({ workspacePath, sourceEnv: oldEnv, sandboxMode: "workspace-write" })).toMatchObject({ writableRoots: [workspacePath] });
  });
});
