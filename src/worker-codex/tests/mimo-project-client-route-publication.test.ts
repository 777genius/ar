import { mimoProjectClientMaxRoutes, mimoProjectClientMaxRouteBytes } from "../mimo-project-client-route-limits";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureMimoProjectClientRoute } from "../mimo-project-client-route-publication";
import { parseMimoProjectClientRoutes, readMimoProjectClientRoutes, type MimoProjectClientRoute } from "../mimo-project-bridge-client";
import { runMimoProjectClientCli } from "../mimo-project-client-cli";

const roots: string[] = [];
function fixture(): { root: string; path: string } {
  // The production reader rejects writable shared /tmp ancestry. Allocate only
  // synthetic metadata under our protected user home, never a real route file.
  const root = realpathSync(mkdtempSync(join(homedir(), ".TEST-mimo-route-")));
  chmodSync(root, 0o700); roots.push(root);
  return { root, path: join(root, "config", "mimo-project-routes.json") };
}
const route: MimoProjectClientRoute = { projectId: "test-project", workstreamId: "test-work", host: "TEST-worker", machineId: "a".repeat(32), socketDir: "/private/tmp/TEST-sockets" };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("publishes readable private metadata, preserves other workstreams and makes exact repeats a no-op", () => {
  const { path } = fixture();
  expect(configureMimoProjectClientRoute(route, path)).toMatchObject({ ok: true, changed: true });
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
  const before = lstatSync(path), bytes = readFileSync(path, "utf8");
  expect(configureMimoProjectClientRoute(route, path)).toMatchObject({ changed: false });
  expect(readFileSync(path, "utf8")).toBe(bytes); expect(lstatSync(path).ino).toBe(before.ino);
  const other = { ...route, projectId: "test-other" };
  configureMimoProjectClientRoute(other, path);
  expect(readMimoProjectClientRoutes(path)).toEqual([route, other]);
  expect(existsSync(path + ".publication-lock")).toBe(false);
});

it("publishes the 257th route without losing the existing 256 routes", () => {
  const { root, path } = fixture(); mkdirSync(join(root, "config"), { mode: 0o700 });
  const routes = Array.from({ length: 256 }, (_, index) => ({ ...route, workstreamId: `test-work-${index}` }));
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, routes }), { mode: 0o600 });
  const next = { ...route, workstreamId: "test-work-256" };
  expect(configureMimoProjectClientRoute(next, path)).toMatchObject({ ok: true, changed: true });
  expect(readMimoProjectClientRoutes(path)).toEqual([...routes, next]);
});

it("adds a route to a near-limit catalog without spending the reader budget on formatting", () => {
  const { root, path } = fixture(); mkdirSync(join(root, "config"), { mode: 0o700 });
  const candidates = Array.from({ length: mimoProjectClientMaxRoutes - 1 }, (_, index) => ({ ...route,
    workstreamId: `test-work-${index}`, socketDir: route.socketDir + "/" + "x".repeat(62) }));
  const pretty = (routes: readonly MimoProjectClientRoute[]) => JSON.stringify({ schemaVersion: 1, routes }, null, 2) + "\n";
  let count = 1;
  while (count < candidates.length && Buffer.byteLength(pretty(candidates.slice(0, count + 1))) <= mimoProjectClientMaxRouteBytes) count++;
  const routes = candidates.slice(0, count);
  const original = pretty(routes);
  expect(Buffer.byteLength(original)).toBeLessThanOrEqual(mimoProjectClientMaxRouteBytes);
  writeFileSync(path, original, { mode: 0o600 });
  expect(readMimoProjectClientRoutes(path)).toEqual(routes);
  const next = { ...route, workstreamId: "test-next", socketDir: routes[0]!.socketDir };
  expect(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, routes: [...routes, next] }, null, 2) + "\n")).toBeGreaterThan(mimoProjectClientMaxRouteBytes);
  expect(configureMimoProjectClientRoute(next, path)).toMatchObject({ ok: true, changed: true });
  expect(lstatSync(path).size).toBeLessThanOrEqual(mimoProjectClientMaxRouteBytes);
  expect(readMimoProjectClientRoutes(path)).toEqual([...routes, next]);
  expect(existsSync(path + ".publication-lock")).toBe(false);
});

