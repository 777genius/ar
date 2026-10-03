import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliTaskExecutionEngine } from "@vioxen/subscription-runtime/provider-claude";
import { FileBackendClaudeWorker } from "../index";
import { encryptionKey } from "./file-backend-claude-worker-test-support";

export async function ambientTestFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "pr168-TEST-worker-"));
  const homeDir = join(rootDir, "TEST-home");
  const launchPath = join(rootDir, "TEST-launch.json");
  const binaryPath = join(rootDir, "TEST-claude.cjs");
  await mkdir(homeDir);
  await writeFile(join(homeDir, "synthetic-session.json"), '{"testSession":true}\n');
  await writeFile(binaryPath, `#!${process.execPath}
const observed = {
  home: process.env.HOME ?? null,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  hasOauthToken: Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN"),
  hasApiKey: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
};
require("node:fs").writeFileSync(${JSON.stringify(launchPath)}, JSON.stringify(observed));
process.stdout.write(JSON.stringify(observed));
`);
  await chmod(binaryPath, 0o700);
  return {
    rootDir, homeDir, launchPath, binaryPath,
    worker: (extraEnv: Readonly<Record<string, string | undefined>> = {}) => {
      const baseEnv = {
        PATH: process.env.PATH,
        HOME: join(rootDir, "TEST-inherited-home"),
        CLAUDE_CONFIG_DIR: join(rootDir, "TEST-inherited-config"),
        CLAUDE_CODE_OAUTH_TOKEN: "TEST-inherited-token-never-use",
        ANTHROPIC_API_KEY: "TEST-inherited-api-key-never-use",
        ...extraEnv,
      };
      return new FileBackendClaudeWorker({
        providerInstanceId: "claude-TEST-ambient",
        stateRootDir: join(rootDir, "TEST-state"),
        encryptionKey: encryptionKey(),
        baseEnv,
        engine: new ClaudeCliTaskExecutionEngine({ claudePath: binaryPath, baseEnv }),
      });
    },
  };
}
