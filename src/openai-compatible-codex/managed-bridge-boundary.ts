import { lstatSync } from "node:fs";

const managedHostPaths = [
  "/etc/subscription-runtime/storage-root",
  "/opt/subscription-runtime/managed-launcher/launch.mjs",
];

// Disable the packaged HTTP entrypoint on managed hosts until a launcher-owned
// bridge integration exists. This check grants no authorization or custody.
export function requireManagedBridgeBoundary(): void {
  for (const path of managedHostPaths) {
    try {
      // Inspect entries themselves so dangling symlinks also deny startup.
      lstatSync(path);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw new Error("openai_bridge_managed_host_inspection_failed");
    }
    throw new Error("openai_bridge_disabled_on_managed_host");
  }
}
