import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const facts = vi.hoisted(() => ({
  cgroup: "",
  privateRead: vi.fn(() => Buffer.from("{}")),
  origin: vi.fn(() => ({ reservation: { startId: "12345678-1234-1234-1234-123456789abc" }, installation: {} })),
}));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: (path: unknown) => {
    if (path !== "/proc/self/cgroup") throw new Error("TEST unexpected file observation");
    return facts.cgroup;
  },
}));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", () => ({
  assertHostedActivationFence: vi.fn(),
  decodeHostedActivationBytes: (bytes: Buffer) => JSON.parse(bytes.toString()) as unknown,
  readHostedActivationBytes: facts.privateRead,
  readHostedOrdinaryProcessOrigin: facts.origin,
  withHostedActivationFence: <T>(action: (fence: { held: true }) => T): T => action({ held: true }),
}));
vi.mock("../hosted-installation-activation", () => ({
  readHostedOrdinaryRuntime: vi.fn(),
  readHostedOrdinaryObservationOrigin: vi.fn(),
}));

import { isHostedOrdinaryRuntime } from "../hosted-ordinary-writer-authority";
import { assertHostedOrdinaryEffectPaths } from "../../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";

const unified = "0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service";

// RED: either selector silently skips a valid hybrid owner, or malformed
// membership reaches the private owner instead of refusing at the proc boundary.
describe("ordinary writer guards on canonical hybrid membership", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    facts.privateRead.mockClear();
    facts.origin.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([`${unified}\n`, `1:name=systemd:/\n${unified}\n`, `${unified}\n1:name=systemd:/\n`])(
    "selects both actual guards and refuses corrupt private extent (%s)", cgroup => {
      facts.cgroup = cgroup;
      expect(isHostedOrdinaryRuntime()).toBe(true);
      // Actual public effect guard reaches its unchanged exact private parser.
      // A corrupt seal cannot become a positive writer or Native authority.
      expect(() => assertHostedOrdinaryEffectPaths(["/TEST/unsealed-output"]))
        .toThrow("hosted_ordinary_writer_extent_invalid");
      expect(facts.origin).toHaveBeenCalledOnce();
      expect(facts.privateRead).toHaveBeenNthCalledWith(1, "ordinary-starts/12345678-1234-1234-1234-123456789abc.extent.json");
    },
  );

  it.each([`${unified}\n${unified}\n`, `${unified}\n2:cpu:/foreign\n`])(
    "refuses duplicate or foreign membership before private owner lookup (%s)", cgroup => {
      facts.cgroup = cgroup;
      expect(() => isHostedOrdinaryRuntime()).toThrow();
      expect(() => assertHostedOrdinaryEffectPaths(["/TEST/unsealed-output"])) .toThrow();
      expect(facts.origin).not.toHaveBeenCalled();
      expect(facts.privateRead).not.toHaveBeenCalled();
    },
  );
});
