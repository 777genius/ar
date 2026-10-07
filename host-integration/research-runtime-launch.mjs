#!/usr/bin/env node
// Fixed closed initial-root operator service bootstrap. No environment admission.
import { normalizeResearchLaunchFailure } from '../dist/worker-codex/research-launch-diagnostics.js';
let phase = "imports";
try {
  if (process.argv.length !== 4) throw new Error();
  const { bindResearchRuntime, bindRegisteredResearchRuntime, researchCurrentStart, researchTerminalHandoffGuard, researchHandoffPublicationLease } = await import('../dist/worker-codex/research-launch-admission.js');
  const { researchRunConfig } = await import('../dist/worker-codex/research-launch-contract.js');
  const { runCodexGoal } = await import('../dist/worker-codex/codex-goal-runner.js');
  const { admitHostedTestEgress } = await import('../dist/worker-codex/hosted-test-egress-admission.js');
  phase = 'binding';
  const registered = researchCurrentStart(process.argv[2]).spec.registeredHandoff !== undefined;
  const spec = registered ? await bindRegisteredResearchRuntime(process.argv[2], process.argv[3])
    : bindResearchRuntime(process.argv[2], process.argv[3]);
  phase = 'goal-admission';
  const result = await runCodexGoal(researchRunConfig(spec.request), {
    ...(registered ? { assertTerminalHandoffPublicationAuthorized: researchTerminalHandoffGuard(process.argv[2], process.argv[3]),
      withTerminalHandoffPublicationAuthority: researchHandoffPublicationLease(process.argv[2], process.argv[3]) } : {}),
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
  const { legacyCode, cause, diagnostic } = normalizeResearchLaunchFailure(error);
  process.stderr.write(`hosted_research_runtime_launch_denied:${phase}:${legacyCode}:${cause}:${diagnostic}\n`);
  process.exitCode = 70;
}
