import { lstatSync } from "node:fs";

export const managedHostMarkerPath = "/opt/subscription-runtime/managed-launcher/managed-host";

type Marker = { readonly rdev: number; isCharacterDevice(): boolean };

/** Routing cue only, not proof of confinement or launch authorization. */
export function assertManagedHostEntrypointAllowed(
  platform: NodeJS.Platform = process.platform,
  inspect: (path: string) => Marker = lstatSync,
): void {
  if (platform !== "linux") return;
  let marker: Marker;
  try {
    marker = inspect(managedHostMarkerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // lstat deliberately refuses symlinks, including links pointing at /dev/null.
  if (marker.isCharacterDevice() && marker.rdev === 259) return;
  throw new Error("Managed host requires root-owned launcher; submit through Host Jobs API");
}
