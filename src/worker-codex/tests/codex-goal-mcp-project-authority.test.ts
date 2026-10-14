import { describe, expect, it, vi } from "vitest";
import {
  ProjectAuthorityCasStatus,
  ProjectAuthorityMode,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectControlAdoptAuthorityTupleView,
} from "../codex-goal-mcp-project-authority";
import type { ProjectControlMcpArgs } from "../codex-goal-mcp-inputs";

describe("project authority MCP action", () => {
  it("requires confirmation before calling the scoped broker", async () => {
    const adoptAuthorityTuple = vi.fn();
    const deps = authorityDeps(adoptAuthorityTuple);

    await expect(projectControlAdoptAuthorityTupleView(
      authorityArgs(false),
      deps,
    )).resolves.toMatchObject({
      ok: false,
      reason: "confirm_authority_adoption_required",
      projectId: "hosted-web-core",
    });
    expect(adoptAuthorityTuple).not.toHaveBeenCalled();
  });

  it("passes only the validated authority contract into the broker", async () => {
    const adoptAuthorityTuple = vi.fn().mockResolvedValue({
      status: ProjectAuthorityCasStatus.Applied,
    });
    const args = authorityArgs(true);

    await expect(projectControlAdoptAuthorityTupleView(
      args,
      authorityDeps(adoptAuthorityTuple),
    )).resolves.toMatchObject({
      ok: true,
      mode: "project_control_adopt_authority_tuple",
      projectId: "hosted-web-core",
      result: { status: ProjectAuthorityCasStatus.Applied },
    });
    expect(adoptAuthorityTuple).toHaveBeenCalledExactlyOnceWith({
      packetRevision: args.packetRevision,
      baseSha: args.baseSha,
      phaseStartSha: args.phaseStartSha,
      inputPatchHash: args.inputPatchHash,
      reviewReceipt: args.reviewReceipt,
      reviewReceiptSha256: args.reviewReceiptSha256,
    });
  });
});

function authorityArgs(confirm: boolean): ProjectControlMcpArgs {
  return {
    registryRootDir: "/registry",
    controllerJobId: "hosted-web-core-controller",
    packetRevision: "hosted-web-core-v1-r1",
    baseSha: "a".repeat(40),
    phaseStartSha: "b".repeat(40),
    inputPatchHash: "c".repeat(64),
    reviewReceipt: "{}",
    reviewReceiptSha256: "d".repeat(64),
    confirmAuthorityAdoption: confirm,
  };
}

function authorityDeps(adoptAuthorityTuple: ReturnType<typeof vi.fn>) {
  return {
    async loadProjectControlController() {
      return {
        registryRootDir: "/registry",
        controller: {
          jobId: "hosted-web-core-controller",
        } as never,
        scope: {
          projectId: "hosted-web-core",
          workspaceRoots: ["/work"],
          preStartAdmission: { required: true, mode: "serial-builtin" as const,
            authorityMode: ProjectAuthorityMode.HostedWebCoreV1 },
        },
      };
    },
    codexProjectControlBroker() {
      return { adoptAuthorityTuple } as unknown as ProjectControlBroker;
    },
  };
}
