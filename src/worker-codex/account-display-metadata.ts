import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CodexAccountDisplayMetadata = {
  readonly displayName?: string;
  readonly email?: string;
  readonly shortName?: string;
  readonly operatorLabel?: string;
  readonly quarantined?: boolean;
  readonly quarantineReason?: string;
  readonly quarantinedAt?: string;
};

const metadataFileNames = [
  "account-labels.json",
  "account-metadata.json",
  "accounts.metadata.json",
] as const;

export async function readCodexAccountDisplayMetadata(
  authRootDir: string,
): Promise<Readonly<Record<string, CodexAccountDisplayMetadata>>> {
  for (const fileName of metadataFileNames) {
    const metadata = await tryReadMetadataFile(join(authRootDir, fileName));
    if (metadata) return metadata;
  }
  return {};
}

export function codexAccountDisplayMetadataForSlot(
  slotId: string,
  metadata?: CodexAccountDisplayMetadata,
): CodexAccountDisplayMetadata {
  const shortName = metadata?.shortName ?? codexAccountShortName(slotId);
  const email = metadata?.email;
  const displayName = metadata?.displayName ?? email;
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    shortName,
    ...(displayName ? { operatorLabel: `${displayName} - ${shortName}` } : {}),
    ...(metadata?.quarantined ? { quarantined: true } : {}),
    ...(metadata?.quarantineReason
      ? { quarantineReason: metadata.quarantineReason }
      : {}),
    ...(metadata?.quarantinedAt
      ? { quarantinedAt: metadata.quarantinedAt }
      : {}),
  };
}

export function codexAccountDisplayRecord(
  slotId: string,
  metadata?: CodexAccountDisplayMetadata,
): Readonly<Record<string, string>> {
  const display = codexAccountDisplayMetadataForSlot(slotId, metadata);
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(display)) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

function codexAccountShortName(slotId: string): string {
  const match = /^account-(.+)$/.exec(slotId);
  return match?.[1] ?? slotId;
}

async function tryReadMetadataFile(
  path: string,
): Promise<Readonly<Record<string, CodexAccountDisplayMetadata>> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseMetadataRoot(parsed);
  } catch {
    return null;
  }
}

function parseMetadataRoot(
  value: unknown,
): Readonly<Record<string, CodexAccountDisplayMetadata>> | null {
  if (!isRecord(value)) return null;
  const root = isRecord(value.accounts) ? value.accounts : value;
  const entries = Object.entries(root)
    .map(([slotId, raw]) => [slotId, parseMetadataEntry(raw)] as const)
    .filter((entry): entry is readonly [string, CodexAccountDisplayMetadata] =>
      entry[1] !== null,
    );
  const metadata = new Map(entries);
  if (isRecord(value.accounts)) {
    for (const [slotId, raw] of Object.entries(value)) {
      if (slotId === "accounts") continue;
      const quarantine = parseQuarantineMetadata(raw);
      if (!quarantine) continue;
      metadata.set(slotId, { ...(metadata.get(slotId) ?? {}), ...quarantine });
    }
  }
  return Object.fromEntries(metadata);
}

function parseMetadataEntry(value: unknown): CodexAccountDisplayMetadata | null {
  if (typeof value === "string") {
    const displayName = value.trim();
    return displayName ? { displayName } : null;
  }
  if (!isRecord(value)) return null;
  const displayName = firstString([
    value.displayName,
    value.label,
    value.name,
    value.email,
  ]);
  const email = firstString([value.email]);
  const shortName = firstString([value.shortName, value.letter]);
  const quarantine = parseQuarantineMetadata(value);
  if (!displayName && !email && !shortName && !quarantine) return null;
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(shortName ? { shortName } : {}),
    ...(quarantine ?? {}),
  };
}

function parseQuarantineMetadata(
  value: unknown,
): Pick<CodexAccountDisplayMetadata, "quarantined" | "quarantineReason" | "quarantinedAt"> | null {
  if (!isRecord(value) || value.quarantined !== true) return null;
  const quarantineReason = firstString([value.quarantineReason]);
  const quarantinedAt = firstString([value.quarantinedAt]);
  return {
    quarantined: true,
    ...(quarantineReason ? { quarantineReason } : {}),
    ...(quarantinedAt ? { quarantinedAt } : {}),
  };
}

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
