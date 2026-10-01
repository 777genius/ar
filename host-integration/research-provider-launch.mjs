#!/usr/bin/env node
try {
  if (process.argv.length !== 4) throw new Error();
  const { runResearchProviderService } = await import('../dist/worker-codex/research-provider-service.js');
  await runResearchProviderService(process.argv[2], process.argv[3]);
} catch {
  process.stderr.write('hosted_research_provider_launch_denied\n');
  process.exitCode = 70;
}
