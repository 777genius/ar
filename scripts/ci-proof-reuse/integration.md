# CI proof reuse integration

The detector only replaces four Unit tests matrix jobs and eight crash lanes on
`push` to `main`. Every other gate still executes, including ancillary phases.
A completed attempt with twelve successful lane proofs can be used even if an
unrelated gate failed. The whole run conclusion is never accepted as proof.

Pin checkout to `11d5960a326750d5838078e36cf38b85af677262`, setup-node to
`49933ea5288caeca8642d1e84afbd3f7d6820020`, upload-artifact to
`ea165f8d65b6e75b540449e92b4886f43607fa02` throughout participating jobs.
Keep Node 22. Scripts with strict enums run with `--experimental-transform-types`.

Producer jobs receive chart-controlled `CI_RUNNER_IMAGE_DIGEST`
(`sha256:` plus 64 hex digits) and `CI_RUNNER_CONFIG_REV` (64 hex digits).
The revision hashes the immutable execution/security profile, excluding capacity
and pool name, so a separate control pool can share the same execution profile.
The metadata-only control pool separately exports `CI_PROOF_RUNNER_IMAGE_DIGEST`
and `CI_PROOF_RUNNER_CONFIG_REV` as the expected current producer profile, without
pretending its own Docker/cache mounts match the producer. Node/OS/tool binary
facts are still independently measured inside the control process. A missing/changed
value safely runs full gates. Runner images must be ephemeral,
trusted and isolated; a shared writable runner installation cannot authenticate
its own environment. The source runner label is per family: the crash lanes use
the effective `vars.RUNNER`, while the four Unit lanes run on the stock
`ubuntu-24.04` VM (their private TEST tmp mount needs sudo, CAP_SYS_ADMIN and mount
namespaces) and capture `CI_PROOF_RUNNER_LABEL: ubuntu-24.04`. The detector verifies
all lanes against one expected label and one trusted producer fingerprint, so a
receipt whose label differs (for example when `vars.RUNNER` is not `ubuntu-24.04`),
or whose image digest or config revision is missing (a stock VM has no
`CI_RUNNER_IMAGE_DIGEST` / `CI_RUNNER_CONFIG_REV`), is rejected and the matching
lanes run in full. Reuse then fails closed; it is never forged.

## Detector job (main pushes only)

Run on a separate control pool with the same runtime image and the trusted
expected producer profile. Control does not mount producer Docker/cache volumes.
Grant only job-scoped `contents: read`, `actions: read` and `pull-requests: read`. Checkout the current main push
SHA, with persisted credentials disabled. Setup Node 22. Install restic with the
same existing unit prerequisite, then execute:

```yaml
- name: Verify reusable PR lane proofs
  id: proof
  env:
    GITHUB_TOKEN: ${{ github.token }}
    CI_PROOF_RUNNER_LABEL: ${{ vars.RUNNER || 'ubuntu-24.04' }}
  run: node --experimental-transform-types scripts/ci-proof-reuse/cli.mts detect
```

Expose `steps.proof.outputs.reuse_unit` and `reuse_crash` as job outputs. A failed,
cancelled or skipped detector MUST execute full matrices. Use an explicit guard:

```yaml
if: ${{ always() && !(needs.ci-proof-reuse.result == 'success' && needs.ci-proof-reuse.outputs.reuse_unit == 'true') }}
needs: [ci-proof-reuse]
```

Crash guard uses `reuse_crash`. Detector job on PR can be skipped, since both
matrices have `always()` and fall back. Never use mere matrix `skipped` as success.

## Source lane receipts

Place unit restic installation before `npm ci`. Immediately after checkout,
setup-node and restic (unit only), BEFORE npm/source/build commands, capture:

```yaml
- name: Capture CI proof identity before source execution
  id: capture
  continue-on-error: true
  env:
    CI_PROOF_RUNNER_LABEL: ${{ vars.RUNNER || 'ubuntu-24.04' }}
    CI_PROOF_FAMILY: unit
    CI_PROOF_LANE: ${{ matrix.shard }}
    CI_PROOF_RECEIPT_PATH: ${{ runner.temp }}/ci-proof-unit-${{ matrix.shard }}/receipt.json
  run: node --experimental-transform-types scripts/ci-proof-reuse/cli.mts capture
```

For crash use `CI_PROOF_FAMILY: crash`, `matrix.lane`, and
`${{ runner.temp }}/ci-proof-crash-${{ matrix.lane }}/receipt.json`.
Capture runs on both PR/main, but upload only on PR, only after test success:

```yaml
- name: Publish successful CI lane proof
  continue-on-error: true
  if: ${{ success() && steps.capture.outcome == 'success' && github.event_name == 'pull_request' }}
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
  with:
    name: ci-proof-v1-${{ github.run_attempt }}-unit-${{ matrix.shard }}
    path: ${{ runner.temp }}/ci-proof-unit-${{ matrix.shard }}/receipt.json
    if-no-files-found: error
    retention-days: 2
```

The unit/crash aggregator accepts matrix skipped only if detector result success,
corresponding output exactly `true`, and independently retained gates succeed.
It should print whether proof was verified or the actual matrix ran. Final test
must still require detector success when reused and all original nonportable gates.

Add `tsc --noEmit -p scripts/ci-proof-reuse/tsconfig.json` to `typecheck:ci-tools`
and `scripts/ci-proof-reuse/{contract,github,workflow}.test.mts` with the transform flag to
`test:ci-tools`. No dependencies or production source changes are needed.

The protocol is deliberately conservative: TTL 24h, unique merged PR for exact
main commit, same repository/workflow, explicit complete attempt, twelve unique
successful job/step identities, independent checkout/Node observations for every
lane, GitHub merge tree/parent/workflow/lock validation, identical pre-source
receipt and immutable artifact, and exact current runtime fingerprint. Any
unknown value, bounded incomplete scan, missing artifact, API failure or mismatch
runs all twelve gates. Read-only verification never executes downloaded PR code.

## Rollout and concurrent main updates

The main detector reads `/commits/{sha}/pulls` and `/pulls/{number}` to establish
PR associations. Its token needs `pull-requests: read` alongside the existing
content/action reads. Permission errors safely execute all lanes; expanding
workflow-wide or write permissions is unnecessary.

If another PR advances main between certification and merge, the final main tree
can differ from the tested PR merge tree. All twelve successful old lane proofs
then remain valid for their original tree, and main executes full fallback.
Rerunning a merged PR retains its original event/checkout context; it does not
qualify a new main tree. Qualify a fresh PR from the current base to establish
new receipts, with the current producer image/configuration revision.

For rollout evidence, record the source run, explicit attempt, twelve job IDs and
observed checkout tree. After merge, require the real main detector decision to
identify those exact proofs before claiming reuse. A head guard alone does not
prevent a concurrent base update. Skipped lanes must retain validated-proof
aggregate checks, and every other CI gate still reports its own actual outcome.
