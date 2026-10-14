import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { captureOriginalProviderStorage, decodeOriginalProviderStorageContext } from "../app-server/adapters/original-provider-storage-context";
import { codexAppServerProcessInvocation, spawnCodexAppServerProcess } from "../app-server/adapters/node-app-server-process";
import { egressBoundCodexProcessFactory } from "../app-server/adapters/egress-bound-process";
import { codexProviderApiEgressPolicy, CodexProviderEgressProfileId, codexProviderEgressProfileEnvVar } from "../codex-provider-egress-policy";

const context = { workspace: "/scratch/workspace", home: "/scratch/session/home", codexHome: "/scratch/session/codex-home" };
it("preserves original sibling and nested homes while refusing extra writable roles and aliases", () => {
  expect(decodeOriginalProviderStorageContext(context)).toEqual(context);
  expect(decodeOriginalProviderStorageContext({ ...context, codexHome: context.home + "/.codex" }).codexHome).toBe(context.home + "/.codex");
  for (const bad of [{ ...context, paths: [] }, { ...context, codexHome: "/scratch/foreign/codex-home" },
    { ...context, workspace: "/scratch/session" }, { ...context, home: context.home + "\n" },
    { ...context, workspace: "/scratch/../workspace" }]) expect(() => decodeOriginalProviderStorageContext(bad)).toThrow();
});

it("admits only a disjoint established agent-temp leaf without changing legacy context", () => {
  const extended = { ...context, agentTemp: "/scratch/task/tmp/agent" };
  expect(decodeOriginalProviderStorageContext(extended)).toEqual(extended);
  expect(Object.keys(decodeOriginalProviderStorageContext(context)).sort()).toEqual(["codexHome", "home", "workspace"]);
  for (const agentTemp of ["/scratch/task/tmp", context.home + "/tmp/agent", context.workspace + "/tmp/agent",
    "/scratch/task/tmp/agent\n", "/scratch/task/../tmp/agent"]) {
    expect(() => decodeOriginalProviderStorageContext({ ...context, agentTemp })).toThrow();
  }
  expect(() => decodeOriginalProviderStorageContext({ ...extended, workspace: "/scratch/task" })).toThrow();
  expect(() => decodeOriginalProviderStorageContext({ ...context, agentTemp: undefined })).toThrow();
});

it("forwards fixed storage only on original managed baseline and keeps the launch frame legacy shaped", () => {
  const input = { command: "/codex", args: ["app-server"], cwd: context.home, storageContext: context,
    env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: "TEST-storage" }, platform: "linux" as const };
  const managed = codexAppServerProcessInvocation(input);
  expect(JSON.parse(managed.args[2]!).storageContext).toEqual(context);
  expect(JSON.parse(managed.stdinBootstrap!)).not.toHaveProperty("storageContext");
  expect(codexAppServerProcessInvocation({ ...input, platform: "darwin" })).toEqual({ command: input.command, args: input.args });
  const readonly = codexAppServerProcessInvocation(input, { jobId: "TEST-storage", workspacePath: context.workspace, readonlyPaths: [context.workspace + "/input"] });
  const mimo = codexAppServerProcessInvocation({ ...input, env: { ...input.env, [codexProviderEgressProfileEnvVar]: CodexProviderEgressProfileId.MimoTokenPlan } });
  for (const invocation of [readonly, mimo]) expect(JSON.parse(invocation.args[2]!)).not.toHaveProperty("storageContext");
  expect(egressBoundCodexProcessFactory(codexProviderApiEgressPolicy(), spawnCodexAppServerProcess).originalProviderStorageContext).toBe(true);
  expect(egressBoundCodexProcessFactory(codexProviderApiEgressPolicy(), () => { throw new Error("TEST-unused"); }).originalProviderStorageContext).toBeUndefined();
});