it("retains the finite route-count bound and preserves a full catalog when another route is refused", () => {
  const { root, path } = fixture(); mkdirSync(join(root, "config"), { mode: 0o700 });
  const routes = Array.from({ length: mimoProjectClientMaxRoutes }, (_, index) => ({ ...route, workstreamId: `test-work-${index}` }));
  const original = JSON.stringify({ schemaVersion: 1, routes });
  expect(Buffer.byteLength(original)).toBeLessThan(mimoProjectClientMaxRouteBytes);
  writeFileSync(path, original, { mode: 0o600 }); const before = lstatSync(path);
  expect(readMimoProjectClientRoutes(path)).toEqual(routes);
  const next = { ...route, workstreamId: "test-over-limit" };
  expect(() => parseMimoProjectClientRoutes({ schemaVersion: 1, routes: [...routes, next] })).toThrow("config_invalid");
  expect(() => configureMimoProjectClientRoute(next, path)).toThrow("config_invalid");
  expect(readFileSync(path, "utf8")).toBe(original); expect(lstatSync(path).ino).toBe(before.ino);
  expect(existsSync(path + ".publication-lock")).toBe(false);
});

it("refuses oversized protected reads and oversized publication without replacing the catalog", () => {
  const { path } = fixture(); configureMimoProjectClientRoute(route, path);
  const original = readFileSync(path, "utf8"), before = lstatSync(path);
  expect(() => configureMimoProjectClientRoute({ ...route, workstreamId: "test-too-large", socketDir: "/" + "x".repeat(mimoProjectClientMaxRouteBytes) }, path)).toThrow("config_invalid");
  expect(readFileSync(path, "utf8")).toBe(original); expect(lstatSync(path).ino).toBe(before.ino);
  expect(existsSync(path + ".publication-lock")).toBe(false);
  writeFileSync(path, original + " ".repeat(mimoProjectClientMaxRouteBytes + 1 - Buffer.byteLength(original)));
  expect(lstatSync(path).size).toBe(mimoProjectClientMaxRouteBytes + 1);
  expect(() => readMimoProjectClientRoutes(path)).toThrow("config_untrusted");
});

it("refuses conflicting authority instead of replacing the original transport", () => {
  const { path } = fixture(); configureMimoProjectClientRoute(route, path);
  const bytes = readFileSync(path, "utf8");
  expect(() => configureMimoProjectClientRoute({ ...route, machineId: "b".repeat(32) }, path)).toThrow("route_conflict");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(existsSync(path + ".publication-lock")).toBe(false);
});

it("fails boundedly on another publisher's lock without deleting unknown ownership or losing their update", () => {
  const { path } = fixture(); configureMimoProjectClientRoute(route, path);
  const lockPath = path + ".publication-lock", retained = "TEST unknown owner\n";
  writeFileSync(lockPath, retained, { mode: 0o600 }); const identity = lstatSync(lockPath);
  expect(() => configureMimoProjectClientRoute({ ...route, projectId: "test-second" }, path)).toThrow("config_locked");
  expect(readFileSync(lockPath, "utf8")).toBe(retained); expect(lstatSync(lockPath).ino).toBe(identity.ino);
  expect(readMimoProjectClientRoutes(path)).toEqual([route]);
});

it("rejects symlink destinations, writable metadata and untrusted parent directories without touching their targets", () => {
  const { root, path } = fixture(); mkdirSync(join(root, "config"), { mode: 0o700 });
  const foreign = join(root, "TEST-foreign.json"), bytes = "TEST preserve foreign bytes";
  writeFileSync(foreign, bytes, { mode: 0o600 }); symlinkSync(foreign, path);
  expect(() => configureMimoProjectClientRoute(route, path)).toThrow("config_untrusted");
  expect(readFileSync(foreign, "utf8")).toBe(bytes); rmSync(path);
  configureMimoProjectClientRoute(route, path); chmodSync(path, 0o644);
  expect(() => configureMimoProjectClientRoute({ ...route, projectId: "test-new" }, path)).toThrow("config_untrusted");
  chmodSync(path, 0o600); chmodSync(join(root, "config"), 0o777);
  expect(() => configureMimoProjectClientRoute(route, path)).toThrow("config_untrusted");
});

it("validates routes before effects and rejects caller command/credential bags", () => {
  const { path } = fixture();
  expect(() => configureMimoProjectClientRoute({ ...route, credentials: "TEST-never-persist" }, path)).toThrow("config_invalid");
  expect(existsSync(join(path, ".."))).toBe(false);
  const output: string[] = [];
  expect(runMimoProjectClientCli(["--configure-route", "/TEST/absent", "--unsafe"], bytes => output.push(bytes))).toBe(1);
  expect(JSON.parse(output[0]!)).toEqual({ ok: false, error: "mimo_project_client_command_invalid" });
});
