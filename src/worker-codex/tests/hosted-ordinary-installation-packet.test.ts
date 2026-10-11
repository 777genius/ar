import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runQualifiedPairInstallationOperator, runOrdinaryInstallationSupervisor, type OrdinaryInstallationPacket } from "../hosted-ordinary-installation-bootstrap";

const fixture = vi.hoisted(() => ({ request: Buffer.alloc(0), funded: Buffer.alloc(0), fragment: vi.fn() }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (path: Parameters<typeof actual.readFileSync>[0], options: Parameters<typeof actual.readFileSync>[1]) =>
    path === "/etc/machine-id" ? "a".repeat(32) : actual.readFileSync(path, options) };
});
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => ({
  ...await original<typeof import("@vioxen/subscription-runtime/provider-codex")>(), assertHostedActivationOperator: vi.fn(),
}));
vi.mock("../hosted-readonly-linux-collector", async original => ({
  ...await original<typeof import("../hosted-readonly-linux-collector")>(), collectBootId: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
}));
vi.mock("../hosted-readonly-host-kernel", async original => ({
  ...await original<typeof import("../hosted-readonly-host-kernel")>(), readTrustedFragment: fixture.fragment,
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(), readHostedPrivateBytes: (path: string) => {
    if (path.endsWith(".request.json")) return fixture.request;
    if (path.endsWith("launcher-consumed.json")) return Buffer.from(createHash("sha256").update(fixture.funded).digest("hex") + "\n");
    if (path.endsWith(".json")) return fixture.funded;
    throw new Error("unexpected_private_read");
  },
}));

const id = "9fd9ed9e-bea6-4c42-bf27-dc1cd91ee5e6";
function packet(): OrdinaryInstallationPacket {
  const issuedEpochMs = Date.now();
  return { schemaVersion: 1, operationId: id, hostId: "a".repeat(32), bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    issuedEpochMs, issuedMonotonicNs: process.hrtime.bigint().toString(), workEndEpochMs: issuedEpochMs + 150000, cleanupEndEpochMs: issuedEpochMs + 175000,
    runtimeDirectory: fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""), runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
    node: { path: process.execPath, sha256: "c".repeat(64) }, bootstrap: { path: fileURLToPath(new URL("../hosted-ordinary-installation-bootstrap.js", import.meta.url)), sha256: "d".repeat(64) },
    creator: {} as OrdinaryInstallationPacket["creator"], collectorProfile: {} as OrdinaryInstallationPacket["collectorProfile"], systemBusInfrastructure: {},
    copiedLauncher: { path: "/opt/subscription-runtime/managed-launcher/launch.mjs", sha256: "e".repeat(64) }, copiedCodec: { path: "/opt/subscription-runtime/managed-launcher/host-inventory-codec.cjs", sha256: "f".repeat(64) } };
}
function request(value: unknown): void { fixture.request = Buffer.from(JSON.stringify({ schemaVersion: 1, packet: value,
  candidate: {}, preparedFixture: {}, copiedCohort: {}, preparedCollectorProfile: {}, priorCollectorProfile: {} })); }

// Exercise the original private checker through its public operator entry. The
// first source-pin read is a deliberate boundary: no funding or pair can run.
describe("original ordinary installation packet admission", () => {
  beforeEach(() => { fixture.fragment.mockReset(); fixture.fragment.mockImplementation(() => { throw new Error("source_pin_boundary"); }); });
  it("admits the canonical required node before checking its source pin", async () => {
    const value = packet(); request(value);
    await expect(runQualifiedPairInstallationOperator(id)).rejects.toThrow("source_pin_boundary");
    expect(fixture.fragment).toHaveBeenCalledExactlyOnceWith(value.node.path, 256 * 1024 * 1024);
  });
  it.each(["missing-node", "unknown-key", "wrong-node"])("rejects %s before any source-pin read", async mode => {
    const value: Record<string, unknown> = { ...packet() };
    if (mode === "missing-node") delete value.node;
    if (mode === "unknown-key") value.foreign = true;
    if (mode === "wrong-node") value.node = { path: "/foreign/node", sha256: "c".repeat(64) };
    request(value);
    await expect(runQualifiedPairInstallationOperator(id)).rejects.toThrow("hosted_ordinary_installation_held");
    expect(fixture.fragment).not.toHaveBeenCalled();
  });
  it("retains required node when projecting the original funded schema", async () => {
    const value = packet(); fixture.funded = Buffer.from(JSON.stringify({ ...value, schemaVersion: 2,
      qualificationRequestSha256: "a".repeat(64), candidate: {}, preparedFixture: {}, copiedCohort: {}, preparedCollectorProfile: {}, priorCollectorProfile: {} }));
    await expect(runOrdinaryInstallationSupervisor(id)).rejects.toThrow("source_pin_boundary");
    expect(fixture.fragment).toHaveBeenCalledExactlyOnceWith(value.node.path, 256 * 1024 * 1024);
  });
});
