import { describe, expect, it } from "vitest";
import {
  codexAppServerProcessInvocation,
  signalHostedSystemdUnit,
} from "../app-server/adapters/node-app-server-process";

describe("hosted Codex app-server resource containment", () => {
  it("places hosted Linux app-server trees in the bounded worker slice", () => {
    expect(
      codexAppServerProcessInvocation({
        command: "/opt/codex/bin/codex",
        args: ["app-server", "--listen", "stdio://"],
        cwd: "/var/data/worktrees/task",
        env: {
          SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
          SECRET_TOKEN: "not-in-argv",
        },
        hostedLauncher: "/runtime/hosted-app-server-launcher.js",
        ioLimitPaths: ["/", "/mnt/data disk"],
        nodePath: "/usr/bin/node",
        platform: "linux",
        systemdUnit: "subscription-runtime-hosted-test.service",
      }),
    ).toEqual({
      command: "/usr/bin/systemd-run",
      systemdUnit: "subscription-runtime-hosted-test.service",
      stdinBootstrap:
        '{"schemaVersion":1,"command":"/opt/codex/bin/codex","args":["app-server","--listen","stdio://"],"cwd":"/var/data/worktrees/task","env":{"SUBSCRIPTION_RUNTIME_SANDBOX_KIND":"hosted-codex-job","SECRET_TOKEN":"not-in-argv"}}\n',
      args: [
        "--unit=subscription-runtime-hosted-test.service",
        "--pipe",
        "--wait",
        "--collect",
        "--quiet",
        "--service-type=exec",
        "--slice=subscription-runtime-hosted.slice",
        "--property=CPUQuota=200%",
        "--property=IOWeight=25",
        "--property=IOReadBandwidthMax=/ 40M",
        "--property=IOReadIOPSMax=/ 3000",
        "--property=IOWriteBandwidthMax=/ 20M",
        "--property=IOWriteIOPSMax=/ 1500",
        "--property=IOReadBandwidthMax=/mnt/data\\x20disk 40M",
        "--property=IOReadIOPSMax=/mnt/data\\x20disk 3000",
        "--property=IOWriteBandwidthMax=/mnt/data\\x20disk 20M",
        "--property=IOWriteIOPSMax=/mnt/data\\x20disk 1500",
        "--property=MemoryHigh=2G",
        "--property=MemoryMax=4G",
        "--property=TasksMax=512",
        "--property=RuntimeMaxSec=8h",
        "--property=TimeoutStopSec=30s",
        "--property=KillMode=control-group",
        "--property=NoNewPrivileges=yes",
        "--property=ProtectControlGroups=yes",
        "--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP",
        "--property=InaccessiblePaths=-/run/systemd/private -/run/dbus -/run/user",
        "--",
        "/usr/bin/unshare",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child=SIGKILL",
        "/usr/bin/setpriv",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "/usr/bin/node",
        "/runtime/hosted-app-server-launcher.js",
      ],
    });
  });

  it("does not add a host-specific wrapper outside marked hosted Linux jobs", () => {
    const ordinary = {
      command: "/opt/codex/bin/codex",
      args: ["app-server"],
    } as const;
    expect(
      codexAppServerProcessInvocation({
        ...ordinary,
        cwd: "/workspace",
        env: {},
        platform: "linux",
      }),
    ).toEqual(ordinary);
    expect(
      codexAppServerProcessInvocation({
        ...ordinary,
        cwd: "/workspace",
        env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
        platform: "darwin",
      }),
    ).toEqual(ordinary);
  });

  it("stops the service after signaling it instead of killing only its proxy", () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const results = [{ status: 1 }, { status: 0 }];
    const outcome = signalHostedSystemdUnit(
      "subscription-runtime-hosted-test.service",
      "SIGTERM",
      (args) => {
        mutableCalls.push([...args]);
        return results.shift() ?? { status: 1 };
      },
    );

    expect(outcome).toBe("stopping");
    expect(calls).toEqual([
      [
        "kill",
        "--signal=SIGTERM",
        "--kill-whom=all",
        "subscription-runtime-hosted-test.service",
      ],
      ["stop", "--no-block", "subscription-runtime-hosted-test.service"],
    ]);
  });

  it("keeps a failed-control service bounded instead of leaking it", () => {
    const inactiveCalls: string[][] = [];
    expect(
      signalHostedSystemdUnit(
        "subscription-runtime-hosted-test.service",
        "SIGKILL",
        (args) => {
          inactiveCalls.push([...args]);
          return { status: args[0] === "is-active" ? 3 : 1 };
        },
      ),
    ).toBe("inactive");
    expect(inactiveCalls).toHaveLength(3);
    const calls: string[][] = [];
    expect(
      signalHostedSystemdUnit(
        "subscription-runtime-hosted-test.service",
        "SIGKILL",
        (args) => {
          calls.push([...args]);
          return { status: args[0] === "is-active" ? 0 : 1 };
        },
      ),
    ).toBe("bounded");
    expect(calls).toEqual([
      [
        "kill",
        "--signal=SIGKILL",
        "--kill-whom=all",
        "subscription-runtime-hosted-test.service",
      ],
      ["stop", "--no-block", "subscription-runtime-hosted-test.service"],
      ["is-active", "--quiet", "subscription-runtime-hosted-test.service"],
      [
        "kill",
        "--signal=SIGKILL",
        "--kill-whom=all",
        "subscription-runtime-hosted-test.service",
      ],
      ["stop", "--no-block", "subscription-runtime-hosted-test.service"],
      ["is-active", "--quiet", "subscription-runtime-hosted-test.service"],
    ]);

    expect(
      signalHostedSystemdUnit(
        "subscription-runtime-hosted-test.service",
        "SIGKILL",
        () => ({ status: null, error: new Error("systemctl unavailable") }),
      ),
    ).toBe("bounded");
  });
});
