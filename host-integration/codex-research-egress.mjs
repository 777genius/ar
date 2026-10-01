#!/usr/bin/env node
// Host operator entrypoint. Observation is diagnostic, never launch authority.
const operation = process.argv[2];
if (['grant-owned-research', 'start-owned-research', 'status-owned-research', 'cancel-owned-research', 'revoke-owned-research'].includes(operation)) {
  try {
    const owner = await import('../dist/worker-codex/research-launch-owner.js');
    const lifecycle = await import('../dist/worker-codex/research-launch-lifecycle.js');
    const args = process.argv.slice(3);
    let result;
    if (operation === 'grant-owned-research' && args.length === 3) { owner.grantResearchLaunch(...args); }
    else if (operation === 'start-owned-research' && args.length === 2) { result = owner.startResearchLaunch(...args); }
    else if (operation === 'status-owned-research' && args.length === 1) { result = lifecycle.statusResearchLaunch(args[0]); }
    else if (operation === 'cancel-owned-research' && args.length === 1) { result = lifecycle.cancelResearchLaunch(args[0]); }
    else if (operation === 'revoke-owned-research' && args.length === 1) { owner.revokeResearchLaunch(args[0]); }
    else throw new Error();
    process.stdout.write(JSON.stringify(result ?? { operation, success: true }) + '\n');
  } catch {
    process.stderr.write('hosted_research_operator_action_failed\n'); process.exitCode = 1;
  }
} else if (operation === 'observe-launch') {
  try {
    const { observeResearchLaunch } = await import('./research-launch-observation.mjs');
    process.stdout.write(JSON.stringify(observeResearchLaunch(process.argv.slice(3))) + '\n');
  } catch {
    process.stderr.write('research_launch_observation_failed\n'); process.exitCode = 1;
  }
} else {
  // Existing finite private-grant CLI; grant-research JOB ROOT WORKSPACE | revoke JOB.
  await import('../dist/worker-codex/hosted-test-egress-cli.js');
}
