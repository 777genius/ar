import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCodexGoalCli, type CodexGoalCliIo } from "../codex-goal-cli";
import * as fdObservation from "../../provider-codex/app-server/adapters/hosted-fd-observation";
import * as installation from "../hosted-installation-activation";
import { HostedReadonlySupervisorHost } from "../hosted-readonly-supervisor-host";
import { CodexGoalOriginReason, CodexGoalOriginModule, CodexGoalOriginFormat } from "../codex-goal-origin-diagnostic";

const hostPolicyFixture = vi.hoisted(() => ({ root: "" }));
// Substitute only an absent policy parent; keep real ancestor custody checks.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const [{ tmpdir }, { join }] = await Promise.all([import("node:os"), import("node:path")]);
  hostPolicyFixture.root = real.mkdtempSync(join(tmpdir(), "TEST-codex-goal-cli-host-policy-"));
  return { ...real, lstatSync: ((path, ...args) => Reflect.apply(real.lstatSync, real, [
    path === "/etc/subscription-runtime" ? join(hostPolicyFixture.root, "absent-subscription-runtime") : path, ...args,
  ])) as typeof real.lstatSync };
});
afterAll(() => rm(hostPolicyFixture.root, { recursive: true, force: true }));

describe("closed CLI origin diagnostics", () => {
  it("writes closed origin source facts with exit2 and preserves ordinary error text and EPIPE", async () => {
    for (const kind of ["origin", "ordinary", "epipe"] as const) {
      const error = new Error(kind === "ordinary" ? "unchanged ordinary failure" : CodexGoalOriginReason.Current);
      error.stack = "Error PRIVATE_CANARY\n at private (/PRIVATE_CANARY/hosted-current-dependency-origin.js:160:9)";
      if (kind === "epipe") Object.assign(error, { code: "EPIPE" });
      const io = captureIo(); io.writeStdout = () => { throw error; };
      expect(await runCodexGoalCli(["help"], io)).toBe(kind === "epipe" ? 0 : 2);
      expect(io.stderr).toBe(kind === "epipe" ? "" : kind === "ordinary" ? "unchanged ordinary failure\n" : JSON.stringify({
        reason: CodexGoalOriginReason.Current, locations: [{ module: CodexGoalOriginModule.Current,
          format: CodexGoalOriginFormat.Emitted, line: 160, column: 9 }],
      }) + "\n");
      expect(io.stderr).not.toContain("PRIVATE_CANARY");
    }
  });

  it("keeps the unverified default foreground sink silent with exit70 before origin diagnostics", async () => {
    const error = new Error(CodexGoalOriginReason.Current);
    const profile = vi.spyOn(fdObservation, "readHostedFdProfile").mockReturnValue({} as NonNullable<ReturnType<typeof fdObservation.readHostedFdProfile>>);
    const ordinary = vi.spyOn(installation, "isHostedOrdinaryRuntime").mockReturnValue(false);
    const role = vi.spyOn(HostedReadonlySupervisorHost.prototype, "runtimeRole").mockImplementation(() => { throw new Error("TEST unverified"); });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => { throw error; });
    try {
      const result = runCodexGoalCli(["help"]); stdout.mockRestore();
      expect(await result).toBe(70); expect(stderr).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); stderr.mockRestore(); role.mockRestore(); ordinary.mockRestore(); profile.mockRestore(); }
  });

});

function captureIo(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexGoalCliIo & {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  return {
    writeStdout(chunk): void {
      stdout += chunk;
    },
    writeStderr(chunk): void {
      stderr += chunk;
    },
    cwd(): string {
      return "/tmp";
    },
    env(): Readonly<Record<string, string | undefined>> {
      return env;
    },
    get stdout(): string {
      return stdout;
    },
    get stderr(): string {
      return stderr;
    },
  };
}
