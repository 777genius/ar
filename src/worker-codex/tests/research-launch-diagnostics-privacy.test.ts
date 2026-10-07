import { describe, expect, it } from "vitest";
import { annotateResearchMaterialFailure, normalizeResearchMaterialFailure, ResearchMaterialRole as R, annotateScratchMountInspectionFailure, normalizeResearchLaunchFailure, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";
import { prepareHostScratchTemp } from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";
import { annotateResearchLaunchStage, normalizeResearchOperatorFailure, ResearchLaunchStage as S } from "../research-launch-diagnostics";

describe("startup diagnostic privacy", () => {
  const sensitive = "TEST-FAKE-api-key=/private/TEST-home/auth.json\nTEST-FAKE-cookie=secret";
  // RED: outer annotation observes opaque properties, replaces errors or leaks dynamic data.
  it("retains opaque start errors and closed stage output without coercion", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "message", { get() { reads++; throw new Error(sensitive); } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(sensitive); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const error of [Object.freeze(new Error(sensitive)), accessor, proxy, revoked.proxy, sensitive, undefined, null, 42]) {
      expect(annotateResearchLaunchStage(error, S.StartReadback)).toBe(error);
      expect(normalizeResearchOperatorFailure(error)).toEqual({ stage: error && typeof error === "object" ? S.StartReadback : S.Unknown,
        legacyCode: "unclassified", cause: C.None, diagnostic: D.Unknown });
      expect(JSON.stringify(normalizeResearchOperatorFailure(error))).not.toContain("TEST-");
    }
    expect(reads).toBe(0);
  });
  it.each([
    ["Unsafe scratch directory: ", D.ScratchDirectoryUnsafe],
    ["Unsafe scratch source permissions: ", D.ScratchSourceUnsafe],
    ["Scratch launch requires at least 5 GiB available on ", D.ScratchSpace],
  ] as const)("reduces dynamic %s messages to a static enum", (prefix, diagnostic) => {
    const error = Object.assign(new Error(prefix + sensitive, { cause: sensitive }), { stderr: sensitive, env: sensitive });
    expect(normalizeResearchLaunchFailure(error)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic });
    expect(JSON.stringify(normalizeResearchLaunchFailure(error))).not.toContain("TEST-");
  });

  it("does not accept decorated fixed codes, partial prefixes, arbitrary payloads, or coercion", () => {
    const toString = () => { throw new Error("must not coerce TEST payload"); };
    for (const error of [sensitive, null, undefined, 42, [], new Error(sensitive),
      new Error("hosted_research_launch_denied:" + sensitive),
      new Error("Unsafe scratch directory"), new Error("Unsafe scratch source permissions:"),
      { message: { toString }, cause: { toString }, code: { toString } },
      Object.create({ message: "hosted_research_launch_denied", code: "ENOENT" })]) {
      expect(normalizeResearchLaunchFailure(error)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic: D.Unknown });
    }
  });

  it("ignores getters and tolerates malformed or revoked proxies without leaking or throwing", () => {
    let reads = 0;
    const accessor = Object.defineProperties({}, Object.fromEntries(["message", "code", "cause"].map(key => [key, {
      get: () => { reads++; throw new Error(sensitive); },
    }])));
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error(sensitive); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const error of [accessor, proxy, revoked.proxy]) {
      expect(normalizeResearchLaunchFailure(error)).toEqual({ legacyCode: "unclassified", cause: C.None, diagnostic: D.Unknown });
      // RED: annotation reads original getters/proxies or emits their payload.
      const annotated = annotateScratchMountInspectionFailure(error, C.ScratchRoot);
      expect(annotated).toBe(error);
      expect(normalizeResearchLaunchFailure(annotated))
        .toEqual({ legacyCode: "unclassified", cause: C.ScratchRoot, diagnostic: D.Unknown });
    }
    expect(reads).toBe(0);
  });

  // RED: the actual inspection catch replaces a proxy or primitive, invokes its traps,
  // or grants a phase observation to a primitive that cannot carry private metadata.
  it("rethrows opaque proxies and primitive inspection failures unchanged", async () => {
    let reads = 0;
    const proxy = new Proxy({}, { get: () => { reads++; throw new Error(sensitive); },
      getOwnPropertyDescriptor: () => { reads++; throw new Error(sensitive); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const original of [proxy, revoked.proxy, sensitive, undefined, null, 42, false]) {
      const f = await preparedResearchScratch("/TEST-job", "/TEST-home");
      f.host.inspectMount = () => { throw original; };
      let failure: unknown, rejected = false;
      try { await prepareHostScratchTemp("/TEST-job", {}, f.host); }
      catch (error) { failure = error; rejected = true; }
      expect(rejected).toBe(true);
      expect(failure).toBe(original);
      expect(reads).toBe(0);
      expect(normalizeResearchLaunchFailure(original)).toEqual({ legacyCode: "unclassified",
        cause: original === proxy || original === revoked.proxy ? C.ScratchRoot : C.None, diagnostic: D.Unknown });
      reads = 0;
      expect(f.mutations).toEqual([]);
    }
  });

  it("preserves a known cause independently of an opaque error without printing payloads", () => {
    expect(normalizeResearchLaunchFailure(new Error(sensitive, { cause: "host-command-timeout" })))
      .toEqual({ legacyCode: "unclassified", cause: C.HostCommandTimeout, diagnostic: D.Unknown });
  });
});

