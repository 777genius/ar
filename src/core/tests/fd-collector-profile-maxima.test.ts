import { describe, expect, it } from "vitest";
import { fdCollectorProfileLimitMaxima, FdCollectorRenderer, parseFdCollectorProfile } from "../host-infrastructure/fd-collector-profile";

const sha256 = "a".repeat(64);
const file = (path: string) => ({ path, sha256 });
const executable = (path: string) => ({ ...file(path), elfFiles: [file(path), file("/usr/lib/loader.so")] });
const profile = (limits: Record<string, number>) => ({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed,
  ss: executable("/usr/bin/ss"), node: executable("/usr/bin/node"),
  wrappers: ["setpriv", "systemd-run", "tini", "unshare"].map(name => executable("/usr/bin/" + name)),
  bootstraps: ["hosted-app-server-launcher", "hosted-dependency-installer-bootstrap", "hosted-readonly-host-launch-cli", "hosted-readonly-runtime-bootstrap"]
    .map(name => file(`/runtime/${name}.js`)), limits });
const keys = Object.keys(fdCollectorProfileLimitMaxima) as (keyof typeof fdCollectorProfileLimitMaxima)[];

describe("collector profile limit maxima: one shared definition for the parser and every issuer", () => {
  // Regression: the issuer copies its own ceilings and drifts from the parser, so a profile the issuer writes is refused at admission (or a looser one is accepted).
  it("exports the frozen contract ceilings and the parser accepts exactly them", () => {
    expect(Object.isFrozen(fdCollectorProfileLimitMaxima)).toBe(true);
    expect(fdCollectorProfileLimitMaxima).toEqual({ setupTimeoutMs: 60_000, collectorTimeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024, maxRows: 65_536,
      maxBufferedInputBytes: 4 * 1024 * 1024, maxEventPoll: 8, maxEventFd: 8, maxPipeEndpoints: 32, maxDevNullReserves: 8 });
    expect(parseFdCollectorProfile(profile({ ...fdCollectorProfileLimitMaxima })).limits).toEqual(fdCollectorProfileLimitMaxima);
  });
  // Regression: a ceiling is silently relaxed when the constant is edited without the parser, or only some keys are enforced.
  it.each(keys)("refuses %s one above its ceiling and at zero", key => {
    expect(() => parseFdCollectorProfile(profile({ ...fdCollectorProfileLimitMaxima, [key]: fdCollectorProfileLimitMaxima[key] + 1 }))).toThrow();
    expect(() => parseFdCollectorProfile(profile({ ...fdCollectorProfileLimitMaxima, [key]: 0 }))).toThrow();
  });
});
