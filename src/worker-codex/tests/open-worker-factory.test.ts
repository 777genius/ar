import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { CodexJsonAgentDriver, codexJsonHomeConfigToml, codexMimoApiKeyEnvVarDefault, CodexModelBackend,
  codexProviderApiEgressPolicy, hostedCodexExecutableReadPath, hostedCodexPermissionProfilesToml,
  hostedCodexResolverReadPaths, sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { StaticRunner, validAuthJson } from "../../provider-codex/tests/codex-provider-test-support";
import { NullWorkerObservability } from "../../worker-local/observability";
import { createFileBackendCodexWorkerRuntime, openWorkerFactorySecretRoots } from "../file-backend-codex-runtime-factory";
import type { FileBackendCodexWorkerOptions } from "../file-backend-codex-worker";

vi.mock("../../provider-codex/app-server/adapters/hosted-host-policy", async original => {
  const real = await original<typeof import("../../provider-codex/app-server/adapters/hosted-host-policy")>();
  return { ...real, readHostedActivationMode: () => real.HostedActivationMode.Disabled, hasHostedActivationOrigin: () => false };
});
// Synthetic Linux/root baseline only; no real host admission or mounts inspected.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, readFileSync: ((path: unknown, ...args: unknown[]) => path === "/proc/self/cgroup"
    ? "0::/\n" : Reflect.apply(real.readFileSync, real, [path, ...args])) as typeof real.readFileSync,
    lstatSync: ((path: unknown, ...args: unknown[]) => {
      if (typeof path === "string" && path.startsWith("/etc/subscription-runtime/")) throw Object.assign(new Error("TEST policy absent"), { code: "ENOENT" });
      const stat = Reflect.apply(real.lstatSync, real, [path === "/etc/resolv.conf" ? "/etc/hosts" : path, ...args]);
      return typeof path === "string" && path.includes("open-factory-")
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 }) : stat;
    }) as typeof real.lstatSync };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<FileBackendCodexWorkerOptions> {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "getuid").mockReturnValue(0);
  const root = await mkdtemp(join(tmpdir(), "open-factory-")); roots.push(root);
  const workspacePath = join(root, "workspace"), toolRoot = `${workspacePath}.tool`;
  for (const path of [workspacePath, toolRoot, `${toolRoot}/home`, `${toolRoot}/tmp`, `${toolRoot}/git`]) await mkdir(path, { mode: 0o700 });
  return { providerInstanceId: "TEST-account", stateRootDir: join(root, "state"), workspacePath,
    codexBinaryPath: "/synthetic/never-executed", encryptionKey: new Uint8Array(32),
    executionEngine: "app-server-goal", modelBackend: CodexModelBackend.OpenAiChatGpt, warmupPrompt: false,
    enforceProjectReadBoundary: true, sourceEnv: { PATH: "/usr/bin:/bin" },
    openWorker: { toolRoot, commitAllowed: true, secretRoots: [join(root, "auth")], deniedRoots: [] } };
}
function runtime(options: FileBackendCodexWorkerOptions) {
  return createFileBackendCodexWorkerRuntime({ options, workerId: "TEST-worker", redactor: new DefaultRedactor(),
    observability: new NullWorkerObservability(), clock: { now: () => new Date(), monotonicMs: () => performance.now() } });
}
it("materializes the open profile and tool-only environment, retaining exact strict config without open", async () => {
  const options = await fixture(), fake = new FakeAppServerFactory();
  for (const open of [true, false]) {
    const launches: Parameters<typeof fake.create>[0][] = [];
    const { openWorker, ...strictOptions } = options;
    const parts = runtime({ ...strictOptions, ...(open ? { openWorker: openWorker! } : {}),
      appServerProcessFactory: input => { launches.push(input); return fake.create(input); } });
    const driver = parts.agentDriver as CodexJsonAgentDriver;
    try {
      await driver.prewarmSession({ session: sessionArtifactFromCodexAuthJson(validAuthJson), redactor: new DefaultRedactor(),
        workspacePath: options.workspacePath!, runner: new StaticRunner("") });
      const config = await readFile(join(launches[0]!.env!.CODEX_HOME!, "config.toml"), "utf8");
      if (open) {
        expect(config).toContain('"/srv/workers/jobs" = "read"');
        expect(config).toContain('"/opt/nodejs" = "read"');
        expect(config).toContain(`${JSON.stringify(`${openWorker!.toolRoot}/git`)} = "write"`);
        expect(config).toContain(`GIT_DIR = ${JSON.stringify(`${openWorker!.toolRoot}/git`)}`);
        expect(config).toContain(`HOME = ${JSON.stringify(`${openWorker!.toolRoot}/home`)}`);
        expect(launches[0]!.env).not.toHaveProperty("GIT_DIR");
        expect(launches[0]!.env).not.toHaveProperty("GIT_WORK_TREE");
      } else {
        const providerEgressPolicy = codexProviderApiEgressPolicy();
        const expected = codexJsonHomeConfigToml({ providerEgressPolicy, namedPermissions: true,
          modelBackend: CodexModelBackend.OpenAiChatGpt, mimoApiKeyEnvVarName: codexMimoApiKeyEnvVarDefault }) + "\n" +
          hostedCodexPermissionProfilesToml(providerEgressPolicy, hostedCodexExecutableReadPath({
            codexBinaryPath: options.codexBinaryPath, sourceEnv: options.sourceEnv! }), undefined, undefined,
            hostedCodexResolverReadPaths(options.sourceEnv!, true));
        expect(config).toBe(expected);
      }
    } finally { await driver.dispose(); }
  }
});
it("rejects conflicting bounded tools and containment before launch", async () => {
  const options = await fixture();
  expect(() => runtime({ ...options, boundedWorkspaceTools: { allowedTools: [] } })).toThrow("hosted_open_worker_factory_conflict:bounded_workspace_tools");
  expect(() => runtime({ ...options, sourceEnv: { PATH: "/usr/bin", SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } })).toThrow("hosted_open_worker_factory_conflict:contained");
});

