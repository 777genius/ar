import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const deny = () => { throw new Error('managed launcher: profile denied'); };
export const socketFence = '-/run/systemd/private -/run/dbus -/run/user -/var/lib/subscription-runtime-host-policy -/run/docker.sock -/run/containerd/containerd.sock -/run/podman/podman.sock';
export const bootstrapCaps = 'CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP';
export async function requireTrustedExecutable(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (current === path ? !info.isFile() : !info.isDirectory())) deny();
    if (current === '/') return;
  }
}

export function profileProperties() {
  return ['AmbientCapabilities=', 'PrivateDevices=yes', 'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'RestrictSUIDSGID=yes',
    `CapabilityBoundingSet=${bootstrapCaps}`,
    `InaccessiblePaths=${socketFence}`];
}
