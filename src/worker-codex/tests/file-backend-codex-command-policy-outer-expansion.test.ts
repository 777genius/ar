import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  sessionArtifactFromCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { validAuthJson } from "../../provider-codex/tests/codex-provider-test-support";
import { codexAppServerCommandApprovalPolicy } from "../file-backend-codex-command-policy";
import {
  MemoryWorkerObservability,
  StaticRunner,
  isolatedWorkspaceCommandPolicy,
} from "./file-backend-codex-worker-test-support";

const outerDollar = '/bin/bash -c "printf \'%s\' \'$(git push)\'"';
const outerBacktick = '/bin/bash -c "printf \'%s\' \'`git push`\'"';
const deniedShellTexts = [
  outerDollar,
  outerBacktick,
  'bash -lc "printf \'%s\' \'$(git push)\'"',
  'sh -c "printf \'%s\' \'`git push`\'"',
  'zsh -lc "printf \'%s\' \'${TEST_VALUE}\'"',
  String.raw`/bin/bash -c "printf '%s' \$TEST_VALUE"`,
  '/bin/bash -c "printf \'%s\' \\`git push\\`"',
  String.raw`/bin/bash -c "printf '%s' \"\$(git push)\""`,
  '/bin/bash -c \'printf "%s" "$(git push)"\'',
  '/bin/bash -c \'printf "%s" "`git push`"\'',
  '/bin/bash -c "sh -c \'printf %s $(git push)\'"',
  '/bin/bash -c "printf \'%s\' \'$(git\npush)\'"',
  String.raw`/bin/bash -c "printf '%s' '\\$(git push)'"`,
] as const;

const literalShellTexts = [
  '/bin/bash -c "git status --short"',
  "/bin/bash -lc 'git status --short'",
  '/bin/bash -c "curl \'https://public.example.test/?q=one&lang=en\'"',
  '/bin/bash -c \'curl "https://public.example.test/?q=one&lang=en"\'',
  String.raw`/bin/bash -c "curl \"https://public.example.test/?q=one&lang=en\""`,
  String.raw`/bin/bash -c "printf '%s' '\$(git push)'"`,
  '/bin/bash -c "printf \'%s\' \'\\`git push\\`\'"',
  '/bin/bash -c "printf \'%s\' \'\\$TEST_VALUE\'"',
  '/bin/bash -c "sh -c \'git status --short\'"',
  "/bin/bash -c 'printf %s \\$TEST_VALUE'",
] as const;

const shellArgvControls = [
  ["printf '%s' '$(git push)'", true],
  ["printf '%s' '`git push`'", true],
  ['printf "%s" "$(git push)"', false],
  ['printf "%s" "`git push`"', false],
  ["curl 'https://public.example.test/?q=one&lang=en'", true],
] as const;

function approvalPolicy() {
  return codexAppServerCommandApprovalPolicy(
    isolatedWorkspaceCommandPolicy(), new MemoryWorkerObservability(), {},
  );
}

