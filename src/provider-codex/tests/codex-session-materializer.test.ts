import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { sessionArtifactFromCodexAuthJson } from "../codex-auth-json-codec";
import { CodexWorkerCacheSessionPoolMaterializer } from "../codex-session-materializer";

const input = () => ({
  session: sessionArtifactFromCodexAuthJson(JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id" },
  })),
  redactor: new DefaultRedactor(),
});

describe("worker-cache home preparation", () => {
  it("prepares the home before auth/config writes, re-prepares on every reuse and preserves the prepared cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-prepare-home-test-"));
    let preparationCount = 0;
    const materializer = new CodexWorkerCacheSessionPoolMaterializer({
      cacheKey: "synthetic-home-preparation",
      slots: 1,
      rootDir,
      configToml: "synthetic_config = true\n",
      prepareHome: async (codexHome) => {
        preparationCount += 1;
        expect((await stat(codexHome)).isDirectory()).toBe(true);
        if (preparationCount === 1) expect(await readdir(codexHome)).toEqual([]);
        await mkdir(join(codexHome, "plugins", "cache"), { recursive: true });
        await writeFile(join(codexHome, "plugins", "cache", "prepared"), "synthetic-cache");
      },
    });
    try {
      const first = await materializer.materialize(input());
      const firstHome = first.codexHome;
      try {
        expect(JSON.parse(await readFile(join(firstHome, "auth.json"), "utf8")).tokens.access_token)
          .toBe("synthetic-access");
        expect(await readFile(join(firstHome, "config.toml"), "utf8")).toBe("synthetic_config = true\n");
      } finally {
        await first.release();
      }
      const reused = await materializer.materialize(input());
      try {
        expect(reused.codexHome).toBe(firstHome);
        // Preparation is idempotent and runs again on every reuse (resume after a host-side release).
        expect(preparationCount).toBe(2);
        expect(await readFile(join(reused.codexHome, "plugins", "cache", "prepared"), "utf8"))
          .toBe("synthetic-cache");
      } finally {
        await reused.release();
      }
    } finally {
      await materializer.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails without writing credentials and releases the pool and slot leases for a retry", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-prepare-home-retry-test-"));
    let preparationCount = 0;
    let preparedHome = "";
    const materializer = new CodexWorkerCacheSessionPoolMaterializer({
      cacheKey: "synthetic-home-retry",
      slots: 1,
      rootDir,
      configToml: "synthetic_config = true\n",
      prepareHome: async (codexHome) => {
        preparationCount += 1;
        preparedHome = codexHome;
        expect(await readdir(codexHome)).toEqual([]);
        if (preparationCount === 1) throw new Error("synthetic_preparation_failure");
      },
    });
    try {
      await expect(materializer.materialize(input())).rejects.toThrow("synthetic_preparation_failure");
      expect(preparationCount).toBe(1);
      expect(await readdir(preparedHome)).toEqual([]);
      const retried = await materializer.materialize(input());
      try {
        expect(preparationCount).toBe(2);
        expect(retried.codexHome).toBe(preparedHome);
        expect(await readFile(join(retried.codexHome, "config.toml"), "utf8")).toBe("synthetic_config = true\n");
      } finally {
        await retried.release();
      }
    } finally {
      await materializer.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
