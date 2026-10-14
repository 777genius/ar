import { codexMimoApiKeyEnvVarDefault } from "../../codex-model-backend";
import { hostedMimoCodingBootstrapForFrame } from "../../hosted-mimo-coding-bootstrap-registry";
import { hostedMimoCodingGuestHome, hostedMimoCodingGuestCodexHome, type HostedMimoCodingBootstrap } from "../../hosted-mimo-coding-bootstrap";
// The fixed research handshake includes OS setup, retained ownership and the
// final material/authority checks. Readiness does not start a shorter budget.
export { hostedResearchSetupTimeoutMs } from "../../hosted-mimo-coding-bootstrap";

export type HostedAppServerLaunchFrame = {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly coding?: HostedMimoCodingBootstrap;
};

export function encodeHostedAppServerLaunchFrame(
  frame: HostedAppServerLaunchFrame,
): string {
  if (frame.coding !== undefined) throw new Error("hosted_app_server_coding_frame_unissued");
  const coding = hostedMimoCodingBootstrapForFrame(frame);
  return `${JSON.stringify(coding ? { ...frame, cwd: coding.workspacePath,
    env: { ...Object.fromEntries(Object.entries(frame.env).filter(([name]) => ["PATH", "CI", codexMimoApiKeyEnvVarDefault].includes(name))), HOME: hostedMimoCodingGuestHome, CODEX_HOME: hostedMimoCodingGuestCodexHome,
      TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" }, coding } : frame)}\n`;
}

export { decodeHostedAppServerLaunchFrame } from "./hosted-app-server-launch-frame-decoder";
