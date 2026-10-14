import { mkdtemp, mkdir, writeFile, readFile, symlink, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeTool } from "@vioxen/subscription-runtime/core";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { ChildContinuationMode, ChildExecutionBudget, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspaceToolsMcpServer } from "../workspace-tools-mcp";
import { BoundedWorkspaceFiles } from "../workspace-tools/bounded-workspace-files";
async function fixture(write = false) {
  const root = await mkdtemp(join(tmpdir(), "pr3-TEST-workspace-boundary-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await writeFile(join(workspace, "allowed.txt"), "initial");
  await writeFile(join(workspace, "AGENTS.md"), "private project instructions");
  await writeFile(join(root, "private.txt"), "synthetic private authority");
  await symlink(join(root, "private.txt"), join(workspace, "escape.txt"));
  let wall = 1000, monotonic = 0;
  const budget = new ChildExecutionBudget(parseChildLifetime({ schemaVersion: 1, accountId: "approved-s",
    deadlineEpochMs: 2000, maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: write ? AccessBoundary.IsolatedWorkspaceWrite : AccessBoundary.ReadOnly,
    allowedTools: write ? [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles, AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile] : [AgentRuntimeTool.ReadFile, AgentRuntimeTool.SearchFiles] }),
    { wall: () => wall, monotonic: () => monotonic });
  const files = await BoundedWorkspaceFiles.create(workspace, { childBudget: budget, denyProjectInstructions: true });
  return { root, workspace, files, budget, expire: () => { wall = 2000; monotonic = 1000; }, close: () => rm(root, { recursive: true, force: true }) };
}
describe("child workspace tools", () => {
  it.each([false, true])("MCP rejects normalized instruction reads and searches (writable=%s)", async writable => {
    const f = await fixture(writable);
    const paths = ["AGENTS.md", "nested/Agents.Override.md", "nested/sKiLl.Md", "CLAUDE.md", "GEMINI.md",
      ".cursorrules", "copilot-instructions.md", ".codex/instructions.md", ".claude/rules/review.md",
      ".cursor/rules/review.md", ".agents/skills/demo.md"];
    for (const path of paths) {
      await mkdir(join(f.workspace, path, ".."), { recursive: true });
      await writeFile(join(f.workspace, path), "private TEST instruction sentinel");
    }
    const lifetime = { ...f.budget.lifetime, deadlineEpochMs: Date.now() + 60_000 };
    const server = await createWorkspaceToolsMcpServer({ workspaceRoot: f.workspace, allowedTools: lifetime.allowedTools,
      denyProjectInstructions: true, childLifetime: lifetime });
    const client = new Client({ name: "pr3-TEST-instructions", version: "1" });
    try {
      const [left, right] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(left), client.connect(right)]);
      for (const path of paths) for (const alias of [path, `${path}/.`, `${path}//`, `./${path}`, `nested/../${path}`]) {
        const result = await client.callTool({ name: AgentRuntimeTool.ReadFile, arguments: { path: alias } });
        expect(result, alias).toMatchObject({ isError: true,
          content: [{ type: "text", text: "workspace_project_instruction_rejected" }] });
      }
      for (const path of [".codex/.", ".claude/rules/.", ".cursor/rules//", "nested/../.agents/skills/."]) {
        expect(await client.callTool({ name: AgentRuntimeTool.SearchFiles, arguments: { path, query: "private" } }))
          .toMatchObject({ isError: true, content: [{ type: "text", text: "workspace_project_instruction_rejected" }] });
      }
      expect(await client.callTool({ name: AgentRuntimeTool.SearchFiles, arguments: { path: "nested/..", query: "private" } }))
        .toMatchObject({ structuredContent: { matches: [] } });
      expect(await client.callTool({ name: AgentRuntimeTool.ReadFile, arguments: { path: "nested/../allowed.txt/." } }))
        .toMatchObject({ structuredContent: { content: "initial" } });
      expect(await client.callTool({ name: AgentRuntimeTool.ReadFile, arguments: { path: "../AGENTS.md/." } }))
        .toMatchObject({ isError: true, content: [{ type: "text", text: "workspace_path_outside_root" }] });
    } finally { await client.close(); await server.close(); await f.close(); }
  });

  it.each([AgentRuntimeTool.EditFile, AgentRuntimeTool.WriteFile])("MCP denies instruction mutation and matching oracles through %s", async tool => {
    const f = await fixture(true), lifetime = { ...f.budget.lifetime, deadlineEpochMs: Date.now() + 60_000 };
    const paths = ["AGENTS.md", "nested/Agents.Override.md", "nested/sKiLl.Md", ".codex/instructions.md",
      ".claude/rules/review.md", ".cursor/rules/review.md", ".agents/skills/demo.md"];
    for (const path of paths) {
      await mkdir(join(f.workspace, path, ".."), { recursive: true });
      await writeFile(join(f.workspace, path), "private project instructions");
    }
    const server = await createWorkspaceToolsMcpServer({ workspaceRoot: f.workspace, allowedTools: lifetime.allowedTools,
      denyProjectInstructions: true, childLifetime: lifetime });
    const client = new Client({ name: "pr3-TEST-mutations", version: "1" });
    try {
      const [left, right] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(left), client.connect(right)]);
      for (const target of paths) for (const path of [target, `${target}/.`, `${target}//`, `./${target}`]) {
        for (const oldText of ["private project instructions", "absent TEST text"]) {
          const args = tool === AgentRuntimeTool.EditFile ? { path, oldText, newText: "changed" }
            : { path, content: "changed", overwrite: true };
          expect(await client.callTool({ name: tool, arguments: args }), path)
            .toMatchObject({ isError: true, content: [{ type: "text", text: "workspace_project_instruction_rejected" }] });
          expect(await readFile(join(f.workspace, target), "utf8")).toBe("private project instructions");
        }
      }
      if (tool === AgentRuntimeTool.WriteFile) {
        expect(await client.callTool({ name: tool, arguments: { path: "SKILL.md/.", content: "new instruction" } }))
          .toMatchObject({ isError: true, content: [{ type: "text", text: "workspace_project_instruction_rejected" }] });
        await expect(stat(join(f.workspace, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      const args = tool === AgentRuntimeTool.EditFile ? { path: "allowed.txt/.", oldText: "initial", newText: "approved" }
        : { path: "allowed.txt/.", content: "approved", overwrite: true };
      expect((await client.callTool({ name: tool, arguments: args })).isError).not.toBe(true);
      expect(await readFile(join(f.workspace, "allowed.txt"), "utf8")).toBe("approved");
    } finally { await client.close(); await server.close(); await f.close(); }
  });
  // Bug: an approved tool escapes the workspace through traversal/symlink or loads denied project instructions.
  it("denies traversal, symlinks and project instructions while returning approved files", async () => {
    const f = await fixture();
    try {
      expect(await f.files.readFile("allowed.txt")).toBe("initial");
      for (const path of ["../private.txt", "escape.txt", "AGENTS.md"]) await expect(f.files.readFile(path)).rejects.toThrow();
      expect(await f.files.searchFiles({ query: "private" })).toEqual([]);
    } finally { await f.close(); }
  });
  // Bug: removing tool registration alone leaves an edit boundary bypass in the workspace adapter.
  it("denies writes through a readonly child binding", async () => {
    const f = await fixture();
    try {
      await expect(f.files.writeFile({ path: "late.txt", content: "denied" })).rejects.toThrow("child_workspace_tool_denied");
      await expect(f.files.editFile({ path: "allowed.txt", oldText: "initial", newText: "denied" })).rejects.toThrow("child_workspace_tool_denied");
      expect(await readFile(join(f.workspace, "allowed.txt"), "utf8")).toBe("initial");
    } finally { await f.close(); }
  });
  // Bug: dispatch registration exposes extra tools, or a live MCP server returns data after its deadline.
  it("dispatches only the exact approved subset and denies late MCP requests", async () => {
    const f = await fixture(), lifetime = { ...f.budget.lifetime, deadlineEpochMs: Date.now() + 60_000 };
    const server = await createWorkspaceToolsMcpServer({ workspaceRoot: f.workspace, allowedTools: lifetime.allowedTools,
      denyProjectInstructions: true, childLifetime: lifetime });
    const client = new Client({ name: "pr3-TEST", version: "1" });
    try {
      const [left, right] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(left), client.connect(right)]);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...lifetime.allowedTools].sort());
      expect((await client.callTool({ name: AgentRuntimeTool.ReadFile, arguments: { path: "allowed.txt" } })).isError).not.toBe(true);
      const clock = vi.spyOn(Date, "now").mockReturnValue(lifetime.deadlineEpochMs);
      try {
        const late = await client.callTool({ name: AgentRuntimeTool.ReadFile, arguments: { path: "allowed.txt" } });
        expect(late.isError).toBe(true); expect(late.content).toEqual([{ type: "text", text: "child_deadline_expired" }]);
      } finally { clock.mockRestore(); }
      await expect(createWorkspaceToolsMcpServer({ workspaceRoot: f.workspace, allowedTools: [AgentRuntimeTool.WriteFile],
        denyProjectInstructions: true, childLifetime: lifetime })).rejects.toThrow("child_workspace_tool_confinement_conflict");
    } finally { await client.close(); await server.close(); await f.close(); }
  });
  // Bug: a workspace MCP tool can mutate or return data after the immutable deadline.
  it("denies every operation after expiry and leaves filesystem bytes intact", async () => {
    const f = await fixture(true);
    try {
      f.expire();
      await expect(f.files.readFile("allowed.txt")).rejects.toThrow("child_deadline_expired");
      await expect(f.files.searchFiles({ query: "initial" })).rejects.toThrow("child_deadline_expired");
      await expect(f.files.editFile({ path: "allowed.txt", oldText: "initial", newText: "late" })).rejects.toThrow("child_deadline_expired");
      await expect(f.files.writeFile({ path: "late.txt", content: "late" })).rejects.toThrow("child_deadline_expired");
      await expect(stat(join(f.workspace, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(f.workspace, "allowed.txt"), "utf8")).toBe("initial");
    } finally { await f.close(); }
  });
});
