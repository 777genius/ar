#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AgentRuntimeTool,
  type AgentRuntimeToolName,
} from "@vioxen/subscription-runtime/core";
import { BoundedWorkspaceFiles } from "./workspace-tools/bounded-workspace-files";
import { normalizeBoundedWorkspaceTools } from "./workspace-tools/bounded-workspace-tool-policy";
import { subscriptionRuntimePackageVersion } from
  "./subscription-runtime-package-version";

export type WorkspaceToolsMcpServerOptions = {
  readonly workspaceRoot: string;
  readonly allowedTools: readonly AgentRuntimeToolName[];
  readonly denyProjectInstructions?: boolean;
};

export async function createWorkspaceToolsMcpServer(
  options: WorkspaceToolsMcpServerOptions,
): Promise<McpServer> {
  const allowedTools = new Set(normalizeBoundedWorkspaceTools(options.allowedTools));
  const workspace = await BoundedWorkspaceFiles.create(options.workspaceRoot, {
    denyProjectInstructions: options.denyProjectInstructions ?? false,
  });
  const server = new McpServer({
    name: "agent-runtime-workspace-tools",
    version: subscriptionRuntimePackageVersion,
  });

  if (allowedTools.has(AgentRuntimeTool.ReadFile)) {
    server.registerTool(
      AgentRuntimeTool.ReadFile,
      {
        title: "Read Workspace File",
        description: "Read one UTF-8 text file inside the bounded workspace.",
        inputSchema: { path: z.string().min(1) },
      },
      (args) => mcpResult(async () => ({
        path: args.path,
        content: await workspace.readFile(args.path),
      })),
    );
  }

  if (allowedTools.has(AgentRuntimeTool.SearchFiles)) {
    server.registerTool(
      AgentRuntimeTool.SearchFiles,
      {
        title: "Search Workspace Files",
        description:
          "Search UTF-8 workspace files for a literal string without executing commands.",
        inputSchema: {
          query: z.string().min(1).max(512),
          path: z.string().min(1).optional(),
          maxResults: z.number().int().positive().max(100).optional(),
        },
      },
      (args) => mcpResult(async () => ({
        matches: await workspace.searchFiles({
          query: args.query,
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.maxResults === undefined
            ? {}
            : { maxResults: args.maxResults }),
        }),
      })),
    );
  }

  if (allowedTools.has(AgentRuntimeTool.EditFile)) {
    server.registerTool(
      AgentRuntimeTool.EditFile,
      {
        title: "Edit Workspace File",
        description:
          "Replace exact text in one existing UTF-8 workspace file without running commands.",
        inputSchema: {
          path: z.string().min(1),
          oldText: z.string().min(1),
          newText: z.string(),
          replaceAll: z.boolean().optional(),
        },
      },
      (args) => mcpResult(async () => ({
        path: args.path,
        ...(await workspace.editFile({
          path: args.path,
          oldText: args.oldText,
          newText: args.newText,
          ...(args.replaceAll === undefined
            ? {}
            : { replaceAll: args.replaceAll }),
        })),
      })),
    );
  }

  if (allowedTools.has(AgentRuntimeTool.WriteFile)) {
    server.registerTool(
      AgentRuntimeTool.WriteFile,
      {
        title: "Write Workspace File",
        description:
          "Create or explicitly overwrite one UTF-8 file inside the bounded workspace.",
        inputSchema: {
          path: z.string().min(1),
          content: z.string(),
          overwrite: z.boolean().optional(),
        },
      },
      (args) => mcpResult(async () => {
        await workspace.writeFile({
          path: args.path,
          content: args.content,
          ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        });
        return { path: args.path, written: true };
      }),
    );
  }

  return server;
}

async function mcpResult(
  action: () => Promise<Readonly<Record<string, unknown>>>,
) {
  try {
    const value = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: safeWorkspaceToolError(error),
      }],
    };
  }
}

function safeWorkspaceToolError(error: unknown): string {
  if (!(error instanceof Error)) return "workspace_tool_failed";
  return /^[a-z0-9_:]+$/.test(error.message)
    ? error.message
    : "workspace_tool_failed";
}

function parseCliArgs(argv: readonly string[]): WorkspaceToolsMcpServerOptions {
  let workspaceRoot: string | undefined;
  let allowedTools: readonly AgentRuntimeToolName[] | undefined;
  let denyProjectInstructions = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--workspace-root" && value) {
      workspaceRoot = value;
      index += 1;
    } else if (arg === "--allow" && value !== undefined) {
      allowedTools = value === ""
        ? []
        : value.split(",") as AgentRuntimeToolName[];
      index += 1;
    } else if (arg === "--deny-project-instructions") {
      denyProjectInstructions = true;
    } else {
      throw new Error(`workspace_tools_cli_argument_invalid:${arg ?? "missing"}`);
    }
  }
  if (!workspaceRoot) throw new Error("workspace_tools_cli_root_required");
  if (!allowedTools) throw new Error("workspace_tools_cli_allow_required");
  return { workspaceRoot, allowedTools, denyProjectInstructions };
}

if (await isMainModule()) {
  try {
    const server = await createWorkspaceToolsMcpServer(
      parseCliArgs(process.argv.slice(2)),
    );
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`${safeWorkspaceToolError(error)}\n`);
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
