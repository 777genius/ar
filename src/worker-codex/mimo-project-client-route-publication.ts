import { mimoProjectClientMaxRouteBytes } from "./mimo-project-client-route-limits";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseMimoProjectClientRoutes, readMimoProjectClientRoutes, type MimoProjectClientRoute } from "./mimo-project-bridge-client";

const defaultPath = () => join(homedir(), ".config", "subscription-runtime", "mimo-project-routes.json");
function optionalStat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function sameIdentity(left: Stats, right: Stats | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}
function trustedDirectories(path: string, create = false): void {
  const uid = process.getuid?.();
  if (uid === undefined || resolve(path) !== path) throw new Error("mimo_project_client_config_untrusted");
  if (path !== "/") trustedDirectories(dirname(path), create);
  let stat = optionalStat(path);
  if (!stat && create) {
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022))
    throw new Error("mimo_project_client_config_untrusted");
}
function sameRoute(left: MimoProjectClientRoute, right: MimoProjectClientRoute): boolean {
  return left.projectId === right.projectId && left.workstreamId === right.workstreamId &&
    left.host === right.host && left.machineId === right.machineId && left.socketDir === right.socketDir;
}

/** Operator-only local metadata publication. An existing lock is never stolen;
 * interrupted publication can be reconciled by rereading the same route. */
export function configureMimoProjectClientRoute(route: unknown, path = defaultPath()): Readonly<{ ok: true; changed: boolean; projectId: string; workstreamId: string }> {
  const selected = parseMimoProjectClientRoutes({ schemaVersion: 1, routes: [route] })[0]!;
  if (resolve(path) !== path) throw new Error("mimo_project_client_config_invalid");
  const parent = dirname(path);
  trustedDirectories(parent, true);
  const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const parentIdentity = fstatSync(directory);
  const lockPath = path + ".publication-lock";
  let lock: number | undefined, lockIdentity: Stats | undefined;
  let temporary: string | undefined, temporaryIdentity: Stats | undefined;
  const assertParent = () => {
    trustedDirectories(parent);
    if (!sameIdentity(parentIdentity, optionalStat(parent))) throw new Error("mimo_project_client_config_changed");
  };
  try {
    assertParent();
    try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("mimo_project_client_config_locked");
      throw error;
    }
    lockIdentity = fstatSync(lock);
    writeFileSync(lock, JSON.stringify({ schemaVersion: 1, publicationId: randomUUID() }) + "\n");
    fsyncSync(lock); fsyncSync(directory);
    const before = optionalStat(path);
    if (before && (!before.isFile() || before.isSymbolicLink() || ![0, process.getuid!()].includes(before.uid) || before.nlink !== 1 || (before.mode & 0o077)))
      throw new Error("mimo_project_client_config_untrusted");
    const routes = before ? readMimoProjectClientRoutes(path) : [];
    const existing = routes.find(row => row.projectId === selected.projectId && row.workstreamId === selected.workstreamId);
    const result = { ok: true as const, projectId: selected.projectId, workstreamId: selected.workstreamId };
    if (existing) {
      if (!sameRoute(existing, selected)) throw new Error("mimo_project_client_route_conflict");
      return { ...result, changed: false };
    }
    const updated = parseMimoProjectClientRoutes({ schemaVersion: 1, routes: [...routes, selected] });
    const bytes = JSON.stringify({ schemaVersion: 1, routes: updated }) + "\n";
    if (Buffer.byteLength(bytes) > mimoProjectClientMaxRouteBytes) throw new Error("mimo_project_client_config_invalid");
    temporary = path + ".publication-" + randomUUID();
    const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { temporaryIdentity = fstatSync(file); writeFileSync(file, bytes); fsyncSync(file); }
    finally { closeSync(file); }
    assertParent();
    const current = optionalStat(path);
    if (before ? !sameIdentity(before, current) || before.size !== current?.size || before.mtimeMs !== current?.mtimeMs || before.ctimeMs !== current?.ctimeMs : current !== undefined)
      throw new Error("mimo_project_client_config_changed");
    if (!sameIdentity(lockIdentity, optionalStat(lockPath)) || !sameIdentity(temporaryIdentity, optionalStat(temporary)))
      throw new Error("mimo_project_client_config_changed");
    renameSync(temporary, path); temporary = undefined;
    fsyncSync(directory);
    return { ...result, changed: true };
  } finally {
    try {
      assertParent();
      if (temporary && temporaryIdentity && sameIdentity(temporaryIdentity, optionalStat(temporary))) unlinkSync(temporary);
      if (lockIdentity && sameIdentity(lockIdentity, optionalStat(lockPath))) { unlinkSync(lockPath); fsyncSync(directory); }
    } finally { if (lock !== undefined) closeSync(lock); closeSync(directory); }
  }
}

export function configureMimoProjectClientRouteFromFile(inputPath: string): ReturnType<typeof configureMimoProjectClientRoute> {
  const routes = readMimoProjectClientRoutes(inputPath);
  if (routes.length !== 1) throw new Error("mimo_project_client_config_invalid");
  return configureMimoProjectClientRoute(routes[0]);
}
