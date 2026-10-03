import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWorkerAccountCapacityStore } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { CodexGoalAccountSelectionMode } from "../codex-goal-jobs";
import { reserveCodexProjectAccount } from "../application/project-control/codex-goal-project-account-reservation";
import { fixture } from "./codex-goal-project-account-reservation.test";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("project account reservation - MiMo backend", () => {
  it("reserves only within one explicit MiMo account pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-mimo-reservation-"));
    roots.push(root);
    const base = fixture(root, "job-1");
    const scoped = {
      manifest: {
        ...base.manifest,
        accounts: ["mimo-a", "mimo-b"],
        mimoAccounts: [
          { name: "mimo-a", envVarName: "MIMO_PROJECT_KEY_A" },
          { name: "mimo-b", envVarName: "MIMO_PROJECT_KEY_B" },
        ],
        accountSelectionMode: CodexGoalAccountSelectionMode.Explicit,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      },
      launch: {
        ...base.launch,
        config: {
          ...base.launch.config,
          accounts: [
            { name: "mimo-a", envVarName: "MIMO_PROJECT_KEY_A" },
            { name: "mimo-b", envVarName: "MIMO_PROJECT_KEY_B" },
          ],
          mimoAccounts: [
            { name: "mimo-a", envVarName: "MIMO_PROJECT_KEY_A" },
            { name: "mimo-b", envVarName: "MIMO_PROJECT_KEY_B" },
          ],
          modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        },
      },
    };

    const reserved = await reserveCodexProjectAccount({
      ...scoped,
      deps: {
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseMode: "shared",
        now: new Date("2026-07-13T00:00:00.000Z"),
      },
    });

    expect(reserved.accountId).toBe("mimo-a");
    expect(reserved.launch.config.accounts).toEqual([
      { name: "mimo-a", envVarName: "MIMO_PROJECT_KEY_A" },
    ]);
    expect(reserved.launch.config.modelBackend).toBe(
      CodexModelBackend.XiaomiMimoTokenPlan,
    );
  });

  it.each([
    {
      name: "manifest and launch disagree",
      manifestBackend: CodexModelBackend.OpenAiChatGpt,
      launchBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    },
    {
      name: "a MiMo pool contains a ChatGPT auth.json credential",
      manifestBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      launchBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    },
    {
      name: "a ChatGPT pool contains MiMo credential metadata",
      manifestBackend: CodexModelBackend.OpenAiChatGpt,
      launchBackend: CodexModelBackend.OpenAiChatGpt,
    },
  ])("rejects $name before selecting an account", async ({
    manifestBackend,
    launchBackend,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "project-mixed-backend-"));
    roots.push(root);
    const base = fixture(root, "job-1");
    const scoped = {
      manifest: {
        ...base.manifest,
        modelBackend: manifestBackend,
        ...(launchBackend === CodexModelBackend.XiaomiMimoTokenPlan
          ? {
              mimoAccounts: [
                { name: "account-a" },
                { name: "account-b" },
              ],
            }
          : {}),
      },
      launch: {
        ...base.launch,
        config: {
          ...base.launch.config,
          modelBackend: launchBackend,
          accounts:
            launchBackend === CodexModelBackend.XiaomiMimoTokenPlan
              ? [
                  {
                    name: "account-a",
                    authJsonPath: "/forbidden/chatgpt/auth.json",
                  },
                  { name: "account-b" },
                ]
              : [
                  {
                    name: "account-a",
                    envVarName: "MIMO_FORBIDDEN_KEY",
                  },
                  { name: "account-b" },
                ],
          ...(launchBackend === CodexModelBackend.XiaomiMimoTokenPlan
            ? {
                mimoAccounts: [
                  { name: "account-a" },
                  { name: "account-b" },
                ],
              }
            : {}),
        },
      },
    };

    await expect(
      reserveCodexProjectAccount({
        ...scoped,
        deps: {
          capacityStore: new InMemoryWorkerAccountCapacityStore(),
          leaseMode: "shared",
        },
      }),
    ).rejects.toThrow("codex_goal_project_account_mixed_model_backend");
  });
});
