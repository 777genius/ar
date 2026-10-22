# Hosted Runtime issuers

Private Runtime Host feature. It is not a published capability, not a Get Modular graph node and not adopted as a shared package: it is two
operator-run issuers plus the deterministic helpers they need. Consumer Module Standard classification: feature-local helpers of the Host
(`worker-codex`), adoption pending/not claimed; nothing here changes a module boundary or capability contract.

## What it issues

| Issuer | Module | Output | Receipt |
|---|---|---|---|
| Stage curator | `worker-codex/hosted-runtime-stage-curator.ts` | `codex-readonly-stages/<SHA256(runtimeDirectory)>.json` | `issuer-receipts/runtime_stage-<bootId>-<stageSha256>.json` |
| Collector-profile issuer | `worker-codex/hosted-fd-collector-profile-issuer.ts` | `ordinary-installations/<operationId>.profile.json` | `issuer-receipts/fd_collector_profile-<bootId>-<profileSha256>.json` |

The receipt name is `issuerReceiptPathFor(kind, bootId, outputSha256)` for writers and readers. The boot is in the name and in the bytes: the stage record under `/run` is
recreated after a reboot with the same digest, so a second boot's receipt is a new file instead of a collision, and a reader that derives the current boot's name is never
handed an old-boot receipt. The issuers' own modules and the mechanisms they depend on are required artifacts of the qualification manifest
(`qualificationRequiredArtifacts`), so an admitted source packet cannot omit the code that issues authority. The profile issuer refuses unless the pinned `ss` reports iproute2 6.1.x
(`assertSsRendererVersion`) before it qualifies the renderer behaviourally.

Operator entry: `worker-codex/hosted-runtime-issuer-cli.ts` (`curate-stage`, `issue-profile`). Both assert the admitted operator
(`assertHostedActivationOperator`), publish create-once through `createReadonlyPrivateRecordOnce` under private directories
(`ensurePrivateDirectory`) and are idempotent for identical bytes and conflicting for anything else. Nothing is overwritten.

## Contracts

* `runtimeManifestSha256` = SHA-256 of the exact bytes of the admitted `ordinary-qualification-source.json` = the candidate's `sourceScopeSha256`.
  Readers compare 64 hex digits only; the issuer and `verifyStageRecord` enforce the equality.
* `deriveQualificationSourceScope` is the one canonical derivation of that manifest (sorted, `"\n"`-terminated, closure of literal relative imports and
  self-package specifiers). A load it cannot see (non-literal `import()`/`require()`, `createRequire`) or an unmeasured third-party package refuses the
  derivation with the exact file, kind and line. The refusal is the supported answer: nothing is accepted by widening the scan.
* Receipt (closed, canonical): `schemaVersion, kind, issuerModuleSha256, bootId, runtimeDirectory, runtimeSha, sourceScopeSha256, operationId, outputPath, outputSha256`.
  `verifyIssuerReceipt` compares EVERY field with an expectation the reader derives itself: the issuer module digest comes from the immutable release file
  (`issuerModuleRelativePath`), the output path and digest from the record, the operation from the funded packet, the boot from `/proc`. The issuer refuses to run unless its own
  module bytes equal the release's module (`ownModuleSha256`).
* Collector profile limits are the contract maxima `fdCollectorProfileLimitMaxima` (core), the parser's own ceilings; the renderer is qualified behaviourally against a real
  socket pair through `collectHostedFdPeers` with the signed-int32 rendering. Bytes are canonical (`encodeFdCollectorProfile`).
* `measureElfClosure` parses the complete `ld.so --list` grammar and refuses any other line. A member with more than one link is accepted only through an explicit
  `ElfHardlinkException` (exact path, SHA-256 and link count); the production issuers pass none.

## Not covered

Physical/installed observation (build, installer, guest boot, retention e2e), the creator row and the request composer are separate steps and are NOT_RUN here.
