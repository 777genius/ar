import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedActivationPhase as Phase, HostedCustodyReservationState, type HostedActivation } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { HostedReadonlyEpochStore } from "../hosted-readonly-epoch-store";

const fixture = vi.hoisted(() => ({ root: "", failRename: false,
  boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }));
const prefix = "/var/lib/subscription-runtime-host-policy";
function local(path: string): string {
  if (["/", "/var", "/var/lib", prefix].includes(path)) return fixture.root;
  if (path.startsWith(prefix + "/")) return join(fixture.root, path.slice(prefix.length + 1));
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) =>
      path === "/proc/self/uid_map" ? "0 0 4294967295\n" : path === "/proc/sys/kernel/random/boot_id" ? fixture.boot : real.readFileSync(local(path), options),
    readlinkSync: (path: string) => path.startsWith("/proc/") ? "host-namespace" : real.readlinkSync(local(path)),
    lstatSync: (path: string) => Object.assign(real.lstatSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => Object.assign(real.fstatSync(fd), { uid: 0 }),
    openSync: (path: string, flags: number, mode: number) => real.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
    renameSync: (from: string, to: string) => {
      if (fixture.failRename) throw new Error("synthetic interrupted publication");
      real.renameSync(local(from), local(to));
    },
  };
});
const sha = "a".repeat(64);
const initial: HostedActivation = { schemaVersion: 1, installationId: "install-1", hostId: "host-1",
  bootId: "boot-1", supervisorId: "supervisor-1", generation: 1, phase: Phase.Closed,
  ordinaryOriginsSha256: sha, exclusiveEnrollmentSha256: null, ordinaryStarts: [] };
function put(name: string, value: unknown) { writeFileSync(join(fixture.root, name), JSON.stringify(value) + "\n", { mode: 0o600 }); }
function successor(prior: HostedActivation, patch: Partial<HostedActivation>): HostedActivation {
  return { ...prior, ...patch, generation: prior.generation + 1 };
}
beforeEach(() => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  fixture.root = mkdtempSync(join(tmpdir(), "host-activation-store-")); fixture.failRename = false;
  fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  put("host-installation.json", { schemaVersion: 1, installationId: "install-1", hostId: "host-1",
    runtimeDirectory: "/opt/runtime", runtimeSha: "a".repeat(40), runtimeManifestSha256: sha, inventorySha256: sha });
  put("host-activation.json", initial);
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("real activation publication with substituted OS/private facts", () => {
  it("holds the same mutex for both epoch and activation compositions before enrollment", () => {
    const store = new HostedInstallationActivationStore();
    store.serialized(fence => {
      expect(() => withHostedActivationFence(() => {})).toThrow();
      expect(() => new HostedReadonlyEpochStore().withHeldFence(fence, () => {})).toThrow("durable_authority_required");
      expect(() => new HostedReadonlyEpochStore().withHeldFence({ held: true }, () => {})).toThrow("common_fence_required");
      store.publish(fence, successor(store.read(), { phase: Phase.Ordinary }));
    });
    expect(store.read().phase).toBe(Phase.Ordinary);
  });
  it("rejects escaped capabilities and serializes competing submit versus exclusive entry", () => {
    const store = new HostedInstallationActivationStore();
    let saved: HostedActivationFence | undefined;
    store.serialized(fence => { saved = fence; store.publish(fence, successor(store.read(), { phase: Phase.Ordinary })); });
    expect(() => store.publish(saved!, successor(store.read(), { phase: Phase.Closed }))).toThrow("common_fence_required");
    // The actual mkdir lock remains held through the synchronous effect callback.
    let submitted = false;
    store.serialized(fence => {
      const current = store.read();
      store.publish(fence, successor(current, { ordinaryStarts: [{ startId: "start-1", unit: "runtime-1.service",
        creatorId: "creator-1", originSha256: sha, generation: 3, state: HostedCustodyReservationState.Reserved }] }));
      expect(() => new HostedInstallationActivationStore().serialized(() => {})).toThrow();
      submitted = true;
    });
    expect(submitted).toBe(true);
    store.serialized(fence => store.publish(fence, successor(store.read(), { phase: Phase.EnteringExclusive })));
    expect(() => store.serialized(fence => store.publish(fence, successor(store.read(), {
      phase: Phase.Exclusive, exclusiveEnrollmentSha256: sha })))).toThrow();
    expect(store.read().ordinaryStarts).toHaveLength(1);
  });
  it("failed rename retains exact next and recovery closes before callbacks", () => {
    const store = new HostedInstallationActivationStore();
    fixture.failRename = true;
    expect(() => store.serialized(fence => store.publish(fence, successor(store.read(), { phase: Phase.Ordinary })))).toThrow("interrupted publication");
    const bytes = readFileSync(join(fixture.root, "host-activation.next"));
    expect(() => store.read()).toThrow("publication_recovery_required");
    expect(JSON.parse(readFileSync(join(fixture.root, "host-activation.json"), "utf8")).phase).toBe(Phase.Closed);
    fixture.failRename = false;
    let recovered = false;
    store.recoverSerialized(() => { recovered = true; expect(store.read().phase).toBe(Phase.Closed); });
    expect(recovered).toBe(true);
    expect(store.read().generation).toBe(3);
    expect(JSON.parse(bytes.toString()).phase).toBe(Phase.Ordinary);
    expect(() => readFileSync(join(fixture.root, "host-activation.next"))).toThrow();
  });
  it.each(["stale", "skipped", "foreign", "malformed"])("retains %s successor without invoking recovery effects", kind => {
    const next = successor(initial, { phase: Phase.Ordinary });
    put("host-activation.next", kind === "malformed" ? [] : { ...next,
      ...(kind === "stale" ? { generation: 1 } : kind === "skipped" ? { generation: 3 } : { installationId: "foreign" }) });
    const bytes = readFileSync(join(fixture.root, "host-activation.next"));
    let called = false;
    expect(() => new HostedInstallationActivationStore().recoverSerialized(() => { called = true; })).toThrow();
    expect(called).toBe(false);
    expect(readFileSync(join(fixture.root, "host-activation.next"))).toEqual(bytes);
  });
  it("missing installation or activation never initializes records", () => {
    rmSync(join(fixture.root, "host-activation.json"));
    const store = new HostedInstallationActivationStore();
    expect(() => store.serialized(() => {})).toThrow();
    expect(() => store.recoverSerialized(() => {})).toThrow();
    expect(() => readFileSync(join(fixture.root, "host-activation.json"))).toThrow();
  });
  it("retains same-boot crash lock and never interprets reboot as resume", () => {
    const lock = join(fixture.root, `readonly-epoch.${fixture.boot}.lock`);
    mkdirSync(lock, { mode: 0o700 });
    const store = new HostedInstallationActivationStore();
    expect(() => store.recoverSerialized(() => {})).toThrow();
    fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    store.recoverSerialized(() => expect(store.read().phase).toBe(Phase.Closed));
    expect(() => mkdirSync(lock)).toThrow();
  });
});
