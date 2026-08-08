export function prunedRetentionInvalidProvenanceCases(
  backup: Readonly<Record<string, string>>,
): readonly Readonly<{ name: string; value: unknown }>[] {
  const rejectedBase = {
    schemaVersion: 1,
    note: "reviewed output rejected",
    jobId: "worker-rejected-invalid",
    status: "rejected",
    closedAt: "2026-07-01T00:00:00.000Z",
    consumedAt: "2026-07-01T00:00:00.000Z",
    notes: [{ status: "rejected", text: "reviewed output rejected" }],
    backup,
  };
  const integratedBase = {
    ...rejectedBase,
    status: "integrated",
    commitSha: "abc1234",
    commit: "abc1234",
    integratedCommitSha: "abc1234",
    notes: [{
      status: "integrated",
      text: rejectedBase.note,
      commit: "abc1234",
    }],
  };
  return [
    {
      name: "missing aliases",
      value: { ...rejectedBase, consumedAt: undefined, notes: undefined },
    },
    {
      name: "notes alias missing",
      value: { ...rejectedBase, notes: undefined },
    },
    {
      name: "consumedAt alias missing",
      value: { ...rejectedBase, consumedAt: undefined },
    },
    {
      name: "unsupported superseded status",
      value: {
        ...rejectedBase,
        status: "superseded",
        notes: [{ status: "superseded", text: rejectedBase.note }],
      },
    },
    {
      name: "mismatched writer note",
      value: {
        ...rejectedBase,
        notes: [{ status: "rejected", text: "different decision" }],
      },
    },
    {
      name: "rejected record with contradictory commit",
      value: { ...rejectedBase, commitSha: "abc1234" },
    },
    {
      name: "integrated record with mismatched note commit",
      value: {
        ...integratedBase,
        notes: [{
          status: "integrated",
          text: rejectedBase.note,
          commit: "def5678",
        }],
      },
    },
    {
      name: "integrated record without canonical commit",
      value: { ...integratedBase, commitSha: undefined },
    },
    {
      name: "integrated record without commit alias",
      value: { ...integratedBase, commit: undefined },
    },
    {
      name: "integrated record without integratedCommitSha alias",
      value: { ...integratedBase, integratedCommitSha: undefined },
    },
  ];
}
