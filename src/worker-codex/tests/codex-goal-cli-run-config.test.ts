import { describe, expect, it } from "vitest";

import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { parseFlags } from "../codex-goal-cli-support";

describe("codex goal CLI run config", () => {
  it("defaults durable handoffs inside the resolved job root", () => {
    const config = runConfigFromFlags(
      parseFlags([
        "--accounts", "account-a",
        "--workspace", "/tmp/workspace",
        "--prompt", "/tmp/prompt.md",
      ]),
      {},
      "/tmp",
      "relative-job",
      "task-1",
    );

    expect(config.durableHandoffRootDir).toBe(
      "/tmp/relative-job/durable-handoffs",
    );
  });

  it("forwards the explicit durable handoff root", () => {
    const config = runConfigFromFlags(
      parseFlags([
        "--accounts",
        "account-a",
        "--durable-handoff-root",
        "/srv/subscription-runtime/handoffs",
        "--workspace",
        "/tmp/workspace",
        "--prompt",
        "/tmp/prompt.md",
      ]),
      {},
      "/tmp",
      "/tmp/job",
      "task-1",
    );

    expect(config.durableHandoffRootDir).toBe(
      "/srv/subscription-runtime/handoffs",
    );
  });
});
