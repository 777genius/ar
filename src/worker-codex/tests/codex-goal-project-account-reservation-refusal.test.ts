import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryWorkerAccountCapacityStore,
  type WorkerAccountLeaseStore,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountLeaseStore } from "@vioxen/subscription-runtime/store-local-file";
import { CodexSessionHomeProfileKind } from "../codex-session-home-profile";
import {
  codexProjectAccountReservationPath,
  reserveCodexProjectAccount,
} from "../application/project-control/codex-goal-project-account-reservation";
import { singleAccountFixture } from "./codex-goal-project-account-reservation-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("project account reservation source-refusal cleanup", () => {
  // RED: source refusal used to strand an acquired/renewed file lease and receipt.
  // Cleanup derived from the drifted arguments would instead release the foreign reservation.
  it.each(["acquire", "renew"] as const)("releases only the captured exclusive %s after continuation data drifts", async operation => {
    const root = await mkdtemp(join(tmpdir(), "TEST-reservation-refusal-"));
    roots.push(root);
    const scoped = singleAccountFixture(root, "TEST-original-job");
    const foreign = singleAccountFixture(root, "TEST-foreign-job");
    Object.assign(foreign.launch.config, { authRootDir: join(root, "foreign-auth-unused") });
    const store = new LocalFileWorkerAccountLeaseStore({ rootDir: join(root, "original-leases") });
    const foreignStore = new LocalFileWorkerAccountLeaseStore({ rootDir: join(root, "foreign-leases") });
    const now = new Date("2026-07-13T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const sessionHomeProfile = { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "TEST-session" };
    Object.assign(scoped.launch.config, { sessionHomeProfile });
    const originalPath = codexProjectAccountReservationPath(scoped.manifest);
    const foreignPath = codexProjectAccountReservationPath(foreign.manifest);
    await reserveCodexProjectAccount({ ...foreign,
      deps: { capacityStore, leaseStore: foreignStore, leaseMode: "exclusive", now } });
    const foreignBytes = await readFile(foreignPath, "utf8");
    // Project selection leases the whole account (leaseDemand:null), not a model-specific slot.
    const foreignLeaseInput = { accountId: "account-a", ownerId: foreign.manifest.jobId, ttlMs: 60_000, now };
    const foreignLease = await foreignStore.acquire(foreignLeaseInput);
    expect(foreignLease.status).toBe("granted");
    if (operation === "renew") await reserveCodexProjectAccount({ ...scoped,
      deps: { capacityStore, leaseStore: store, leaseMode: "exclusive", now } });
    const deps = { capacityStore, leaseStore: store as WorkerAccountLeaseStore, leaseMode: "exclusive" as const, now };
    const drift = () => {
      sessionHomeProfile.sessionId = "TEST-mutated-session";
      Object.assign(scoped.manifest, { jobId: foreign.manifest.jobId, jobRootDir: foreign.manifest.jobRootDir });
      Object.assign(scoped.launch.config, { authRootDir: foreign.launch.config.authRootDir });
      deps.leaseStore = foreignStore;
    };
    deps.leaseStore = {
      acquire: async input => { const result = await store.acquire(input); if (operation === "acquire") drift(); return result; },
      renew: async input => { const result = await store.renew(input); if (operation === "renew") drift(); return result; },
      release: input => store.release(input),
    };
    await expect(reserveCodexProjectAccount({ ...scoped, deps })).rejects.toThrow("project_control_reserved_launch_source_changed");
    await expect(readFile(originalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.acquire({ accountId: "account-a", ownerId: "TEST-new-owner", ttlMs: 60_000, now }))
      .resolves.toMatchObject({ status: "granted" });
    expect(await readFile(foreignPath, "utf8")).toBe(foreignBytes);
    expect(await foreignStore.acquire(foreignLeaseInput)).toEqual(foreignLease);
  });
});
