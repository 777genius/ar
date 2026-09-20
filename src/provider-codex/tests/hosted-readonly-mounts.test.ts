import { describe, expect, it, vi } from "vitest";
import { hostedReadonlyMountProperties } from "../app-server/adapters/hosted-readonly-mounts";
import { admittedReadonlyCodexProcessFactory, codexAppServerProcessInvocation, spawnCodexAppServerProcess } from
  "../app-server/adapters/node-app-server-process";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, spawnSync: vi.fn() }));

const workspacePath = "/fixture/workspace";
const jobId = "fixture";
const own = workspacePath + "/source-parent-v6-TEST";
const readonlyPaths = [
  workspacePath + "/input-contract", workspacePath + "/runtime/node",
  own + "/README.md", own + "/cache/v8-positive-TEST/corepack/v1/pnpm/11.18.0",
  own + "/cases.json", own + "/inputs/v8-positive-TEST", own + "/instrumented-case.mjs",
  own + "/lifecycle.mjs", own + "/observe-exec.mjs", own + "/run-case.py",
  own + "/successor-binding.json", own + "/successor-binding.mjs",
  own + "/tool-shims-v8-TEST", workspacePath + "/tools/published-cli",
];
const anchors = [
  workspacePath, workspacePath + "/runtime", own, own + "/cache",
  own + "/cache/v8-positive-TEST", own + "/cache/v8-positive-TEST/corepack",
  own + "/cache/v8-positive-TEST/corepack/v1",
  own + "/cache/v8-positive-TEST/corepack/v1/pnpm", own + "/inputs",
  workspacePath + "/tools",
];
const invocation = {
  command: "/codex", args: ["app-server"], cwd: workspacePath,
  env: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_JOB_ID: "fixture" },
  platform: "linux" as const,
  systemdUnit: "subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service",
};