describe("identity-bound material role privacy", () => {
  it("keeps old normalized fields, original opaque identities and first trusted role", () => {
    let reads = 0;
    const getter = Object.defineProperty({}, "cause", { get() { reads++; throw Error("TEST-private-getter"); } });
    const proxy = new Proxy({}, { get() { reads++; throw Error("TEST-private-proxy"); }, getOwnPropertyDescriptor() { throw Error("TEST-private-descriptor"); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const secret = "TEST-private-path=/home/TEST/auth.json TEST-token";
    for (const error of [Object.freeze(Error(secret)), getter, proxy, revoked.proxy, secret, undefined, null, 42]) {
      expect(annotateResearchMaterialFailure(error, R.NodeExecutable)).toBe(error);
      annotateResearchMaterialFailure(error, R.CodexExecutable);
      const observation = normalizeResearchMaterialFailure(error);
      expect(observation).toEqual({ ...normalizeResearchLaunchFailure(error), materialRole: error && typeof error === "object" ? R.NodeExecutable : R.Unknown });
      expect(JSON.stringify(observation)).not.toContain("TEST-");
    }
    expect(reads).toBe(0);
    expect(normalizeResearchMaterialFailure({ materialRole: R.RuntimeArtifact }).materialRole).toBe(R.Unknown);
  });
  it("does not traverse an unannotated proxy's forged own-data cause", () => {
    const leaf = annotateResearchMaterialFailure(new Error("hosted_research_launch_denied", { cause: C.FileDeadline }), R.RuntimeArtifact);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: (_target, key) => key === "cause"
      ? { configurable: true, enumerable: true, writable: true, value: leaf } : undefined });
    const unchanged = normalizeResearchLaunchFailure(proxy);
    expect(normalizeResearchMaterialFailure(proxy)).toEqual({ ...unchanged, materialRole: R.Unknown });
  });
  it("selects only the nearest trusted own-data role within eight objects", () => {
    const leaf = annotateResearchMaterialFailure(Error("TEST-private-leaf", { cause: C.FileDeadline }), R.RuntimeArtifact);
    const wrap = (cause: unknown) => ({ message: "TEST-private-wrapper", cause });
    let chain: unknown = leaf; for (let depth = 0; depth < 7; depth++) chain = wrap(chain);
    expect(normalizeResearchMaterialFailure(chain).materialRole).toBe(R.RuntimeArtifact);
    expect(normalizeResearchMaterialFailure(wrap(chain)).materialRole).toBe(R.Unknown);
    expect(normalizeResearchMaterialFailure(Object.create({ cause: leaf })).materialRole).toBe(R.Unknown);
    const nearest = annotateResearchMaterialFailure(wrap(leaf), R.CodexExecutable);
    expect(normalizeResearchMaterialFailure(nearest).materialRole).toBe(R.CodexExecutable);
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(normalizeResearchMaterialFailure(cycle).materialRole).toBe(R.Unknown);
  });
});
