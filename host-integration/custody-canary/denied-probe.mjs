// Import/initialization failures do not count as an admission rejection.
// Only the production operatorSession call is inside the rejection catch.
import { HostedReadonlyHostKernel } from '/opt/custody-canary/runtime/dist/worker-codex/hosted-readonly-host-kernel.js';

const kernel = new HostedReadonlyHostKernel();
try {
  kernel.operatorSession();
  process.stderr.write('outside_supervisor_unexpectedly_admitted\n');
  process.exitCode = 72;
} catch (error) {
  if (error instanceof Error && error.message === 'hosted_custody_kernel_evidence_invalid') {
    process.stderr.write('outside_supervisor_operator_session_denied\n');
    process.exitCode = 73;
  } else {
    process.stderr.write('outside_supervisor_probe_unexpected_failure\n');
    process.exitCode = 74;
  }
}
