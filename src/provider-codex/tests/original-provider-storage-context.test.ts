import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  it("pins exact retained homes and refuses foreign paths, symlinks, permissions and replaced inodes", () => {
    const slot = mkdtempSync(join(scratch, "TEST-original-provider-storage-"));
    const workspace = join(slot, "workspace"), session = join(slot, "session");
    const home = join(session, "home"), codexHome = join(session, "codex-home");
    for (const path of [workspace, session, home, codexHome]) mkdirSync(path, { mode: 0o700 });
    try {
      const actual = { workspace, home, codexHome };
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