// Binding: derive the secret surface from the caller's options, then drive the factory guard.
it("binds every assembled open-worker secret root to the factory layout guard", async () => {
  const options = await fixture();
  const runtimeHomeRootDir = join(options.stateRootDir, "runtime");
  const input = { ...options, runtimeHomeRootDir };
  expect(openWorkerFactorySecretRoots(input)).toEqual([
    ...options.openWorker!.secretRoots, options.stateRootDir, runtimeHomeRootDir,
    join(runtimeHomeRootDir, "codex-session-cache"),
  ]);
  expect(openWorkerFactorySecretRoots(options)).toEqual([
    ...options.openWorker!.secretRoots, options.stateRootDir, options.stateRootDir,
    join(options.stateRootDir, "codex-session-cache"),
  ]);
  expect(() => runtime({ ...options,
    openWorker: { ...options.openWorker!, secretRoots: [options.workspacePath!] } }))
    .toThrow("hosted_open_worker_layout_invalid:write_root_secret_overlap");
  expect(() => runtime({ ...options, stateRootDir: options.workspacePath! }))
    .toThrow("hosted_open_worker_layout_invalid:write_root_secret_overlap");
  expect(() => runtime({ ...options, runtimeHomeRootDir: options.workspacePath! }))
    .toThrow("hosted_open_worker_layout_invalid:write_root_secret_overlap");
});
// Binding: PATH must include executable directories appended by the actual child environment builder.
it("rejects unsafe GitHub executable directories appended to the app-server child PATH", async () => {
  const options = await fixture();
  const executable = join(options.workspacePath!, "bin", "gh");
  await mkdir(join(options.workspacePath!, "bin"));
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const key of ["GH_PATH", "SUBSCRIPTION_RUNTIME_GH_PATH"]) {
    expect(() => runtime({ ...options, sourceEnv: {
      ...options.sourceEnv, [key]: executable,
    } })).toThrow("hosted_open_worker_layout_invalid:path_entry_unsafe");
  }
});
