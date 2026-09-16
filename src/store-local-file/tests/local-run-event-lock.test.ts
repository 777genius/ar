import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from
  "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withDirectoryLock } from
  "../run-events/adapters/local-run-event-lock";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("local run event directory lease", () => {
  it("keeps a long operation exclusive beyond the stale TTL", async () => {
    const fixture = await lockFixture();
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const first = withDirectoryLock(fixture.input, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      firstEntered();
      await release;
      active -= 1;
    });
    await entered;
    const heartbeatBefore = (await stat(fixture.input.lockPath)).mtimeMs;
    await delay(fixture.input.lockTtlMs * 3);
    expect((await stat(fixture.input.lockPath)).mtimeMs).toBeGreaterThan(
      heartbeatBefore,
    );
    const second = withDirectoryLock(fixture.input, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
    });
    await delay(fixture.input.lockTtlMs * 2);
    expect(maximumActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it("does not reclaim a stale lease owned by a live same-host process", async () => {
    const fixture = await lockFixture();
    await mkdir(fixture.input.lockPath, { mode: 0o700 });
    await writeOwner(fixture.input.lockPath, {
      token: "live-owner",
      pid: process.pid,
    });
    const old = new Date(Date.now() - 5_000);
    await utimes(fixture.input.lockPath, old, old);

    await expect(withDirectoryLock({
      ...fixture.input,
      lockAcquireTimeoutMs: 20,
    }, async () => undefined)).rejects.toThrow("test_lock_timeout");
    expect(JSON.parse(await readFile(
      join(fixture.input.lockPath, "owner.json"),
      "utf8",
    ))).toMatchObject({ token: "live-owner" });
  });

  it("recovers dead-owner and stale legacy locks", async () => {
    for (const owner of ["dead", "legacy"] as const) {
      const fixture = await lockFixture();
      await mkdir(fixture.input.lockPath, { mode: 0o700 });
      if (owner === "dead") {
        await writeOwner(fixture.input.lockPath, {
          token: "dead-owner",
          pid: 2_147_483_647,
        });
      } else {
        const old = new Date(Date.now() - 5_000);
        await utimes(fixture.input.lockPath, old, old);
      }
      let ran = false;
      await withDirectoryLock(fixture.input, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    }
  });

  it("recovers an abandoned ownerless reclaim claim", async () => {
    const fixture = await lockFixture();
    const claimPath = join(fixture.input.lockPath, ".reclaim");
    await mkdir(claimPath, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 5_000);
    await utimes(claimPath, old, old);
    await utimes(fixture.input.lockPath, old, old);

    let ran = false;
    await withDirectoryLock(fixture.input, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    await expect(access(fixture.input.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never lets a stale owner's finally delete its successor", async () => {
    const fixture = await lockFixture();
    await withDirectoryLock(fixture.input, async () => {
      await rm(fixture.input.lockPath, { recursive: true });
      await mkdir(fixture.input.lockPath, { mode: 0o700 });
      await writeOwner(fixture.input.lockPath, {
        token: "successor",
        pid: process.pid,
      });
    });

    expect(JSON.parse(await readFile(
      join(fixture.input.lockPath, "owner.json"),
      "utf8",
    ))).toMatchObject({ token: "successor" });
  });

  it("unrefs and clears the heartbeat and releases after an action error", async () => {
    const fixture = await lockFixture();
    const originalSetTimeout = globalThis.setTimeout;
    let timer: NodeJS.Timeout | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout) => {
      timer = originalSetTimeout(handler, timeout);
      return timer;
    });
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const actionError = Object.assign(new Error("expected_action_failure"), {
      code: "EEXIST",
    });
    let actionCalls = 0;

    await expect(withDirectoryLock(fixture.input, async () => {
      actionCalls += 1;
      expect(timer?.hasRef()).toBe(false);
      throw actionError;
    })).rejects.toThrow("expected_action_failure");

    expect(actionCalls).toBe(1);
    expect(clear).toHaveBeenCalledWith(timer);
    await expect(access(fixture.input.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function lockFixture() {
  const root = await mkdtemp(join(tmpdir(), "local-run-event-lock-"));
  roots.push(root);
  return {
    input: {
      parentDir: root,
      lockPath: join(root, "events.lock"),
      lockTtlMs: 30,
      lockAcquireTimeoutMs: 1_000,
      lockPollMs: 5,
      timeoutError: "test_lock_timeout",
    },
  };
}

async function writeOwner(
  lockPath: string,
  input: { readonly token: string; readonly pid: number },
): Promise<void> {
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    v: 1,
    token: input.token,
    hostname: hostname(),
    pid: input.pid,
    acquiredAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
