import { describe, expect, it } from "vitest";
import { bindHostedControllerOriginAndGrant } from "../hosted-controller-origin-binding";

const origin = { installationId: "00000000-0000-0000-0000-000000000001",
  startId: "00000000-0000-0000-0000-000000000002", jobId: "controller-test",
  originSha256: "a".repeat(64) };

describe("private controller origin binding", () => {
  it("requires the same retained origin and fresh private grant on every call", () => {
    let current = { ...origin };
    let grant = Buffer.alloc(32, 1);
    const verify = bindHostedControllerOriginAndGrant({
      readRetainedOrigin: () => current,
      readPrivateGrant: () => grant,
    });
    expect(verify()).toBe(true);
    current = { ...origin, startId: "00000000-0000-0000-0000-000000000003" };
    expect(verify()).toBe(false);
    current = { ...origin };
    grant = Buffer.alloc(32, 2);
    expect(verify()).toBe(false);
    grant = Buffer.alloc(32, 1);
    expect(verify()).toBe(true);
  });

  it("fails closed on missing or malformed private grant", () => {
    expect(() => bindHostedControllerOriginAndGrant({ readRetainedOrigin: () => origin,
      readPrivateGrant: () => Buffer.alloc(4) })).toThrow("hosted_controller_private_grant_invalid");
    let missing = false;
    const verify = bindHostedControllerOriginAndGrant({ readRetainedOrigin: () => origin,
      readPrivateGrant: () => { if (missing) throw new Error("missing"); return Buffer.alloc(32, 1); } });
    missing = true;
    expect(verify()).toBe(false);
  });
});
