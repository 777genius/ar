import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { createWorkspaceToolsMcpServer } from "../workspace-tools-mcp";
import { BoundedWorkspaceFiles } from "../workspace-tools/bounded-workspace-files";
import { buildCodexWorkspaceToolsProfile } from "../workspace-tools/codex-workspace-tools-profile";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("bounded Codex workspace tools", () => {
  it("reads, searches, edits, and writes UTF-8 files without a shell", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "math.ts"), "return left - right;\n");
    const files = await BoundedWorkspaceFiles.create(root);

    await expect(files.readFile("src/math.ts")).resolves.toBe(
      "return left - right;\n",
    );
    await expect(files.searchFiles({ query: "left - right" })).resolves.toEqual([
      {
        path: join("src", "math.ts"),
        line: 1,
        column: 8,
        preview: "return left - right;",
      },
    ]);
    await expect(files.editFile({
      path: "src/math.ts",
      oldText: "left - right",
      newText: "left + right",
    })).resolves.toEqual({ replacements: 1 });
    await files.writeFile({ path: "src/new.ts", content: "export {};\n" });

    await expect(readFile(join(root, "src", "math.ts"), "utf8")).resolves.toBe(
      "return left + right;\n",
    );
    await expect(readFile(join(root, "src", "new.ts"), "utf8")).resolves.toBe(
      "export {};\n",
    );
  });

  it("rejects traversal, git metadata, symlinks, binary files, and ambiguous edits", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, ".GIT"));
    await writeFile(join(root, ".GIT", "config"), "upper-secret\n");
    await writeFile(join(root, "repeat.txt"), "same same\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(join(outside, "outside.txt"), "outside\n");
    await symlink(join(outside, "outside.txt"), join(root, "escape.txt"));
    const files = await BoundedWorkspaceFiles.create(root);

    await expect(files.readFile("../outside.txt")).rejects.toThrow(
      "workspace_path_outside_root",
    );
    await expect(files.readFile(".git/config")).rejects.toThrow(
      "workspace_git_metadata_rejected",
    );
    await expect(files.searchFiles({ query: "upper-secret" })).resolves.toEqual([]);
    await expect(files.readFile("escape.txt")).rejects.toThrow(
      "workspace_symlink_rejected",
    );
    await expect(files.readFile("binary.bin")).rejects.toThrow(
      "workspace_binary_file_rejected",
    );
    await expect(files.editFile({
      path: "repeat.txt",
      oldText: "same",
      newText: "changed",
    })).rejects.toThrow("workspace_edit_old_text_must_match_once");
  });

  it("denies project instructions before bounded review reads or searches", async () => {
    const root = await workspace();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".claude", "rules"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "instruction-secret\n");
    await writeFile(join(root, "nested", "Agents.Override.md"), "nested-secret\n");
    await writeFile(join(root, "nested", "sKiLl.Md"), "skill-secret\n");
    await writeFile(join(root, ".claude", "rules", "review.md"), "rule-secret\n");
    await writeFile(join(root, "AGENTS.md.example"), "benign-secret\n");
    await symlink(join(root, "AGENTS.md"), join(root, "instruction-link.md"));
    const files = await BoundedWorkspaceFiles.create(root, {
      denyProjectInstructions: true,
    });

    await expect(files.readFile("AGENTS.md")).rejects.toThrow(
      "workspace_project_instruction_rejected",
    );
    await expect(files.readFile("nested/../AGENTS.md")).rejects.toThrow(
      "workspace_project_instruction_rejected",
    );
    await expect(files.readFile("nested/sKiLl.Md")).rejects.toThrow(
      "workspace_project_instruction_rejected",
    );
    await expect(files.readFile("nested/Agents.Override.md")).rejects.toThrow(
      "workspace_project_instruction_rejected",
    );
    await expect(files.searchFiles({
      path: ".claude/rules",
      query: "rule-secret",
    })).rejects.toThrow("workspace_project_instruction_rejected");
    await expect(files.searchFiles({ query: "instruction-secret" })).resolves
      .toEqual([]);
    await expect(files.searchFiles({ query: "skill-secret" })).resolves
      .toEqual([]);
    await expect(files.readFile("instruction-link.md")).rejects.toThrow(
      "workspace_symlink_rejected",
    );
    await expect(files.readFile("AGENTS.md.example")).resolves.toBe(
      "benign-secret\n",
    );
  });

  it("serializes concurrent edits so stale text cannot overwrite a newer edit", async () => {
    const root = await workspace();
    await writeFile(join(root, "value.txt"), "before\n");
    const files = await BoundedWorkspaceFiles.create(root);

    const results = await Promise.allSettled([
      files.editFile({ path: "value.txt", oldText: "before", newText: "first" }),
      files.editFile({ path: "value.txt", oldText: "before", newText: "second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(readFile(join(root, "value.txt"), "utf8")).resolves.toMatch(
      /^(first|second)\n$/,
    );
  });

  it("never overwrites a file unless overwrite is explicit", async () => {
    const root = await workspace();
    await writeFile(join(root, "existing.txt"), "original\n");
    const files = await BoundedWorkspaceFiles.create(root);

    await expect(files.writeFile({
      path: "existing.txt",
      content: "replacement\n",
    })).rejects.toThrow("workspace_file_already_exists");
    await expect(readFile(join(root, "existing.txt"), "utf8")).resolves.toBe(
      "original\n",
    );
  });

  it("exposes only the tools selected by the existing AgentRuntimeTool policy", async () => {
    const root = await workspace();
    await writeFile(join(root, "file.txt"), "hello\n");
    const server = await createWorkspaceToolsMcpServer({
      workspaceRoot: root,
      allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
    });
    const client = new Client({ name: "workspace-tools-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        AgentRuntimeTool.ReadFile,
        AgentRuntimeTool.SearchFiles,
      ]);
      const result = await client.callTool({
        name: AgentRuntimeTool.ReadFile,
        arguments: { path: "file.txt" },
      });
      expect(JSON.stringify(result)).toContain("hello");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("builds a generic no-native-tools Codex profile from the selected tools", () => {
    const profile = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/disposable-workspace",
      allowedTools: [AgentRuntimeTool.EditFile, AgentRuntimeTool.ReadFile],
    });

    expect(profile.configToml).toContain("shell_tool = false");
    expect(profile.configToml).toContain("unified_exec = false");
    expect(profile.configToml).toContain('web_search = "disabled"');
    expect(profile.configToml).toContain(
      'enabled_tools = ["edit_file", "read_file"]',
    );
    expect(profile.configToml).toContain(
      '[projects."/tmp/disposable-workspace"]',
    );
    expect(profile.configToml).toContain('trust_level = "untrusted"');
    expect(profile.configToml).not.toContain("fix");
    expect(profile.developerInstructions).toContain(
      "agent_runtime_workspace MCP tools",
    );
    expect(() => buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/disposable-workspace",
      allowedTools: [AgentRuntimeTool.Shell],
    })).toThrow("workspace_tool_unsupported:shell");
  });

  it("disables native project docs for instruction-isolated profiles", () => {
    const profile = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/disposable-workspace",
      allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles],
      denyProjectInstructions: true,
    });

    expect(profile.configToml).toContain("project_doc_max_bytes = 0");
    expect(profile.configToml).toContain('"--deny-project-instructions"');
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-workspace-tools-"));
  roots.push(root);
  return root;
}
