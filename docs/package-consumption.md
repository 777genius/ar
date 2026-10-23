# Package Consumption

Use the published GitHub Packages artifact:

```ini
@vioxen:registry=https://npm.pkg.github.com
```

CI consumers should provide a token with package read access through their
environment, for example `NODE_AUTH_TOKEN` or the job `GITHUB_TOKEN`. Do not
commit package tokens to `.npmrc`.

```bash
npm install @vioxen/subscription-runtime
```

Use the version published by the intended
[GitHub Release](https://github.com/777genius/ar/releases).
Do not copy a version from an arbitrary `main` checkout: the release tag pins
the package manifest and artifact that were actually published.

Production services should commit their lockfile. The lockfile pins the exact
package artifact that was installed. To pull a newer published version:

```bash
npm update @vioxen/subscription-runtime
```

Then rebuild and commit the lockfile.

## First Run Without Provider Credentials

This example uses the published testing fakes to exercise runtime admission,
session refresh, writeback and task execution without a provider CLI, account,
network call or paid model invocation. Save it as `smoke.ts` in an ESM consumer
project (`"type": "module"` in `package.json`):

```ts
import assert from "node:assert/strict";
import { createSubscriptionRuntime } from "@vioxen/subscription-runtime/core";
import {
  InMemorySessionStore,
  makeFakeArtifact,
  makeFakeRuntimeDeps,
} from "@vioxen/subscription-runtime/testing/fakes";

const store = new InMemorySessionStore();
store.seed({
  providerInstanceId: "smoke-account",
  artifact: makeFakeArtifact("session-v1"),
});
const runtime = createSubscriptionRuntime(makeFakeRuntimeDeps({ store }));
const result = await runtime.refreshThenRunTask({
  providerInstanceId: "smoke-account",
  task: { kind: "review", prompt: "installation smoke check" },
  runContext: {
    runId: "smoke-run",
    attempt: 1,
    abortSignal: new AbortController().signal,
  },
});
const stored = await store.read({
  providerInstanceId: "smoke-account",
  expectedProviderId: "fake",
  purpose: "health-check",
});
assert.equal(result.status, "completed");
assert.equal(stored?.generation, 2);
console.log({ status: result.status, generation: stored?.generation });
```

With the development Node.js profile from the README, run `node smoke.ts`.
The expected result is `{ status: 'completed', generation: 2 }`. Older Node.js
consumers can compile the example with their normal TypeScript build.

This verifies the package and fake-backed runtime path. To verify a real
provider, use the [minimal Codex worker](../README.md#minimal-codex-worker) or
the [public task runner](agent-runtime-task-bridge.md), with an authenticated
account and a disposable workspace. The [capability matrix](provider-capabilities.md)
distinguishes supported backends and goal modes.

## Build A Local Package From Source

Public source can be evaluated before setting up GitHub Packages access:

```bash
git clone https://github.com/777genius/ar.git
cd ar
npm ci
npm run build
npm pack
```

Install the emitted `.tgz` in a separate consumer project with
`npm install /absolute/path/to/the-emitted-package.tgz`. The source checkout's
version is an evaluation artifact; use a tagged release and committed consumer
lockfile for production. `npm run check:packed-consumer` verifies the packaged
ESM and TypeScript entrypoints from an external consumer.

## Release Source And Package Identity

The package version is the contract consumed by host apps. When a host app needs
new public exports, publish the new `@vioxen/subscription-runtime` version
first, then update the host app dependency and lockfile from the published
artifact.

The public source and release history for this repository are
[777genius/ar](https://github.com/777genius/ar). Its existing package identity
is `@vioxen/subscription-runtime`; the GitHub repository name and npm scope do
not need to match. A scope rename would require a separate consumer migration.

Release rules:

- release tags identify the reviewed source and the published package manifest;
- if a mirror is used, verify that it contains the same tagged commit and artifact;
- consumers should never pin a floating branch for production dependency
  resolution.
