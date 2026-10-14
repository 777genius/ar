import { link, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { codexProviderApiEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
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
    await expect(files.readFile("src/new.ts")).resolves.toBe("export {};\n");
    expect((await lstat(join(root, "src", "new.ts"))).nlink).toBe(1);
    await files.writeFile({ path: "src/new.ts", content: "overwritten\n", overwrite: true });
    expect((await lstat(join(root, "src", "new.ts"))).nlink).toBe(1);
    expect((await readdir(join(root, "src"))).sort()).toEqual(["math.ts", "new.ts"]);

    await expect(readFile(join(root, "src", "math.ts"), "utf8")).resolves.toBe(
      "return left + right;\n",
    );
    await expect(readFile(join(root, "src", "new.ts"), "utf8")).resolves.toBe(
      "overwritten\n",
    );
  });

  // These fail if an alias exposes bytes, matches edits, or is replaced.
  it.each(["read", "search", "edit", "overwrite"] as const)(
    "rejects a multiply linked alias during %s without exposing or replacing it",
    async (operation) => {
      const fixture = await hardlinkFixture();
      try {
        const before = await fixture.observe();
        expect(before.alias).toEqual(before.outside);
        expect(before.handle).toEqual(before.outside);
        expect(before.alias.nlink).toBe(2);
        expect((await lstat(fixture.root)).dev).toBe(before.outside.dev);
        const files = await BoundedWorkspaceFiles.create(fixture.root);
        const action = () => {
          switch (operation) {
            case "read": return files.readFile("alias.txt");
            case "search": return files.searchFiles({ query: fixture.sentinel.trim() });
            case "edit": return files.editFile({
              path: "alias.txt", oldText: fixture.sentinel, newText: "replacement",
            });
            case "overwrite": return files.writeFile({
              path: "alias.txt", content: "replacement", overwrite: true,
            });
          }
        };
        await expect(action()).rejects.toThrow("workspace_hardlink_rejected");
        expect(await fixture.observe()).toEqual(before);
        expect(await readdir(fixture.root)).toEqual(["alias.txt"]);
      } finally {
        await fixture.handle.close();
      }
    },
  );

  it("allows a remaining single link after the outside name is removed", async () => {
    const fixture = await hardlinkFixture();
    try {
      await rm(fixture.outside);
      expect((await lstat(join(fixture.root, "alias.txt"))).nlink).toBe(1);
      const files = await BoundedWorkspaceFiles.create(fixture.root);
      await expect(files.readFile("alias.txt")).resolves.toBe(fixture.sentinel);
      await files.writeFile({ path: "alias.txt", content: "normal", overwrite: true });
      await expect(files.readFile("alias.txt")).resolves.toBe("normal");
    } finally {
      await fixture.handle.close();
    }
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
    // Regression: a scoped MiMo search must not traverse an external path or
    // follow an in-workspace symlink to a global filesystem canary.
    await expect(files.searchFiles({ query: "outside", path: ".." }))
      .rejects.toThrow("workspace_path_outside_root");
    await expect(files.searchFiles({ query: "outside" })).resolves.toEqual([]);
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

  it("keeps hosted bounded tools on the named workspace read boundary", () => {
    const profile = buildCodexWorkspaceToolsProfile({
      workspaceRoot: "/tmp/disposable-workspace",
      allowedTools: [AgentRuntimeTool.ReadFile],
      hostedEgressPolicy: codexProviderApiEgressPolicy(),
    });
    expect(profile.configToml).toContain('default_permissions = "hosted-project-read"');
    expect(profile.configToml).toContain('[permissions.hosted-project-read.filesystem]');
    expect(profile.configToml).not.toContain('sandbox_mode = "read-only"');
    expect(profile.configToml).not.toContain("[sandbox_workspace_write]");
    expect(profile.configToml).toContain("shell_tool = false");
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-workspace-tools-"));
  roots.push(root);
  return root;
}

async function hardlinkFixture() {
  const parent = await workspace();
  const root = join(parent, "workspace");
  const sibling = join(parent, "synthetic-outside");
  await mkdir(root);
  await mkdir(sibling);
  const outside = join(sibling, "sentinel.txt");
  const alias = join(root, "alias.txt");
  const sentinel = "synthetic-nlink-sentinel\n";
  await writeFile(outside, sentinel);
  const handle = await open(outside, "r");
  try {
    await link(outside, alias);
  } catch (error) {
    await handle.close();
    throw error;
  }
  const observeName = async (path: string) => {
    const stat = await lstat(path);
    return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, content: await readFile(path, "utf8") };
  };
  return {
    root, outside, sentinel, handle,
    observe: async () => {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(Buffer.byteLength(sentinel));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        alias: await observeName(alias),
        outside: await observeName(outside),
        handle: {
          dev: stat.dev, ino: stat.ino, nlink: stat.nlink,
          content: buffer.subarray(0, bytesRead).toString("utf8"),
        },
      };
    },
  };
}
