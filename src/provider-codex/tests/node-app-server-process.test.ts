import { describe, expect, it } from "vitest";
import { pruneCodexChildEnv } from "../codex-cli-domain";
import {
  codexAppServerProcessInvocation,
  signalHostedSystemdUnit,
} from "../app-server/adapters/node-app-server-process";

describe("hosted Codex app-server resource containment", () => {
  it("rejects detached provider units without durable host-job ownership", () => {
    expect(() => codexAppServerProcessInvocation({
      command: "/opt/codex/bin/codex",
      args: ["app-server"],
      cwd: "/sandbox",
      env: pruneCodexChildEnv({
        SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
        SUBSCRIPTION_RUNTIME_HOST_JOB_ID: "sandbox-job",
      }),
      platform: "linux",
    })).toThrow("host-job detached provider ownership is not supported");
  });
  it("places hosted Linux app-server trees in the bounded worker slice", () => {
    const systemdUnit = "subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service";
    const invocation = codexAppServerProcessInvocation({
      command: "/opt/codex/bin/codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: "/var/data/worktrees/task",
      env: {
        SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
        SECRET_TOKEN: "not-in-argv",
        SUBSCRIPTION_RUNTIME_JOB_ID: "task",
      },
      hostedLauncher: "/runtime/hosted-app-server-launcher.js",
      nodePath: "/usr/bin/node",
      platform: "linux",
      systemdUnit,
    });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.systemdUnit).toBe(systemdUnit);
    expect(invocation.stdinBootstrap).toBe(
      '{"schemaVersion":1,"command":"/opt/codex/bin/codex","args":["app-server","--listen","stdio://"],"cwd":"/var/data/worktrees/task","env":{"SUBSCRIPTION_RUNTIME_SANDBOX_KIND":"hosted-codex-job","SECRET_TOKEN":"not-in-argv","SUBSCRIPTION_RUNTIME_JOB_ID":"task"}}\n',
    );
    expect(invocation.args.slice(0, 2)).toEqual([
      "/opt/subscription-runtime/managed-launcher/launch.mjs", "provider",
    ]);
    expect(JSON.parse(invocation.args[2]!)).toEqual({
      operation: "provider", jobId: "task", unit: systemdUnit,
      payload: ["/usr/bin/node", "/runtime/hosted-app-server-launcher.js"],
    });
  });

  it("keeps the managed entrypoint fixed when the in-service node and launcher are customized", () => {
    const invocation = codexAppServerProcessInvocation({
      command: "/sandbox/codex",
      args: ["app-server"],
      cwd: "/sandbox/workspace",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: "task" },
      platform: "linux",
      nodePath: "/sandbox/node",
      hostedLauncher: "/sandbox/hosted-app-server-launcher.js",
    });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args.slice(0, 2)).toEqual([
      "/opt/subscription-runtime/managed-launcher/launch.mjs", "provider",
    ]);
    expect(JSON.parse(invocation.args[2]!).payload).toEqual(["/sandbox/node", "/sandbox/hosted-app-server-launcher.js"]);
  });

  it("derives distinct standalone identities from the generated provider unit UUID", () => {
    const input = {
      command: "/synthetic/codex", args: ["app-server"], cwd: "/synthetic/home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
      platform: "linux" as const,
    };
    const first = codexAppServerProcessInvocation(input);
    const second = codexAppServerProcessInvocation(input);
    const request = JSON.parse(first.args[2]!);
    expect(request.jobId).toMatch(/^provider-[0-9a-f-]{36}$/);
    expect(first.systemdUnit).toBe(`subscription-runtime-hosted-${request.jobId.slice("provider-".length)}.service`);
    expect(JSON.parse(first.stdinBootstrap!).env.SUBSCRIPTION_RUNTIME_JOB_ID).toBe(request.jobId);
    expect(JSON.parse(second.args[2]!).jobId).not.toBe(request.jobId);
    expect(() => codexAppServerProcessInvocation({ ...input, systemdUnit: "../escape" }))
      .toThrow("hosted_managed_job_identity_required");
  });

  it.each(["", "../escape", "/absolute", "bad/name", "task:checkpoint", " a", "a".repeat(129)])("rejects invalid managed job identity %j", jobId => {
    expect(() => codexAppServerProcessInvocation({
      command: "/synthetic/codex", args: ["app-server"], cwd: "/synthetic/home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job",
        ...(jobId === undefined ? {} : { SUBSCRIPTION_RUNTIME_JOB_ID: jobId }) },
      platform: "linux",
    })).toThrow("hosted_managed_job_identity_required");
  });

  it("prefers admitted identity to environment and preserves session HOME in the private frame", () => {
    const invocation = codexAppServerProcessInvocation({
      command: "/synthetic/codex", args: ["app-server"], cwd: "/synthetic/session-home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: "untrusted" },
      platform: "linux",
    }, { jobId: "admitted", workspacePath: "/synthetic/workspace", readonlyPaths: ["/synthetic/workspace/input"] });
    expect(JSON.parse(invocation.args[2]!)).toMatchObject({ jobId: "admitted", readonlyPaths: ["/synthetic/workspace/input"] });
    expect(JSON.parse(invocation.args[2]!)).not.toHaveProperty("cwd");
    expect(JSON.parse(invocation.args[2]!)).not.toHaveProperty("mounts");
    expect(JSON.parse(invocation.stdinBootstrap!).cwd).toBe("/synthetic/session-home");
    expect(JSON.parse(invocation.stdinBootstrap!).env.SUBSCRIPTION_RUNTIME_JOB_ID).toBe("admitted");
  });

  it.each(["a", "a".repeat(128)])("accepts managed contract identity %j", jobId => {
    const invocation = codexAppServerProcessInvocation({
      command: "/synthetic/codex", args: ["app-server"], cwd: "/synthetic/home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: jobId },
      platform: "linux",
    });
    expect(JSON.parse(invocation.args[2]!).jobId).toBe(jobId);
  });

  it("rejects missing admitted identity without falling back to environment", () => {
    expect(() => codexAppServerProcessInvocation({
      command: "/synthetic/codex", args: ["app-server"], cwd: "/synthetic/home",
      env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: "fallback" },
      platform: "linux",
    }, { jobId: undefined as unknown as string, workspacePath: "/synthetic/workspace", readonlyPaths: ["/synthetic/workspace/input"] }))
      .toThrow("hosted_managed_job_identity_required");
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