// Hosted focused checks select an actual admitted Scratch root. No stat/dev/UID
// projection is used; ordinary local machines only run the codec/transport cases.
const scratch = process.env.SR_PROVIDER_STORAGE_TEST_ROOT ?? "/srv/workers";
describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0 || !existsSync(scratch))("physical original provider storage boundary", () => {
  it("refuses a foreign bind mounted below the agent-temp leaf", () => {
    const slot = mkdtempSync(join(scratch, "TEST-original-provider-temp-mount-"));
    const helper = new URL("../app-server/adapters/original-provider-storage-context.ts", import.meta.url).href;
    try {
      const script = `
        import assert from 'node:assert/strict';
        import { mkdirSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import { captureOriginalProviderStorage } from ${JSON.stringify(helper)};
        const slot = ${JSON.stringify(slot)};
        const context = { workspace: slot+'/workspace', home: slot+'/session/home',
          codexHome: slot+'/session/codex-home', agentTemp: slot+'/tmp/agent' };
        for (const path of [context.workspace, context.home, context.codexHome, context.agentTemp,
          context.agentTemp+'/nested', slot+'/foreign']) mkdirSync(path, {recursive:true,mode:0o700});
        const capture = captureOriginalProviderStorage(${JSON.stringify(scratch)}, context);
        try {
          const mount = spawnSync('/usr/bin/mount', ['--bind',slot+'/foreign',context.agentTemp+'/nested']);
          assert.equal(mount.status,0);
          assert.throws(() => capture.revalidate(), /original_provider_storage_context_invalid/);
          assert.throws(() => captureOriginalProviderStorage(${JSON.stringify(scratch)},context), /original_provider_storage_context_invalid/);
        } finally { capture.close(); }
      `;
      const result = spawnSync("/usr/bin/unshare", ["--mount", "--propagation", "private", process.execPath,
        "--experimental-strip-types", "--input-type=module", "--eval", script], { timeout: 10_000, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(slot, { recursive: true, force: true }); }
  });

  it("pins exact retained homes and refuses foreign paths, symlinks, permissions and replaced inodes", () => {
    const slot = mkdtempSync(join(scratch, "TEST-original-provider-storage-"));
    const workspace = join(slot, "workspace"), session = join(slot, "session");
    const home = join(session, "home"), codexHome = join(session, "codex-home");
    const temp = join(slot, "tmp"), agentTemp = join(temp, "agent");
    for (const path of [workspace, session, home, codexHome, temp, agentTemp]) mkdirSync(path, { mode: 0o700 });
    try {
      const actual = { workspace, home, codexHome };
      const extended = { ...actual, agentTemp };
      const tempCapture = captureOriginalProviderStorage(scratch, extended);
      try {
        expect(tempCapture.witness.anchors.some(anchor => anchor.path === agentTemp)).toBe(true);
        chmodSync(agentTemp, 0o755);
        expect(() => tempCapture.revalidate()).toThrow();
        expect(() => captureOriginalProviderStorage(scratch, extended)).toThrow();
        chmodSync(agentTemp, 0o700);
        renameSync(agentTemp, agentTemp + "-retained"); mkdirSync(agentTemp, { mode: 0o700 });
        expect(() => tempCapture.revalidate()).toThrow();
      } finally { tempCapture.close(); }
      const capture = captureOriginalProviderStorage(scratch, actual);
      try {
        expect(capture.witness.context).toEqual(actual);
        capture.revalidate();
        expect(() => captureOriginalProviderStorage(scratch, { ...actual, workspace: "/etc" })).toThrow();
        const alias = join(slot, "alias"); symlinkSync(workspace, alias);
        expect(() => captureOriginalProviderStorage(scratch, { ...actual, workspace: alias })).toThrow();
        chmodSync(home, 0o755);
        expect(() => captureOriginalProviderStorage(scratch, actual)).toThrow();
        chmodSync(home, 0o700);
        renameSync(workspace, workspace + "-retained"); mkdirSync(workspace, { mode: 0o700 });
        expect(() => capture.revalidate()).toThrow();
      } finally { capture.close(); }
      const rootfs = mkdtempSync(join(tmpdir(), "TEST-original-provider-rootfs-"));
      try {
        if (lstatSync(rootfs).dev === lstatSync("/").dev) {
          expect(() => captureOriginalProviderStorage(rootfs, { workspace: rootfs + "/workspace", home: rootfs + "/session/home", codexHome: rootfs + "/session/codex-home" })).toThrow();
        }
      } finally { rmSync(rootfs, { recursive: true, force: true }); }
    } finally { rmSync(slot, { recursive: true, force: true }); }
  });
});
