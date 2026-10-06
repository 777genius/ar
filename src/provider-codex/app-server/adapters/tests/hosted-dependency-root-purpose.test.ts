import { describe, expect, it } from "vitest";
import { assertHostedDependencyRootGitConfigBytes } from "../hosted-dependency-root-git-config";
import { HostedDependencyRootPurpose, assertCurrentHostedDependencyRootPurpose, assertCurrentHostedDependencyRetiredReady,
  HostedDependencyRootDescriptorRecipe, openCurrentHostedDependencyRootDescriptor,
  retireCurrentHostedDependencySourceCleanup, type HostedDependencyRootPurposeContext } from "../hosted-current-dependency-origin";
import type { HostedActivationFence } from "../hosted-process-activation";
import { DependencyUnverifiedReason } from "../../../../worker-core/dependency-environment/domain/dependency-receipt";

// Regression boundary: enabling an executable config directive or accepting a
// caller-shaped root facade would violate the protected root submission scope.
// Pure syntax positives below are data only, never a qualified host/context.
describe("root Git protected input boundary", () => {
  it("preserves the fixed core/user-only grammar", () => {
    expect(() => assertHostedDependencyRootGitConfigBytes(Buffer.from(
      "[core]\n repositoryformatversion = 0\n filemode = true\n bare = false\n logallrefupdates = true\n[user]\n name = iliya\n email = iliyazelenkog@gmail.com\n"))).not.toThrow();
  });
  it.each([
    "[include]\n path = /outside/config\n", "[includeIf \"gitdir:*\"]\n path = /outside/config\n",
    "[core]\n fsmonitor = /outside/executable\n", "[core]\n hooksPath = /outside/hooks\n",
    "[filter \"evil\"]\n smudge = /outside/executable\n", "[alias]\n check = !/outside/executable\n",
    "[diff \"evil\"]\n textconv = /outside/executable\n", "[credential]\n helper = /outside/executable\n",
    "[extensions]\n worktreeConfig = true\n", "[submodule \"evil\"]\n update = !/outside/executable\n",
    "[core]\n bare = true\n", "[user]\n name = safe\0evil\n",
  ])("refuses executable or indirect config before any submission: %s", config => {
    expect(() => assertHostedDependencyRootGitConfigBytes(Buffer.from(config))).toThrow("hosted_dependency_root_git_config_unsupported");
  });
  it("refuses invalid UTF-8 and oversized config", () => {
    expect(() => assertHostedDependencyRootGitConfigBytes(Uint8Array.of(0xff))).toThrow();
    expect(() => assertHostedDependencyRootGitConfigBytes(Buffer.alloc(65537,0x20))).toThrow();
  });
});
describe("root purpose cannot be reconstructed from caller data", () => {
  it("rejects copied scope/getter data before evaluating caller fields or fence", () => {
    let reads = 0;
    const counterfeit = Object.defineProperty({},"origin",{get() { reads++; throw new Error("caller getter"); }});
    const fence = Object.defineProperty({},"held",{get() { reads++; throw new Error("caller fence"); }});
    expect(() => assertCurrentHostedDependencyRootPurpose(counterfeit as HostedDependencyRootPurposeContext,
      HostedDependencyRootPurpose.ManagedGitReadV1,fence as HostedActivationFence)).toThrow("hosted_dependency_current_origin_unresolved");
    expect(() => assertCurrentHostedDependencyRetiredReady(counterfeit as HostedDependencyRootPurposeContext,fence as HostedActivationFence)).toThrow();
    // Regression: caller-selected descriptor paths must never enter an opener
    // before resolving the original opaque purpose. No positive permit is made.
    expect(() => openCurrentHostedDependencyRootDescriptor(counterfeit as HostedDependencyRootPurposeContext,
      fence as HostedActivationFence,HostedDependencyRootDescriptorRecipe.AuthoredFileV1,"/caller/scope/file")).toThrow("hosted_dependency_current_origin_unresolved");
    expect(reads).toBe(0);
  });
  it("a copied historical Ready/retirement tuple cannot enter the actual producer", () => {
    const counterfeit = Object.freeze({readyRevision:7,unverifiedRevision:8,attemptId:"data",previousReady:{sha256:"data"}});
    expect(() => retireCurrentHostedDependencySourceCleanup(counterfeit as unknown as HostedDependencyRootPurposeContext,
      DependencyUnverifiedReason.InputsChanged)).toThrow();
  });
});
