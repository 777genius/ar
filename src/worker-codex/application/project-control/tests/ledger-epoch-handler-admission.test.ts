import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { ledgerEpochAdmissionSummary } from
  "../codex-goal-ledger-epoch-handler-admission";

const ledgerRoot = "/tmp/unpublished-ENOENT-ledger";
const itemsRoot = resolve(join(ledgerRoot, "items"));
const exactMissingEvidence =
  `consumed output ledger unreadable: ENOENT: no such file or directory, scandir '${itemsRoot}'`;

describe("ledger epoch unpublished root admission", () => {
  it("forwards the exact controller ID to a custom admission builder", async () => {
    const observed: string[] = [];
    await ledgerEpochAdmissionSummary({
      registryRootDir: "/tmp/registry",
      scope: { projectId: "test-project" },
      controllerJobId: "controller-exact",
      deps: {
        listJobs: async () => [],
        buildOverviewItems: async () => [],
      },
      snapshotBuilder: async (input) => {
        observed.push(input.controllerJobId);
        return {
          schemaVersion: 1,
          projectId: "test-project",
          observedAt: new Date(0).toISOString(),
          debt: [],
        };
      },
    });
    expect(observed).toEqual(["controller-exact"]);
  });

  it("ignores only the exact adapter-produced missing-items debt", async () => {
    await expect(summary([unreadable(itemsRoot, exactMissingEvidence)]))
      .resolves.toMatchObject({ debtCount: 0 });
  });

  it.each([
    [
      "ENOENT in the configured path",
      unreadable(
        itemsRoot,
        `consumed output ledger unreadable: EACCES: permission denied, scandir '${itemsRoot}'`,
      ),
    ],
    [
      "ENOENT in unrelated evidence",
      unreadable(itemsRoot, "consumed output ledger unreadable: injected ENOENT marker"),
    ],
  ])("keeps blocking debt when %s merely contains the marker", async (_label, debt) => {
    await expect(summary([debt])).rejects.toThrow(
      "ledger_epoch_proposed_admission_blocked",
    );
  });

  it("keeps other blocking debt after removing the exact missing-items debt", async () => {
    await expect(summary([
      unreadable(itemsRoot, exactMissingEvidence),
      {
        reason: ProjectDebtReason.UnconsumedCompletedJob,
        subject: "worker-with-output",
        severity: "blocking",
        evidence: ["terminal output remains unconsumed"],
      },
    ])).rejects.toThrow("ledger_epoch_proposed_admission_blocked");
  });
});

async function summary(debt: readonly ProjectDebtItem[]) {
  const snapshot: ProjectAdmissionSnapshot = {
    schemaVersion: 1,
    projectId: "test-project",
    observedAt: new Date(0).toISOString(),
    debt,
  };
  return await ledgerEpochAdmissionSummary({
    registryRootDir: "/tmp/registry",
    scope: { projectId: "test-project" },
    controllerJobId: "controller",
    deps: {
      listJobs: async () => [],
      buildOverviewItems: async () => [],
    },
    snapshotBuilder: async () => snapshot,
    rejectBlocking: true,
    unpublishedLedgerRoot: ledgerRoot,
  });
}

function unreadable(subject: string, evidence: string): ProjectDebtItem {
  return {
    reason: ProjectDebtReason.UnreadableRoot,
    subject,
    severity: "blocking",
    evidence: [evidence],
  };
}
