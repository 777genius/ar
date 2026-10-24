import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalFileProviderLock } from "../shared/local-file-custody-lock";
import { captureLocalFileLock } from "./local-file-lock-test-support";

vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
}));

const providerInstanceId = "namespace-session";
const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "ar-custody-namespace-"));
  const captured = await captureLocalFileLock(rootDir, providerInstanceId);
  expect(captured.ownerProcess).toBeDefined();
  const identity = captured.ownerProcess!;
  const record: Record<string, unknown> = { ...captured, ownerProcess: { ...identity },
    acquiredAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:01Z" };
  const lockPath = join(rootDir, "leases", "locks", `${createHash("sha256").update(providerInstanceId).digest("hex")}.lock`);
  return { rootDir, lockPath, record, identity };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function blocked(f: Fixture) {
  const serialized = JSON.stringify(f.record);
  await writeFile(f.lockPath, serialized);
  const entered = vi.fn(async () => "entered");
  const liveness = vi.spyOn(process, "kill");
  await expect(new LocalFileProviderLock({ rootDir: f.rootDir, lockAcquireTimeoutMs: 20, lockPollMs: 1 })
    .run(providerInstanceId, entered)).rejects.toThrow("local_file_lease_lock_timeout");
  expect(entered).not.toHaveBeenCalled();
  expect(liveness).not.toHaveBeenCalled();
  expect(await real.readFile(f.lockPath, "utf8")).toBe(serialized);
}

async function dispose(f: Fixture) {
  vi.restoreAllMocks();
  await rm(f.rootDir, { recursive: true, force: true });
}

describe.skipIf(process.platform !== "linux")("Linux lock namespace evidence", () => {
  it("persists the actual namespace, boot and process birth identity", async () => {
    const f = await fixture();
    try {
      expect(f.identity.pidNamespace).toBe(await readlink("/proc/self/ns/pid"));
      expect(f.identity.bootId).toBe((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
      expect(f.identity.startTimeTicks).toMatch(/^\d+$/);
    } finally { await dispose(f); }
  });

  it.each(["missing-pid", "reused-pid"])("never reclaims a live foreign namespace using %s evidence", async evidence => {
    const f = await fixture();
    try {
      f.record.pid = evidence === "missing-pid" ? 999_999 : process.pid;
      f.record.ownerProcess = { ...f.identity, startTimeTicks: "0",
        pidNamespace: f.identity.pidNamespace === "pid:[1]" ? "pid:[2]" : "pid:[1]" };
      await blocked(f);
    } finally { await dispose(f); }
  });

  it.each([undefined, null, 12, "", "pid:[invalid]", "pid:[0]"])("fails closed for missing or malformed recorded namespace %s", async pidNamespace => {
    const f = await fixture();
    try {
      f.record.pid = 999_999;
      f.record.ownerProcess = { ...f.identity, pidNamespace };
      await blocked(f);
    } finally { await dispose(f); }
  });

  it.each(["missing-owner", "bad-boot", "bad-birth"])("keeps legacy or malformed owner evidence: %s", async evidence => {
    const f = await fixture();
    try {
      f.record.pid = 999_999;
      f.record.ownerProcess = evidence === "missing-owner" ? undefined : {
        ...f.identity, ...(evidence === "bad-boot" ? { bootId: "not-a-boot-uuid" } : { startTimeTicks: "not-a-tick" }),
      };
      await blocked(f);
    } finally { await dispose(f); }
  });

  it.each(["unreadable", "malformed"])("fails closed when the current namespace is %s", async evidence => {
    const f = await fixture();
    try {
      f.record.pid = 999_999;
      if (evidence === "unreadable") vi.spyOn(files, "readlink").mockRejectedValue(Object.assign(new Error("namespace unavailable"), { code: "EACCES" }));
      else vi.spyOn(files, "readlink").mockResolvedValue("pid:[invalid]");
      await blocked(f);
    } finally { await dispose(f); }
  });

  it("rejects an ancestor procfs view even if its numeric self PID happens to match", async () => {
    const f = await fixture();
    try {
      f.record.pid = 999_999;
      vi.spyOn(files, "readFile").mockImplementation(async (path, options) => String(path) === "/proc/self/status"
        ? `NSpid:\t${process.pid}\t${process.pid}\n` : real.readFile(path, options));
      await blocked(f);
    } finally { await dispose(f); }
  });

  it.each(["missing-pid", "reused-pid", "prior-boot"])("recovers a proved dead owner from %s evidence", async evidence => {
    const f = await fixture();
    try {
      f.record.pid = evidence === "missing-pid" ? 999_999 : process.pid;
      if (evidence === "reused-pid") f.record.ownerProcess = { ...f.identity, startTimeTicks: "0" };
      if (evidence === "prior-boot") f.record.ownerProcess = { ...f.identity,
        bootId: f.identity.bootId === "00000000-0000-0000-0000-000000000000"
          ? "11111111-1111-1111-1111-111111111111" : "00000000-0000-0000-0000-000000000000",
        pidNamespace: f.identity.pidNamespace === "pid:[1]" ? "pid:[2]" : "pid:[1]" };
      await writeFile(f.lockPath, JSON.stringify(f.record));
      const entered = vi.fn(async () => "recovered");
      await expect(new LocalFileProviderLock({ rootDir: f.rootDir }).run(providerInstanceId, entered)).resolves.toBe("recovered");
      expect(entered).toHaveBeenCalledOnce();
      await expect(readFile(f.lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await dispose(f); }
  });

  it("preserves an expired live owner in the same namespace and boot", async () => {
    const f = await fixture();
    try {
      const serialized = JSON.stringify(f.record);
      await writeFile(f.lockPath, serialized);
      const entered = vi.fn(async () => "entered");
      const liveness = vi.spyOn(process, "kill");
      await expect(new LocalFileProviderLock({ rootDir: f.rootDir, lockAcquireTimeoutMs: 20, lockPollMs: 1 })
        .run(providerInstanceId, entered)).rejects.toThrow("local_file_lease_lock_timeout");
      expect(liveness).toHaveBeenCalledWith(process.pid, 0);
      expect(entered).not.toHaveBeenCalled();
      expect(await readFile(f.lockPath, "utf8")).toBe(serialized);
    } finally { await dispose(f); }
  });
});
