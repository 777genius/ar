import { types } from "node:util";

const storagePoint = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs";
enum FullBackingMountRootKind { Path = "path" }
function held(): never { throw new Error("hosted_full_backing_mount_data_held"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) held();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.split(",").length || Object.keys(descriptors).sort().join(",") !== keys) held();
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) held();
    result[key] = descriptor.value;
  }
  return result;
}
function options(value: unknown): void {
  if (!Array.isArray(value) || types.isProxy(value) || value.length < 1 || value.length > 128 ||
      value.some(flag => typeof flag !== "string" || flag.length < 1 || flag.length > 256 || /[,\s\0]/.test(flag))) held();
}
/** DATA join only, not a seal, source grant or mount authority. The actual
 * interval supplies protected original collector JSON and current mountinfo,
 * then independently rejoins its named FD/device/inode and fresh host pulse.
 * Current FULL uses the whole ext4 loop root; no sibling/alias topology is
 * enrolled by accepting the collector's typed Path instead of a raw string. */
export function matchFullBackingStorageMountData(value: unknown, mountInfo: string) {
  const storage = object(value, "device,id,options,parent,point,root,superOptions"), root = object(storage.root, "kind,path");
  if (root.kind !== FullBackingMountRootKind.Path || root.path !== "/" || storage.point !== storagePoint ||
      typeof storage.device !== "string" || !/^7:(?:0|[1-9][0-9]{0,19})$/.test(storage.device) ||
      typeof storage.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(storage.id) ||
      typeof storage.parent !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(storage.parent)) held();
  options(storage.options); options(storage.superOptions);
  if (typeof mountInfo !== "string" || Buffer.byteLength(mountInfo) > 1024 * 1024 || !mountInfo.endsWith("\n")) held();
  const matches = mountInfo.trimEnd().split("\n").map(line => line.split(" ")).filter(fields => fields[4] === storage.point);
  const mount = matches[0], separator = mount?.indexOf("-") ?? -1;
  if (matches.length !== 1 || !mount || separator < 6 || mount.length !== separator + 4 ||
      !/^[1-9][0-9]{0,19}$/.test(mount[0] ?? "") || mount[2] !== storage.device || mount[3] !== root.path ||
      mount[separator + 1] !== "ext4") held();
  // Service namespace clones have distinct mount IDs/parents. Return the actual
  // local mount ID for the existing SAME namespace descriptor fdinfo rejoin.
  return Object.freeze({ point: storagePoint, device: storage.device, rootPath: "/", mountId: mount[0]! });
}
