import { relative, sep } from "node:path";

export function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === keys.length &&
    keys.every((_key, index) => actual[index] === expected[index]);
}

export function inside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

export function safeChangedPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") &&
    path.split(/[\\/]/).every((part) =>
      part !== "" && part !== "." && part !== "..");
}

export function gitObject(value: string): boolean {
  return /^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(value);
}

export function matchesPrefix(
  jobId: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.length > 0 && prefixes.some((prefix) =>
    prefix.length > 0 && jobId.startsWith(prefix));
}
