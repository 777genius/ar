import { describe, expect, it } from "vitest";
import {
  assertFrozenOutputReadAllowed,
  buildFrozenOutputPathAuthorization,
} from "../codex-goal-frozen-output-authorization";

describe("frozen output registry authorization", () => {
  it("treats the configured registry root as a project-owned root", () => {
    const registryRoot = "/tmp/project-registry";
    const authorization = buildFrozenOutputPathAuthorization({
      registryRootDir: registryRoot,
      scope: {
        projectId: "project",
        readRoots: ["/tmp/project-read"],
        registryRoot,
      },
    });

    expect(authorization.projectRoots).toContain(registryRoot);
    expect(
      assertFrozenOutputReadAllowed(
        authorization,
        `${registryRoot}/job.json`,
        "registry",
      ),
    ).toBe(`${registryRoot}/job.json`);
  });

  it("does not authorize a neighboring registry path", () => {
    const authorization = buildFrozenOutputPathAuthorization({
      registryRootDir: "/tmp/project-registry",
      scope: {
        projectId: "project",
        readRoots: ["/tmp/project-read"],
        registryRoot: "/tmp/project-registry",
      },
    });

    expect(() =>
      assertFrozenOutputReadAllowed(
        authorization,
        "/tmp/other-registry/job.json",
        "registry",
      ),
    ).toThrow("frozen_output_path_outside_project_scope");
  });
});
