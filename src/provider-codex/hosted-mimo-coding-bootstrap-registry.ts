import { codexMimoApiKeyEnvVarDefault } from "./codex-model-backend";
import type { HostedMimoCodingBootstrap } from "./hosted-mimo-coding-bootstrap";
type Frame = { command: string; cwd: string; env: Readonly<Record<string, string>> };
const issued = new Map<string, (frame: Frame) => HostedMimoCodingBootstrap>();
export function registerHostedMimoCodingBootstrap(capability: string, read: (frame: Frame) => HostedMimoCodingBootstrap): () => void {
  if (issued.has(capability)) throw new Error("hosted_mimo_coding_proxy_duplicate");
  issued.set(capability, read);
  return () => { if (issued.get(capability) === read) issued.delete(capability); };
}
export function hostedMimoCodingBootstrapForFrame(frame: Frame): HostedMimoCodingBootstrap | undefined {
  return issued.get(frame.env[codexMimoApiKeyEnvVarDefault] ?? "")?.(frame);
}
