import { parseCodexGoalCliArgs, type CodexGoalCliIo } from "../codex-goal-cli";

function fakeIo(): CodexGoalCliIo {
  return {
    writeStdout(): void {},
    writeStderr(): void {},
    cwd: () => "/tmp",
    env: () => ({}),
  };
}

it("forwards control-list body, state and pagination options", () => {
    const controlList = parseCodexGoalCliArgs([
      "control-list",
      "job-a",
      "--include-bodies",
      "--state", "all",
      "--limit", "5",
      "--cursor", "test-cursor",
    ], fakeIo());
    expect(controlList).toMatchObject({
      kind: "mcp-tool",
      name: "codex_goal_control_list",
    });
    if (controlList.kind !== "mcp-tool") return;
    expect(JSON.parse(controlList.argsJson ?? "{}")).toEqual({
      jobId: "job-a",
      includeBodies: true,
      state: "all", limit: 5, cursor: "test-cursor",
    });

});

it.each(["--limit", "--cursor", "--state"])(
  "rejects missing values for %s in both control-list aliases",
  (option) => {
    for (const command of ["control-list", "inbox-list"]) {
      for (const tail of [[], ["--include-bodies"]]) {
        expect(() => parseCodexGoalCliArgs([
          command, "test-job", option, ...tail,
        ], fakeIo())).toThrow(`${option} requires a value`);
      }
    }
  },
);
