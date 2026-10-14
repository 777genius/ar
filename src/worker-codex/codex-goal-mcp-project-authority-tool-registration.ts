import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  jobRegistryInputSchema,
  type ProjectControlMcpArgs,
} from "./codex-goal-mcp-inputs";
import {
  projectControlAdoptAuthorityTuple,
} from "./codex-goal-mcp-project-control-tool-handlers";
import { withMcpErrors } from "./codex-goal-mcp-response";

export function registerCodexGoalProjectAuthorityTools(
  server: McpServer,
  handler: typeof projectControlAdoptAuthorityTuple = projectControlAdoptAuthorityTuple,
): void {
  server.registerTool(
    "codex_goal_project_adopt_authority_tuple",
    {
      title: "Project Control Adopt Runtime Authority Tuple",
      description:
        "Atomically adopt the exact reviewed five-field Hosted Web Core runtime authority tuple from a persisted null phaseStart pre-state.",
      inputSchema: {
        ...jobRegistryInputSchema(),
        controllerJobId: z.string(),
        packetRevision: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        baseSha: z.string().regex(/^[a-f0-9]{40}$/),
        phaseStartSha: z.string().regex(/^[a-f0-9]{40}$/),
        inputPatchHash: z.string().regex(/^[a-f0-9]{64}$/),
        reviewReceipt: z.string().min(1).max(16_384),
        reviewReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        confirmAuthorityAdoption: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      handler(args as ProjectControlMcpArgs),
    ),
  );
}
