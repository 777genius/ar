import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { MimoAttachmentCardError, renderMimoAttachment } from "./hosted-mimo-project-attachment";

const cardMaxBytes = 65536;
const invalid = (issue: string) => ({ ok: false, error: "mimo_project_bridge_render_card_invalid", issues: [issue] });
/** The card is untrusted operator input for a read-only render, so no root custody applies; it must be a small regular file. */
export function renderMimoAttachmentFromFile(path: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > cardMaxBytes) return invalid("card: not a regular file or larger than 64 KiB");
    value = JSON.parse(readFileSync(descriptor).toString("utf8"));
  } catch { return invalid("card: unreadable or not JSON"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  try { return { ok: true, ...renderMimoAttachment(value) }; }
  catch (error) {
    if (error instanceof MimoAttachmentCardError) return { ok: false, error: error.message, issues: error.issues };
    throw error;
  }
}
