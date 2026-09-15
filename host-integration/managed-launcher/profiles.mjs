import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const deny = () => { throw new Error('managed launcher: profile denied'); };
// Read-only mounts do not prevent socket writes. Hide every journal endpoint
// (including /dev/log aliases); inherited provider pipes remain usable.
export const socketFence = '-/run/systemd/private -/run/systemd/journal -/dev/log -/run/dbus -/run/user -/var/lib/subscription-runtime-host-policy -/run/docker.sock -/run/containerd/containerd.sock -/run/podman/podman.sock';
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
  // ProtectKernelTunables/ProtectKernelLogs create locked submounts below
  // /proc before ExecStart. Linux then refuses the child user namespace's
  // private procfs mount. The payload instead enters its private PID/user
  // namespace and drops every capability before untrusted code executes.
  return ['AmbientCapabilities=', 'PrivateDevices=yes', 'ProtectKernelModules=yes', 'RestrictSUIDSGID=yes',
    `CapabilityBoundingSet=${bootstrapCaps}`,
    `InaccessiblePaths=${socketFence}`];
}
