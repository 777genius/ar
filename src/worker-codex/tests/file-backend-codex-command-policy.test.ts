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

const confirmedPrefixDiscard = 'git$IFS"push";/bin/bash -c \'git status --short\'';

function approvalPolicy() {
  return codexAppServerCommandApprovalPolicy(
    isolatedWorkspaceCommandPolicy(), new MemoryWorkerObservability(), {},
  );
}

describe("literal shell wrapper prefix approval", () => {
  it.each([
    confirmedPrefixDiscard,
    'git$IFS"push"&&/bin/bash -c \'git status --short\'',
    'git$IFS"push"|/bin/bash -c \'git status --short\'',
    'git$IFS"push"&/bin/bash -c \'git status --short\'',
    '${SHELL_DIR}/bash -c \'git status --short\'',
    '`printf /bin`/bash -c \'git status --short\'',
    '"/bin"/bash -c \'git status --short\'',
    '/b\\in/bash -c \'git status --short\'',
    '/space\\ dir/bash -c \'git status --short\'',
    '/bin/bash\n-c \'git status --short\'',
    '/bin/bash -c\ngit status --short',
    'git$IFS"push";/bin/sh -lc \'git status --short\'',
    'git$IFS"push";/usr/bin/zsh -c \'git status --short\'',
  ])("denies ambiguous prefix syntax before unwrapping: %s", (commandText) => {
    const policy = approvalPolicy();
    for (const input of [
      { source: "thread_shell_command" as const, commandText },
      { source: "legacy_exec" as const, command: ["/bin/bash", "-c", commandText] },
    ]) {
      expect(policy.reviewCommand(input)).toEqual({
        approved: false, reason: "script_interpreter_denied",
      });
    }
  });

  it("records the confirmed prefix push using only a synthetic Bash function", async () => {
    const cwd = await mkdtemp(join(process.cwd(), "TEST-pr144-recorder-"));
    try {
      const recorded = await promisify(execFile)("/bin/bash", [
        "--noprofile", "--norc", "-c",
        // Export the recorder so the nested read wrapper also avoids real Git.
        `git() { printf '%s\\n' "$@"; }; export -f git; ${confirmedPrefixDiscard}`,
      ], { cwd, env: {}, timeout: 1_000 });
      expect(recorded.stdout).toBe("push\nstatus\n--short\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["bash", "sh", "zsh", "/bin/bash", "/usr/bin/sh", "/usr/local/bin/zsh", "./bin/bash"])(
    "preserves literal executable/path wrappers: %s", (shell) => {
      const policy = approvalPolicy();
      for (const option of ["-c", "-lc"]) {
        for (const payload of ["'git status --short'", '"git status --short"', "pwd"]) {
          expect(policy.reviewCommand({
            source: "thread_shell_command", commandText: `${shell} ${option} ${payload}`,
          })).toEqual({ approved: true, reason: "command_policy_allowed" });
        }
        expect(policy.reviewCommand({
          source: "legacy_exec", command: [shell, option, "git status --short"],
        })).toEqual({ approved: true, reason: "command_policy_allowed" });
      }
    },
  );

  it("preserves direct literal vectors without treating argument data as syntax", () => {
    expect(approvalPolicy().reviewCommand({
      source: "legacy_exec", command: ["printf", "%s", confirmedPrefixDiscard],
    })).toEqual({ approved: true, reason: "command_policy_allowed" });
    expect(approvalPolicy().reviewCommand({
      source: "legacy_exec", command: ["git", "status", "--short"],
    })).toEqual({ approved: true, reason: "command_policy_allowed" });
    for (const shell of ["/literal space/bash", "/literal$directory/sh"]) {
      expect(approvalPolicy().reviewCommand({
        source: "legacy_exec", command: [shell, "-c", "git status --short"],
      })).toEqual({ approved: true, reason: "command_policy_allowed" });
    }
  });

  it.each([
    ["item/commandExecution/requestApproval", "decline", "accept"],
    ["execCommandApproval", "denied", "approved"],
  ])("enforces production policy through fake transport route %s", async (method, denied, approved) => {
    const workspace = await mkdtemp(join(process.cwd(), "TEST-pr144-approval-"));
    try {
      // Every denial and positive control travels through the real engine and
      // request handler. Only the transport is fake; no live provider is started.
      for (const [text, decision] of [
        [confirmedPrefixDiscard, denied],
        ["/bin/bash -c 'git status --short'", approved],
      ]) {
        const fakeFactory = new FakeAppServerFactory({
          emitServerRequestOnTurn: {
            id: 9101, method,
            params: {
              command: method === "execCommandApproval" ? ["/bin/bash", "-c", text] : text,
              cwd: workspace,
            },
          },
        });
        const sourceEnv = { TMPDIR: workspace };
        const driver = new CodexJsonAgentDriver({
          engine: new CodexAppServerExecutionEngine({
            codexBinaryPath: "/synthetic/codex-test",
            processFactory: fakeFactory.create,
            cleanThreadPrewarm: false,
            sourceEnv,
            commandApprovalPolicy: approvalPolicy(),
          }),
          sourceEnv,
          model: "gpt-test", reasoningEffort: "low",
        });
        try {
          await driver.runTask({
            session: sessionArtifactFromCodexAuthJson(validAuthJson),
            task: { kind: "review", prompt: "synthetic command approval test" },
            workspace: { path: workspace },
            runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }),
            redactor: new DefaultRedactor(),
            abortSignal: new AbortController().signal,
          });
          expect(fakeFactory.responses).toContainEqual({
            id: 9101, result: { decision },
          });
        } finally {
          await driver.dispose();
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
