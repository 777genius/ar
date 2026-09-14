import { readFile } from 'node:fs/promises';

interface ManagedLaunchKernelProbe {
  readonly read?: (path: string) => Promise<string>;
  readonly uid?: () => number;
  readonly gid?: () => number;
}

/** Read-only consumer proof of the launcher's mapped host-root identity.
 * Environment markers are routing data, never proof of launcher admission.
 */
export async function requireManagedLaunchKernelProof(probe: ManagedLaunchKernelProbe = {}): Promise<void> {
  const uid = probe.uid ?? (() => process.geteuid?.() ?? -1);
  const gid = probe.gid ?? (() => process.getegid?.() ?? -1);
  const reject = () => new Error('Managed host requires root-owned launcher: invalid user namespace');
  if (uid() !== 65532 || gid() !== 65532) throw reject();
  const read = probe.read ?? (path => readFile(path, 'utf8'));
  const maps = await Promise.all([read('/proc/self/uid_map'), read('/proc/self/gid_map')]);
  // Exactly one mapping: namespace identity 65532 maps to host root, length 1.
  if (maps.some(map => !/^\s*65532[ \t]+0[ \t]+1\s*$/.test(map))) throw reject();
}
