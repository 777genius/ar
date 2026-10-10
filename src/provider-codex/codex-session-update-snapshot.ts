import type { RuntimeWarning, SessionArtifact, RedactorPort } from "@vioxen/subscription-runtime/core";
import type { AppServerExecutionLifetime } from "./codex-app-server-execution-engine";
import type { CodexSessionMaterializer } from "./codex-session-materializer";
import { sessionArtifactHash } from "./codex-session-materializer";

export async function snapshotSessionUpdate(input: {
  readonly executionLifetime?: AppServerExecutionLifetime;
  readonly materialized: Awaited<
    ReturnType<CodexSessionMaterializer["materialize"]>
  >;
  readonly previousSession: SessionArtifact;
  readonly redactor: RedactorPort;
}): Promise<{
  readonly sessionUpdate?: SessionArtifact;
  readonly captured: boolean;
  readonly warnings: readonly RuntimeWarning[];
}> {
  if (!input.materialized.snapshotSession) {
    return { captured:false,warnings: [] };
  }

  try {
    input.executionLifetime?.assertActive();
    const snapshot = await input.materialized.snapshotSession();
    input.executionLifetime?.assertActive();
    if (!snapshot) {
      return { captured:false,warnings: [] };
    }
    input.redactor.registerSecret(snapshot.bytes, "codex-session-snapshot");
    if (
      sessionArtifactHash(snapshot) === sessionArtifactHash(input.previousSession)
    ) {
      return { captured:true,warnings: [] };
    }
    return { captured:true,sessionUpdate: snapshot, warnings: [] };
  } catch {
    return {
      captured:false,
      warnings: [
        {
          code: "codex_session_snapshot_failed",
          safeMessage:
            "Codex session snapshot could not be captured after task execution.",
        },
      ],
    };
  }
}
