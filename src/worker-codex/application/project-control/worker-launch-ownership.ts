import { isAbsolute } from "node:path";

/** Concrete relative files or explicit trailing-slash directory boundaries. */
export function isSafeWorkerOwnedPath(value: string, allowDirectory: boolean): boolean {
  if (!value || isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.split("/");
  if (allowDirectory && parts.at(-1) === "") parts.pop();
  return parts.length > 0 && parts.every(part => part !== "" && part !== "." && part !== "..");
}

/** Shared finite ingress/schema validation, with no external runtime dependency. */
export function validNarrowWorkerOwnedPaths(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 &&
    value.every(path => typeof path === "string" && Buffer.byteLength(path) <= 4096 &&
      isSafeWorkerOwnedPath(path, true) && !/[\*?\[\]{}]/u.test(path)) &&
    new Set(value).size === value.length && Buffer.byteLength(JSON.stringify(value)) <= 49152;
}

/** Exact files or trailing-slash directories; never sibling-prefix matching. */
export function workerLaunchOwnsPath(
  launch: { readonly ownedPaths: readonly string[] }, path: string,
): boolean {
  return isSafeWorkerOwnedPath(path, true) && launch.ownedPaths.some(ownedPath =>
    isSafeWorkerOwnedPath(ownedPath, true) && (ownedPath.endsWith("/")
      ? path.startsWith(ownedPath) : !path.endsWith("/") && path === ownedPath));
}
