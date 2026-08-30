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
