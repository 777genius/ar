import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hostedFdNamespacePrefix, hostedFdNamespaceStage, assertHostedFdNamespaceAncestry, type HostedFdNamespaceProcess } from "../app-server/adapters/hosted-fd-namespace-stages";
import { closedObserverFailure, AppServerObserverPoint as Point, validatedObserverFailure } from "../app-server/domain/app-server-observer-failure";
import { AppServerNamespaceReason as Reason, AppServerNamespaceRole as Role, AppServerNamespaceArgKind as ArgKind } from "../app-server/domain/app-server-namespace-failure";
import { retainAppServerProviderSetupFailure, appServerProviderSetupFailureCause, AppServerProviderSetupStage as Stage,
  AppServerProviderSetupCheckpoint as Checkpoint, AppServerProviderSetupCode as Code } from "../app-server/domain/app-server-provider-setup-observation";

const argv = [...hostedFdNamespacePrefix, "/trusted/node", "/trusted/bootstrap.js", "--fd-ready-v1"];
const stage = (at: number, pid: number, parentPid: number): HostedFdNamespaceProcess => ({ pid, parentPid, exe: argv[at]!, argv: argv.slice(at) });
const main = stage(0, 70, 1), tini = stage(18, 73, 70);
function denied(action: () => void) {
  const error = (() => { try { action(); } catch (error) { return error; } throw Error("TEST expected rejection"); })();
  expect((error as Error).message).toBe("hosted_fd_namespace_stage_unresolved");
  return closedObserverFailure(error, Point.Native, 99);
}
it("keeps exact stages and graph validation while recording each rejected source predicate", () => {
  for (const at of [0, 7, 13, 18]) expect(hostedFdNamespaceStage(argv, stage(at, at + 70, 70))).toBe(at);
  expect(() => assertHostedFdNamespaceAncestry(argv, [main, tini, { pid: 74, parentPid: 73, exe: argv[20]!, argv: argv.slice(20) }], 70)).not.toThrow();
  const reversed = [...argv]; reversed[1] = "--user";
  const cases: readonly [Reason, () => void][] = [
    [Reason.Prefix, () => assertHostedFdNamespaceAncestry(reversed, [main], 70)],
    [Reason.Main, () => assertHostedFdNamespaceAncestry(argv, [main], 99)],
    [Reason.Main, () => assertHostedFdNamespaceAncestry(argv, [tini], 73)],
    [Reason.Main, () => assertHostedFdNamespaceAncestry(argv, [{ ...main, argv: argv.slice(7) }], 70)],
    [Reason.Stage, () => assertHostedFdNamespaceAncestry(argv, [{ ...main, argv: ["TEST-private-canary"] }], 70)],
    [Reason.Duplicate, () => assertHostedFdNamespaceAncestry(argv, [main, tini, stage(18, 75, 70)], 70)],
    [Reason.Parent, () => assertHostedFdNamespaceAncestry(argv, [main, { ...tini, parentPid: 99 }], 70)],
    [Reason.Order, () => assertHostedFdNamespaceAncestry(argv, [main, stage(7, 71, 73), stage(18, 73, 71)], 70)],
  ];
  for (const [reason, action] of cases) expect(denied(action)).toMatchObject({ point: Point.Namespace, namespace: { reason } });
});
it("distinguishes exact executable mismatch, argv mismatch and parent role without exporting target text", () => {
  const alias = denied(() => hostedFdNamespaceStage(argv, { exe: "/TEST-private-credential-canary/unshare", argv }));
  expect(alias.namespace?.actor).toEqual({ role: Role.UnshareBasename, matches: 0, argcCapped: 23, expected: 1, mismatchIndexCapped: -1, argKind: ArgKind.Exact });
  const changed = [...argv]; changed[2] = "/TEST-private-credential-canary";
  const mismatch = denied(() => assertHostedFdNamespaceAncestry(argv, [{ ...main, argv: changed }], 70));
  expect(mismatch.namespace?.actor).toMatchObject({ role: Role.Unshare, matches: 0, expected: 1, mismatchIndexCapped: 2, argKind: ArgKind.Other });
  expect(mismatch.namespace?.main).toEqual(mismatch.namespace?.actor);
  const inner = denied(() => hostedFdNamespaceStage(argv, { exe: "/usr/bin/unshare", argv: ["/usr/bin/unshare", "--user"] }));
  expect(inner.namespace?.actor).toMatchObject({ expected: 2, mismatchIndexCapped: 2, argKind: ArgKind.Missing });
  const basename = denied(() => hostedFdNamespaceStage(argv, { exe: "/usr/bin/tini", argv: ["tini", ...argv.slice(19)] }));
  expect(basename.namespace?.actor.argKind).toBe(ArgKind.Basename);
  const order = denied(() => assertHostedFdNamespaceAncestry(argv, [main, stage(7, 71, 73), stage(18, 73, 71)], 70));
  expect(order.namespace?.parentMatches).toBe(8);
  for (const observation of [alias, mismatch, inner, basename, order]) {
    expect(JSON.stringify(observation)).not.toContain("canary");
    expect(JSON.stringify(observation)).not.toContain("/trusted/");
  }
});
it("clones only bounded own-data namespace facts into genuine setup causes", () => {
  const observation = denied(() => hostedFdNamespaceStage(argv, { exe: "/TEST-private-credential-canary/unshare", argv }));
  const child = {};
  retainAppServerProviderSetupFailure(child, { stage: Stage.Observing, checkpoint: Checkpoint.Namespace, code: Code.Namespace,
    ready: true, released: false, elapsedMsCapped: 60000, limitMs: 60000, observer: observation });
  expect(appServerProviderSetupFailureCause(child)?.message).toContain("ns=s:U,0,23,1,-1,e:?,0,0,0,-1,n:0");
  let reads = 0;
  for (const namespace of [
    { ...observation.namespace, reason: "TEST-secret-canary" },
    { ...observation.namespace, actor: { ...observation.namespace!.actor, argcCapped: 256 } },
    { ...observation.namespace, actor: { ...observation.namespace!.actor, matches: 16 } },
    { ...observation.namespace, actor: { ...observation.namespace!.actor, mismatchIndexCapped: -2 } },
    { ...observation.namespace, main: Object.defineProperty({ ...observation.namespace!.main }, "role", { get() { reads++; return Role.Unshare; } }) },
    new Proxy({}, { ownKeys() { throw Error("TEST-secret-canary"); } }),
  ]) expect(validatedObserverFailure({ ...observation, namespace })).toBeUndefined();
  expect(reads).toBe(0);
  expect(validatedObserverFailure({ ...observation, point: Point.Native })).toBeUndefined();
  expect(closedObserverFailure(new Error("hosted_fd_namespace_stage_unresolved"), Point.Native, 0).namespace).toBeUndefined();
});
it.runIf(process.platform === "linux")("checks the actual Linux exact-recipe process graph through the compiled validator", context => {
  if (!["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini"].every(existsSync)) { context.skip(); return; }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/hosted-fd-namespace-native.mts", import.meta.url))],
    { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 15000, maxBuffer: 8192 });
  if (result.status === 77 && result.stdout === "TEST namespace capability unavailable\n") { context.skip(); return; }
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
  expect(result.status).toBe(0); expect(result.stdout).toBe("TEST exact namespace graph accepted\n");
});
