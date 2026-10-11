import type { HostedAppServerLaunchFrame } from "./hosted-app-server-launch-frame";
import { hostedMimoCodingGuestHome, hostedMimoCodingGuestCodexHome } from "../../hosted-mimo-coding-bootstrap";
export function decodeHostedAppServerLaunchFrame(
  value: string,
): HostedAppServerLaunchFrame {
  const parsed = JSON.parse(value) as Partial<HostedAppServerLaunchFrame>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.command !== "string" ||
    parsed.command.length === 0 ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((item) => typeof item === "string") ||
    typeof parsed.cwd !== "string" ||
    parsed.cwd.length === 0 ||
    parsed.env === null ||
    typeof parsed.env !== "object" ||
    Array.isArray(parsed.env) ||
    !Object.entries(parsed.env).every(
      ([key, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string",
    )
  ) {
    throw new Error("hosted_app_server_launch_frame_invalid");
  }
  if (parsed.coding !== undefined) {
    const coding = parsed.coding;
    if (!coding || typeof coding !== "object" || Object.keys(coding).sort().join(",") !== "configToml,schemaVersion,specSha256,startId,workspacePath" ||
        coding.schemaVersion !== 1 || typeof coding.startId !== "string" || typeof coding.specSha256 !== "string" || !/^[a-f0-9-]{36}$/.test(coding.startId) || !/^[a-f0-9]{64}$/.test(coding.specSha256) ||
        typeof coding.workspacePath !== "string" || !coding.workspacePath.startsWith("/") || parsed.cwd !== coding.workspacePath ||
        typeof coding.configToml !== "string" || Buffer.byteLength(coding.configToml) > 65536 || coding.configToml.includes("\0") ||
        parsed.env.HOME !== hostedMimoCodingGuestHome || parsed.env.CODEX_HOME !== hostedMimoCodingGuestCodexHome ||
        parsed.env.TMPDIR !== "/tmp" || parsed.env.TMP !== "/tmp" || parsed.env.TEMP !== "/tmp") throw new Error("hosted_app_server_coding_frame_invalid");
  }
  return parsed as HostedAppServerLaunchFrame;
}
