import { createHash } from 'node:crypto';

export const unitFor = (jobId) => {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(jobId)) throw new Error('invalid jobId');
  return `subscription-job-${createHash('sha256').update(jobId).digest('hex')}.service`;
};
export function validateStart(request) {
  unitFor(request.jobId);
  if (!/^[a-f0-9]{32}$/.test(request.machineId)) throw new Error('invalid machineId');
  if (!Array.isArray(request.argv) || !request.argv.length || !request.argv[0].startsWith('/') || request.argv.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('absolute executable and string argv required');
  if (typeof request.cwd !== 'string' || !request.cwd.startsWith('/') || request.cwd.includes('\0')) throw new Error('absolute cwd required');
  for (const [key, max] of [['runtimeSeconds', 86400], ['stopSeconds', 300], ['memoryMiB', 1048576], ['tasksMax', 65536], ['cpuPercent', 100000]]) {
    if (!Number.isInteger(request[key]) || request[key] < 1 || request[key] > max) throw new Error(`invalid ${key}`);
  }
}
export const fingerprint = request => createHash('sha256').update(JSON.stringify([
  request.jobId, request.machineId, request.argv, request.cwd, request.runtimeSeconds,
  request.stopSeconds, request.memoryMiB, request.tasksMax, request.cpuPercent,
])).digest('hex');
