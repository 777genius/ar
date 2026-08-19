export function staleIntegrationReconciliationProofRefusal(
  error: unknown,
): string {
  if (error instanceof Error &&
    error.message === "stale_integration_reconciliation_patch_outside_reviewed_store") {
    return "patch_outside_reviewed_store";
  }
  return `proof_unavailable:${error instanceof Error ? error.message : String(error)}`;
}
