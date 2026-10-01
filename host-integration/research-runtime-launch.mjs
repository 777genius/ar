#!/usr/bin/env node
// Fixed closed initial-root operator service bootstrap. No environment admission.
try {
  if (process.argv.length !== 4) throw new Error();
  const { bindResearchRuntime } = await import('../dist/worker-codex/research-launch-admission.js');
  const { researchRunConfig } = await import('../dist/worker-codex/research-launch-contract.js');
  const { runCodexGoal } = await import('../dist/worker-codex/codex-goal-runner.js');
  const spec = bindResearchRuntime(process.argv[2], process.argv[3]);
  const result = await runCodexGoal(researchRunConfig(spec.request));
  process.exitCode = result.status === 'completed' ? 0 : 1;
} catch {
  process.stderr.write('hosted_research_runtime_launch_denied\n');
  process.exitCode = 70;
}
