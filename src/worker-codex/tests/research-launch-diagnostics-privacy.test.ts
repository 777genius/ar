import { describe, expect, it } from "vitest";
import { annotateScratchMountInspectionFailure, normalizeResearchLaunchFailure, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";
import { prepareHostScratchTemp } from "../host-scratch-temp";
import { preparedResearchScratch } from "./fixtures/research-scratch-host";

describe("startup diagnostic privacy", () => {
  const sensitive = "TEST-FAKE-api-key=/private/TEST-home/auth.json\nTEST-FAKE-cookie=secret";
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