describe("bounded hosted readonly mount adapter", () => {
  it("derives exactly ten writable anchors for the reviewed fourteen-root layout", () => {
    const properties = hostedReadonlyMountProperties({ jobId, workspacePath, readonlyPaths });
    expect(properties).toEqual([
      "PrivateMounts=yes",
      "BindPaths=" + anchors.map(path => `${path}:${path}:norbind`).join(" "),
      "BindReadOnlyPaths=" + readonlyPaths.map(path => `${path}:${path}:norbind`).join(" "),
    ]);
    expect(properties.join(" ")).not.toContain("consumer");
    expect(properties.join(" ")).not.toContain("=-");
  });

  it.each(["/", "relative", "/w/", "/w/../x", "/w/./x", "/w//x", "/w/a:b",
    "/w/%t", "/w/a b", "/w/a\tb", "/w/a\nb", "/w/a\\b", "/w/a\u0000b",
    "/w/a\u007fb", "/w/é", "/w/\"a", "/w/$a"])("rejects ambiguous spelling %j", path => {
    expect(() => hostedReadonlyMountProperties({ jobId, workspacePath: "/w", readonlyPaths: [path] }))
      .toThrow("hosted_readonly_mounts_invalid");
  });

  it.each([
    [], ["/w/a", "/w/a"], ["/w/a", "/w/a/b"], ["/w/a/b", "/w/a"],
    ["/w"], ["/w-sibling/a"], ["/elsewhere/a"], ["/w/" + "a".repeat(4096)],
    Array.from({ length: 65 }, (_, index) => `/w/${index}`),
  ].map(paths => ({ paths })))("rejects empty, overlapping, unbounded or escaping lists $paths", ({ paths }) => {
    expect(() => hostedReadonlyMountProperties({ jobId, workspacePath: "/w", readonlyPaths: paths }))
      .toThrow("hosted_readonly_mounts_invalid");
  });

  it("accepts the maximum root count and sibling prefixes", () => {
    expect(hostedReadonlyMountProperties({ jobId, workspacePath: "/w",
      readonlyPaths: Array.from({ length: 64 }, (_, index) => `/w/a${index}`) })).toHaveLength(3);
  });

  it("adds only reviewed mounts to the explicit provider request", () => {
    const ordinary = codexAppServerProcessInvocation(invocation);
    const mounted = codexAppServerProcessInvocation(invocation, { jobId, workspacePath, readonlyPaths });
    expect(JSON.parse(ordinary.args[2]!).readonlyPaths).toBeUndefined();
    expect(JSON.parse(mounted.args[2]!).readonlyPaths).toEqual(readonlyPaths);
    expect(JSON.parse(mounted.args[2]!)).not.toHaveProperty("mounts");
    expect(JSON.parse(mounted.args[2]!)).not.toHaveProperty("cwd");
    expect(mounted.stdinBootstrap).toBe(ordinary.stdinBootstrap);
  });

  it("fails before spawning on unsupported platform or unmarked hosted mode", () => {
    for (const input of [{ ...invocation, platform: "darwin" as const }, { ...invocation, env: {} }]) {
      expect(() => codexAppServerProcessInvocation(input, { jobId, workspacePath, readonlyPaths }))
        .toThrow("hosted_readonly_engine_unsupported");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("copies admitted input and ignores mount fields supplied at launch", () => {
    const paths = [...readonlyPaths];
    // Explicit simulated fence; real worker composition is tested separately.
    const factory = admittedReadonlyCodexProcessFactory({ jobId, workspacePath, readonlyPaths: paths }, (_unit, submit) => submit());
    paths[0] = "/attacker";
    const child = { stdin: { write: vi.fn() } };
    spawn.mockReturnValue(child);
    const launch = { ...invocation, readonlyPaths: ["/attacker"],
      admittedMounts: { workspacePath: "/attacker", readonlyPaths: ["/attacker/a"] } };
    expect(factory(launch)).toBe(child);
    const args: string[] = spawn.mock.calls.at(-1)![1];
    expect(args.join(" ")).not.toContain("attacker");
    expect(JSON.parse(args[2]!).readonlyPaths).toEqual(readonlyPaths);
    expect(spawn.mock.calls.at(-1)![2].stdio).toEqual(["pipe", "pipe", "pipe"]);
  });
  it("rejects unenrolled hosted defaults and caller-supplied tickets before process creation", () => {
    spawn.mockClear();
    // Ordinary default now requires real private origin; this fixture has none.
    expect(() => spawnCodexAppServerProcess(invocation)).toThrow();
    expect(() => spawnCodexAppServerProcess(invocation, undefined, undefined, {})).toThrow("synchronous_fence_required");
    expect(() => admittedReadonlyCodexProcessFactory({ jobId, workspacePath, readonlyPaths })(invocation)).toThrow("synchronous_fence_required");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("permits one synchronous submission and rejects replay or delayed submission outside the fence", () => {
    spawn.mockClear();
    const child = { stdin: { write: vi.fn() } };
    spawn.mockReturnValue(child);
    let deferred: (() => unknown) | undefined;
    const factory = admittedReadonlyCodexProcessFactory({ jobId, workspacePath, readonlyPaths }, (_unit, submit) => {
      deferred = submit;
      const actual = submit();
      expect(() => submit()).toThrow("synchronous_fence_required");
      return actual;
    });
    expect(factory(invocation)).toBe(child);
    expect(() => deferred!()).toThrow("synchronous_fence_required");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("expires an unused submission when the simulated fence returns", () => {
    spawn.mockClear();
    let deferred: (() => unknown) | undefined;
    const factory = admittedReadonlyCodexProcessFactory({ jobId, workspacePath, readonlyPaths }, (_unit, submit) => {
      deferred = submit;
      return { stdin: { write: vi.fn() } } as never; // Explicit fake, no process submitted.
    });
    factory(invocation);
    expect(() => deferred!()).toThrow("synchronous_fence_required");
    expect(spawn).not.toHaveBeenCalled();
  });

});
