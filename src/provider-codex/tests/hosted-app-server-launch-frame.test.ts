import { describe, expect, it } from "vitest";
import {
  decodeHostedAppServerLaunchFrame,
  encodeHostedAppServerLaunchFrame,
} from "../app-server/adapters/hosted-app-server-launch-frame";

describe("hosted app-server launch frame", () => {
  it("round-trips cwd, arguments, and secret-bearing environment off argv", () => {
    const frame = {
      schemaVersion: 1 as const,
      command: "/opt/codex/bin/codex",
      args: ["app-server", "line\nbreak"],
      cwd: "/var/data/work trees/task",
      env: { AUTH_TOKEN: "secret\nvalue", EMPTY: "" },
    };

    expect(
      decodeHostedAppServerLaunchFrame(
        encodeHostedAppServerLaunchFrame(frame).trimEnd(),
      ),
    ).toEqual(frame);
  });

  it("fails closed for malformed frames and environment keys", () => {
    expect(() => decodeHostedAppServerLaunchFrame("{}")).toThrow(
      "hosted_app_server_launch_frame_invalid",
    );
    expect(() =>
      decodeHostedAppServerLaunchFrame(
        JSON.stringify({
          schemaVersion: 1,
          command: "/bin/true",
          args: [],
          cwd: "/tmp",
          env: { "INVALID-KEY": "value" },
        }),
      ),
    ).toThrow("hosted_app_server_launch_frame_invalid");
  });
});

it("maps issued coding material into fixed guest paths and drops unrelated host environment", async () => {
  const { registerHostedMimoCodingBootstrap } = await import("../hosted-mimo-coding-bootstrap-registry");
  const { codexMimoApiKeyEnvVarDefault: key } = await import("../codex-model-backend");
  const bootstrap = { schemaVersion: 1 as const, startId: "12345678-1234-1234-1234-123456789abc", specSha256: "a".repeat(64), workspacePath: "/workspace", configToml: 'approval_policy = "never"\n' };
  const unregister = registerHostedMimoCodingBootstrap("TEST-capability", () => bootstrap);
  try {
    const frame = decodeHostedAppServerLaunchFrame(encodeHostedAppServerLaunchFrame({ schemaVersion: 1, command: "/codex", args: ["app-server"], cwd: "/host/home", env: { [key]: "TEST-capability", HOME: "/host/home", CODEX_HOME: "/host/config", HOST_SECRET: "TEST-shared-secret", PATH: "/usr/bin" } }));
    expect(frame.cwd).toBe("/workspace");
    expect(frame.env).toEqual({ [key]: "TEST-capability", PATH: "/usr/bin", HOME: "/home/coding", CODEX_HOME: "/home/coding/.codex", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" });
    expect(frame.coding).toEqual(bootstrap);
    expect(JSON.stringify(frame)).not.toContain("TEST-shared-secret");
    expect(() => encodeHostedAppServerLaunchFrame(frame)).toThrow("unissued");
    expect(() => decodeHostedAppServerLaunchFrame(JSON.stringify({ ...frame, cwd: "/escape" }))).toThrow("coding_frame_invalid");
  } finally { unregister(); }
});
it("requires external sealed root binding for coding bootstrap", async () => {
  const { decodeHostedMimoCodingExpectedBinding, assertHostedMimoCodingExpectedBinding } = await import("../hosted-mimo-coding-bootstrap");
  const expected = { schemaVersion: 1 as const, startId: "12345678-1234-1234-1234-123456789abc", specSha256: "a".repeat(64), workspacePath: "/workspace" };
  const decoded = decodeHostedMimoCodingExpectedBinding(Buffer.from(JSON.stringify(expected)).toString("base64url"));
  expect(decoded).toEqual(expected);
  expect(() => assertHostedMimoCodingExpectedBinding({ ...expected, configToml: "" }, decoded)).not.toThrow();
  for (const change of [{ startId: "12345678-1234-1234-1234-123456789abd" }, { specSha256: "b".repeat(64) }, { workspacePath: "/other" }]) {
    expect(() => assertHostedMimoCodingExpectedBinding({ ...expected, ...change, configToml: "" }, decoded)).toThrow("mismatch");
  }
  expect(() => decodeHostedMimoCodingExpectedBinding("a".repeat(8193))).toThrow();
  expect(() => decodeHostedMimoCodingExpectedBinding(Buffer.from(JSON.stringify({ ...expected, extra: true })).toString("base64url"))).toThrow();
});
