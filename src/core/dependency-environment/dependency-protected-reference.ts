import type { DependencyTreeIdentity } from "./dependency-workspace";

// Neutral data validators shared by custody and generation continuity. No
// observation, persistence, authorization or provider dependency belongs here.
export type DependencyProtectedReference = {
  readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string;
};
const digest = /^[a-f0-9]{64}$/;
const decimal = /^(?:0|[1-9][0-9]{0,19})$/;

export function isDependencyCustodyObject(value: unknown, keys: string): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).length !== keys.split(",").length || Object.keys(value).sort().join(",") !== keys) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => Object.hasOwn(d, "value") && d.enumerable);
}
export function isDependencyCustodyCanonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") && value !== "/" &&
    !/[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]{12,}|Bearer\s/i.test(value) &&
    value.split("/").slice(1).every(p => p.length > 0 && p !== "." && p !== "..");
}
export function isDependencyCustodyTreeIdentity(value: unknown): value is DependencyTreeIdentity {
  return isDependencyCustodyObject(value, "dev,ino") && typeof value.dev === "string" && decimal.test(value.dev) &&
    typeof value.ino === "string" && /^[1-9][0-9]{0,19}$/.test(value.ino);
}
export function isDependencyProtectedReference(value: unknown): value is DependencyProtectedReference {
  return isDependencyCustodyObject(value, "identity,path,sha256") && isDependencyCustodyCanonicalPath(value.path) && isDependencyCustodyTreeIdentity(value.identity) &&
    typeof value.sha256 === "string" && digest.test(value.sha256);
}
export function sameDependencyProtectedReference(a: DependencyProtectedReference, b: DependencyProtectedReference): boolean {
  return a.path === b.path && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino && a.sha256 === b.sha256;
}
