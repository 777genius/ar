import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountAuthRootFromArgs,
} from "../application/codex-goal-accounts";

describe("Codex goal account roots", () => {
  it("uses the configured host auth root when no tool argument is provided", () => {
    expect(accountAuthRootFromArgs({}, {
      SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: "/var/data/codex-home/live-codex-auth",
    })).toBe("/var/data/codex-home/live-codex-auth");
  });

  it("keeps an explicit auth root above the environment default", () => {
    expect(accountAuthRootFromArgs({
      authRootDir: "./explicit-auth",
    }, {
      SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: "/var/data/codex-home/live-codex-auth",
    })).toBe(resolve(process.cwd(), "explicit-auth"));
  });

  it("keeps an explicitly selected pool above the environment default", () => {
    expect(accountAuthRootFromArgs({
      pool: "reviewers",
      poolRootDir: "/var/data/codex-pools",
    }, {
      SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT: "/var/data/codex-home/live-codex-auth",
    })).toBe(join("/var/data/codex-pools", "reviewers"));
  });
});
