import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexProviderApiAndNpmRegistryEgressProfileId,
  codexProviderApiEgressProfileId,
  codexProviderEgressProfileEnvVar,
} from "@vioxen/subscription-runtime/provider-codex";
import { FileBackendCodexWorker } from "../index";
import {
  FakeAppServerFactory,
  StaticRunner,
  validAuthJson,
} from "./file-backend-codex-worker-test-support";

const npmRegistryDomains =
  'domains = { "api.openai.com" = "allow", "registry.npmjs.org" = "allow" }';

describe("FileBackendCodexWorker egress", () => {
  it("keeps direct workers API-only despite an inherited registry profile", async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), "codex-direct-egress-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:direct-egress",
      stateRootDir,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(1),
      appServerProcessFactory: appServer.create,
      sourceEnv: {
        [codexProviderEgressProfileEnvVar]:
          codexProviderApiAndNpmRegistryEgressProfileId,
      },
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await worker.prewarm();
      expect(appServer.envs[0]?.[codexProviderEgressProfileEnvVar]).toBe(
        codexProviderApiEgressProfileId,
      );
      await expect(
        readFile(join(appServer.codexHomes[0]!, "config.toml"), "utf8"),
      ).resolves.not.toContain("registry.npmjs.org");
    } finally {
      await worker.dispose();
      await rm(stateRootDir, { recursive: true, force: true });
    }
  });

  it("uses the registry profile for packaged Codex exec", async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), "codex-packaged-egress-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-packaged-workspace-"));
    const runner = new StaticRunner({
      exitCode: 0,
      stdout: `${JSON.stringify({ type: "agent_message", message: "done" })}\n`,
      stderr: "",
    });
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:packaged-egress",
      stateRootDir,
      workspacePath,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(2),
      executionEngine: "packaged-exec",
      egressProfile: codexProviderApiAndNpmRegistryEgressProfileId,
      runner,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await worker.run({ prompt: "make a coding edit", controls: { editMode: "allow-edits" } });
      expect(runner.lastArgs).toContain(
        'features.network_proxy.domains={ "api.openai.com" = "allow", "registry.npmjs.org" = "allow" }',
      );
      expect(runner.lastEnv?.[codexProviderEgressProfileEnvVar]).toBe(
        codexProviderApiAndNpmRegistryEgressProfileId,
      );
    } finally {
      await worker.dispose();
      await rm(stateRootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("uses the registry profile for plain Codex exec", async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), "codex-plain-egress-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-plain-workspace-"));
    let configToml = "";
    const runner = new StaticRunner(
      { exitCode: 0, stdout: "done", stderr: "" },
      async (input) => {
        const codexHome = input.env.CODEX_HOME;
        if (!codexHome) throw new Error("missing_codex_home");
        configToml = await readFile(join(codexHome, "config.toml"), "utf8");
      },
    );
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:plain-egress",
      stateRootDir,
      workspacePath,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(3),
      executionEngine: "plain-exec",
      egressProfile: codexProviderApiAndNpmRegistryEgressProfileId,
      runner,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await worker.run({ prompt: "make a coding edit", controls: { editMode: "allow-edits" } });
      expect(runner.lastEnv?.[codexProviderEgressProfileEnvVar]).toBe(
        codexProviderApiAndNpmRegistryEgressProfileId,
      );
      expect(configToml).toContain(npmRegistryDomains);
      expect(configToml).not.toContain('"*"');
    } finally {
      await worker.dispose();
      await rm(stateRootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("uses the registry profile for app-server sessions", async () => {
    const stateRootDir = await mkdtemp(join(tmpdir(), "codex-app-server-egress-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-app-server-workspace-"));
    const appServer = new FakeAppServerFactory();
    const worker = new FileBackendCodexWorker({
      providerInstanceId: "codex:app-server-egress",
      stateRootDir,
      workspacePath,
      codexBinaryPath: "codex",
      encryptionKey: new Uint8Array(32).fill(4),
      egressProfile: codexProviderApiAndNpmRegistryEgressProfileId,
      appServerProcessFactory: appServer.create,
    });

    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      await worker.prewarm();
      expect(appServer.envs[0]?.[codexProviderEgressProfileEnvVar]).toBe(
        codexProviderApiAndNpmRegistryEgressProfileId,
      );
      await expect(
        readFile(join(appServer.codexHomes[0]!, "config.toml"), "utf8"),
      ).resolves.toContain(npmRegistryDomains);
    } finally {
      await worker.dispose();
      await rm(stateRootDir, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
