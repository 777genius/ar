import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexAccountDisplayMetadataForSlot,
  codexAccountDisplayRecord,
  readCodexAccountDisplayMetadata,
} from "../account-display-metadata";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function authRootWithLabels(labels: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-account-display-"));
  roots.push(root);
  await writeFile(join(root, "account-labels.json"), `${JSON.stringify(labels)}\n`);
  return root;
}

describe("Codex account display metadata", () => {
  it("parses operator plan, unpaid date and reset count", async () => {
    const root = await authRootWithLabels({
      "account-a": { email: "operator@example.com", plan: "free", unpaid: "19.08.2026", resetCount: 2 },
      "account-b": { plan: "plus", resetCount: " 3 " },
    });

    const metadata = await readCodexAccountDisplayMetadata(root);

    expect(metadata["account-a"]).toEqual({
      displayName: "operator@example.com",
      email: "operator@example.com",
      plan: "free",
      unpaid: "19.08.2026",
      resetCount: 2,
    });
    expect(metadata["account-b"]).toEqual({ plan: "plus", resetCount: 3 });
  });

  it("drops malformed unpaid dates and reset counts instead of guessing", async () => {
    const root = await authRootWithLabels({
      "account-a": { email: "operator@example.com", unpaid: "2026-08-19", resetCount: -1 },
      "account-b": { unpaid: "19/08/2026", resetCount: 1.5 },
    });

    const metadata = await readCodexAccountDisplayMetadata(root);

    expect(metadata["account-a"]).toEqual({
      displayName: "operator@example.com",
      email: "operator@example.com",
    });
    expect(metadata["account-b"]).toBeUndefined();
  });

  it("keeps a zero reset count and stringifies it for display records", () => {
    const display = codexAccountDisplayMetadataForSlot("account-c", { resetCount: 0, plan: "pro" });

    expect(display).toEqual({ shortName: "c", resetCount: 0, plan: "pro" });
    expect(codexAccountDisplayRecord("account-c", { resetCount: 0 })).toEqual({
      shortName: "c",
      resetCount: "0",
    });
  });

  it("surfaces plan and unpaid on account slot status even without auth", async () => {
    const root = await authRootWithLabels({
      "account-a": { email: "operator@example.com", plan: "free", unpaid: "19.08.2026" },
    });

    const [account] = await listCodexGoalAccountStatuses({
      authRootDir: root,
      accounts: ["account-a"],
    });

    expect(account).toMatchObject({
      name: "account-a",
      status: "auth_missing",
      operatorLabel: "operator@example.com - a",
      plan: "free",
      unpaid: "19.08.2026",
    });
  });
});
