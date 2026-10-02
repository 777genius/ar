#!/usr/bin/env node
// Fixed closed initial-root operator service bootstrap. No environment admission.
let phase = "imports";
try {
  if (process.argv.length !== 4) throw new Error();
  const { bindResearchRuntime } = await import('../dist/worker-codex/research-launch-admission.js');
  const { researchRunConfig } = await import('../dist/worker-codex/research-launch-contract.js');
  const { runCodexGoal } = await import('../dist/worker-codex/codex-goal-runner.js');
  const { admitHostedTestEgress } = await import('../dist/worker-codex/hosted-test-egress-admission.js');
  phase = 'binding';
  const spec = bindResearchRuntime(process.argv[2], process.argv[3]);
  phase = 'goal-admission';
  const result = await runCodexGoal(researchRunConfig(spec.request), {
    admitProviderEgress: async input => {
      phase = 'egress-admission';
      const policy = await admitHostedTestEgress(input);
      phase = 'goal-after-egress';
      return policy;
    },
  });
  process.exitCode = result.status === 'completed' ? 0 : 1;
} catch (error) {
  // Finite observations only. Never expose arbitrary errors, paths or stderr.
  const known = ['hosted_research_launch_denied', 'checkpoint_publisher_required',
    'terminal_checkpoint_mutex_busy_owner_unproven', 'terminal_checkpoint_job_fenced',
    'Refusing to hide nonempty legacy scratch directory', 'Scratch bind target busy',
    'Unknown mount at scratch target', 'Prepared scratch source identity changed'];
  const code = known.indexOf(error?.message);
  process.stderr.write(`hosted_research_runtime_launch_denied:${phase}:${code < 0 ? 'unclassified' : code}\n`);
  process.exitCode = 70;
}
