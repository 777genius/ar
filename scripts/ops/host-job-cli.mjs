#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { hostTransport } from './host-job-transport.mjs';
import { readRequest } from '../../host-integration/host-jobs/read-request.mjs';

export async function hostJobCli(args, input, output, factory = hostTransport) {
  const [host, machineId, socketDir] = args;
  if (args.length !== 3 || !socketDir?.startsWith('/')) throw new Error('usage: host-job-cli HOST MACHINE_ID ABSOLUTE_SOCKET_DIR < request.json');
  const request = await readRequest(input);
  if (request.machineId !== undefined && request.machineId !== machineId) throw new Error('machine identity mismatch');
  const transport = factory({ host, machineId, socketDir });
  const result = await transport.request({ ...request, machineId });
  output.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  hostJobCli(process.argv.slice(2), process.stdin, process.stdout).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