async function recordBash(commandText: string): Promise<string> {
  const cwd = await mkdtemp(join(process.cwd(), "TEST-pr207-recorder-"));
  try {
    // Empty executable search path; exported function covers both Bash layers.
    // No Git binary, credentials, provider, or user startup files are used.
    const recorded = await promisify(execFile)("/bin/bash", [
      "--noprofile", "--norc", "-c",
      `git() { printf 'RECORDED git'; printf ' %s' "$@"; printf '\\n'; }; export -f git; ${commandText}`,
    ], { cwd, env: { PATH: cwd }, timeout: 1_000 });
    expect(recorded.stderr).toBe("");
    return recorded.stdout;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("shell wrapper outer expansion approval", () => {
  it.each(deniedShellTexts)("denies expansion at either shell layer: %s", (commandText) => {
    const policy = approvalPolicy();
    for (const input of [
      { source: "command_execution" as const, commandText },
      { source: "legacy_exec" as const, command: ["/bin/bash", "-c", commandText] },
    ]) {
      expect(policy.reviewCommand(input)).toEqual({
        approved: false, reason: "script_interpreter_denied",
      });
    }
  });

  it.each(literalShellTexts)("preserves literal wrappers and escaped outer data: %s", (commandText) => {
    const policy = approvalPolicy();
    for (const input of [
      { source: "command_execution" as const, commandText },
      { source: "legacy_exec" as const, command: ["/bin/bash", "-lc", commandText] },
    ]) {
      expect(policy.reviewCommand(input)).toEqual({
        approved: true, reason: "command_policy_allowed",
      });
    }
  });

  it.each([outerDollar, outerBacktick])("records the actual outer substitution without a Git executable: %s", async (text) => {
    expect(await recordBash(text)).toBe("RECORDED git push");
  });

  it.each([
    [literalShellTexts[5], "$(git push)"],
    [literalShellTexts[6], "`git push`"],
  ])("records escaped outer substitution as literal inner data: %s", async (text, output) => {
    expect(await recordBash(text)).toBe(output);
  });

  it("records escaped outer backticks becoming active in the inner body", async () => {
    // Unquoted inner substitution splits the recorder's output into printf operands.
    expect(await recordBash(deniedShellTexts[6])).toBe("RECORDEDgitpush");
  });

  it.each(shellArgvControls)("reviews actual shell argv body without an invented outer layer: %s", (body, approved) => {
    expect(approvalPolicy().reviewCommand({
      source: "legacy_exec", command: ["/bin/bash", "-c", body],
    })).toEqual({
      approved, reason: approved ? "command_policy_allowed" : "script_interpreter_denied",
    });
  });

  it.each(isolatedWorkspaceCommandPolicy().deniedGitSubcommands)("keeps configured direct Git mutation denial: %s", (operation) => {
    expect(approvalPolicy().reviewCommand({
      source: "legacy_exec", command: ["git", operation],
    })).toEqual({ approved: false, reason: "denied_git_subcommand" });
  });

  it.each([
    ["printf", "%s", outerDollar],
    ["printf", "%s", outerBacktick],
    ["curl", "https://public.example.test/?q=one&lang=en"],
    ["git", "status", "--short"],
  ])("preserves direct literal argv: %s", (...command) => {
    expect(approvalPolicy().reviewCommand({ source: "legacy_exec", command }))
      .toEqual({ approved: true, reason: "command_policy_allowed" });
  });

  it.each([
    ["item/commandExecution/requestApproval", "decline", outerDollar],
    ["item/commandExecution/requestApproval", "decline", outerBacktick],
    ["execCommandApproval", "denied", outerDollar],
    ["execCommandApproval", "denied", outerBacktick],
  ] as const)("denies confirmed substitution through real engine route %s: %s %s", async (method, decision, text) => {
    const workspace = await mkdtemp(join(process.cwd(), "TEST-pr207-confirmed-"));
    try {
      await expectEngineDecision(
        method, method === "execCommandApproval" ? ["/bin/bash", "-c", text] : text,
        decision, workspace,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["item/commandExecution/requestApproval", "decline", "accept"],
    ["execCommandApproval", "denied", "approved"],
  ] as const)("enforces outer and inner expansion through real engine route %s", async (method, denied, approved) => {
    const workspace = await mkdtemp(join(process.cwd(), "TEST-pr207-approval-"));
    try {
      for (const [text, decision] of [
        ...deniedShellTexts.map(text => [text, denied] as const),
        ...literalShellTexts.map(text => [text, approved] as const),
      ]) {
        await expectEngineDecision(
          method, method === "execCommandApproval" ? ["/bin/bash", "-c", text] : text,
          decision, workspace,
        );
      }
      if (method === "execCommandApproval") {
        for (const [body, allowed] of shellArgvControls) {
          await expectEngineDecision(method, ["/bin/bash", "-c", body], allowed ? approved : denied, workspace);
        }
        for (const command of [
          ["printf", "%s", outerDollar], ["printf", "%s", outerBacktick],
          ["curl", "https://public.example.test/?q=one&lang=en"], ["git", "status", "--short"],
        ]) await expectEngineDecision(method, command, approved, workspace);
        await expectEngineDecision(method, ["git", "push"], denied, workspace);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function expectEngineDecision(
  method: "item/commandExecution/requestApproval" | "execCommandApproval",
  command: string | readonly string[],
  decision: "decline" | "accept" | "denied" | "approved",
  workspace: string,
): Promise<void> {
  const fakeFactory = new FakeAppServerFactory({
    emitServerRequestOnTurn: { id: 9207, method, params: { command, cwd: workspace } },
  });
  const sourceEnv = { TMPDIR: workspace };
  const driver = new CodexJsonAgentDriver({
    engine: new CodexAppServerExecutionEngine({
      codexBinaryPath: "/synthetic/codex-test", processFactory: fakeFactory.create,
      cleanThreadPrewarm: false, sourceEnv, commandApprovalPolicy: approvalPolicy(),
    }),
    sourceEnv, model: "gpt-6.1-sol", reasoningEffort: "high",
  });
  try {
    await driver.runTask({
      session: sessionArtifactFromCodexAuthJson(validAuthJson),
      task: { kind: "review", prompt: "synthetic outer expansion approval test" },
      workspace: { path: workspace },
      runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
      redactor: new DefaultRedactor(), abortSignal: new AbortController().signal,
    });
    expect(fakeFactory.requests).toContainEqual(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({ model: "gpt-6.1-sol", effort: "high", serviceTier: null }),
    }));
    expect(fakeFactory.responses, typeof command === "string" ? command : command.join(" "))
      .toContainEqual({ id: 9207, result: { decision } });
  } finally {
    await driver.dispose();
  }
}
