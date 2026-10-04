import { describe, expect, it } from "vitest";
import { normalizeResearchLaunchFailure, ResearchLaunchCause as C, ResearchLaunchDiagnostic as D } from "../research-launch-diagnostics";

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
    }
    expect(reads).toBe(0);
  });

  it("preserves a known cause independently of an opaque error without printing payloads", () => {
    expect(normalizeResearchLaunchFailure(new Error(sensitive, { cause: "host-command-timeout" })))
      .toEqual({ legacyCode: "unclassified", cause: C.HostCommandTimeout, diagnostic: D.Unknown });
  });
});
