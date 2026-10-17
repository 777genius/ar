#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProviderRuntimeRegistry } from "./codex-goal-provider-runtime";
import {
  listCodexGoalJobs,
  readCodexGoalJob,
  resolveCodexGoalJobRegistryRoot,
  summarizeCodexGoalJob,
} from "./codex-goal-jobs";
import { registerCodexGoalPrompts } from "./codex-goal-mcp-prompts";
import { registerCodexGoalJobTools } from "./codex-goal-mcp-job-tools";
import { registerCodexGoalProjectControlTools } from "./codex-goal-mcp-project-control-tools";
import { registerCodexGoalRunEventTools } from "./codex-goal-mcp-run-event-tools";
import {
  registerCodexGoalWorkerControlTools,
  type CodexGoalWorkerControlToolOptions,
} from "./codex-goal-mcp-worker-control-tools";
import {
  registerCodexGoalInspectionTools,
  registerCodexGoalLaunchTools,
} from "./codex-goal-mcp-operation-tools";
import { registerCodexGoalAccountTools } from "./codex-goal-mcp-account-tools";
import { enterScratchPrivateMountNamespace } from "./scratch-mount-namespace";
import { subscriptionRuntimePackageVersion } from
  "./subscription-runtime-package-version";
export { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
export {
  projectControllerPendingGuidancePromptContext,
} from "./application/project-control/codex-goal-project-controller-guidance";
export {
  availableCodexGoalAccountSlots,
  dedupeCodexGoalAccountSlots,
  visibleCodexGoalAccountPoolSlots,
} from "./codex-goal-mcp-accounts";

export type CodexGoalMcpServerOptions = CodexGoalWorkerControlToolOptions & {
  readonly providerRuntimeRegistry?: ProviderRuntimeRegistry;
  readonly storageRootDir?: string;
  readonly registryRootDir?: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};

export function createCodexGoalMcpServer(
  options: CodexGoalMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "subscription-runtime-codex-goal",
    version: subscriptionRuntimePackageVersion,
  });

  const sourceEnv: Readonly<Record<string, string | undefined>> = Object.freeze({ ...(options.sourceEnv ?? process.env),
    ...(options.storageRootDir === undefined ? {} : { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: options.storageRootDir }),
    ...(options.registryRootDir === undefined ? {} : { SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT: options.registryRootDir }),
  });
  const storageDefaults = { sourceEnv };
  registerCodexGoalJobResource(server, {
    storageRootDir: options.storageRootDir ?? sourceEnv.SUBSCRIPTION_RUNTIME_STORAGE_ROOT,
    registryRootDir: options.registryRootDir ?? sourceEnv.SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT ?? sourceEnv.CODEX_GOAL_REGISTRY_ROOT,
    sourceEnv,
  });
  registerCodexGoalPrompts(server);
  registerCodexGoalJobTools(server, storageDefaults);
  registerCodexGoalRunEventTools(server, options, storageDefaults);
  registerCodexGoalWorkerControlTools(server, options, storageDefaults);
  registerCodexGoalAccountTools(server);
  registerCodexGoalLaunchTools(server, storageDefaults);
  registerCodexGoalProjectControlTools(server, options);
  registerCodexGoalInspectionTools(server, storageDefaults);

  return server;
}

function registerCodexGoalJobResource(server: McpServer, input: Parameters<typeof resolveCodexGoalJobRegistryRoot>[0]): void {
  server.registerResource(
    "codex-goal-job",
    new ResourceTemplate("codex-goal://jobs/{jobId}", {
      list: async () => {
        const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
        const jobs = await listCodexGoalJobs({ registryRootDir });
        return {
          resources: jobs.map((job) => ({
            uri: `codex-goal://jobs/${job.jobId}`,
            name: job.jobId,
            description: job.description ?? job.workspacePath,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Codex Goal Job",
      description: "A stored Codex goal job manifest.",
      mimeType: "application/json",
    },
    async (uri, { jobId }) => {
      const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: String(jobId),
        includeRetired: true,
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            manifest,
            summary: summarizeCodexGoalJob(manifest, registryRootDir),
          }, null, 2),
        }],
      };
    },
  );
}

if (await isMainModule()) {
  enterScratchPrivateMountNamespace();
  try {
    const server = createCodexGoalMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "codex goal mcp failed"}\n`,
    );
    process.exitCode = 1;
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(fileURLToPath(import.meta.url))) ===
      (await realpath(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}
