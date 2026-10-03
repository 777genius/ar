#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultAuthRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultTimezone = "Europe/Kiev";
const defaultMinLaunchIntervalMs = 10_000;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const codexHome = optionalExpandedPath(args.codexHome);
const authRoot = expandHome(stringArg(args.authRoot) ?? defaultAuthRoot);
const accounts = parseOptionalList(stringArg(args.accounts));
if (codexHome && accounts?.length) {
  throw new Error("--codex-home cannot be combined with --accounts");
}
const timezone = stringArg(args.timezone) ?? defaultTimezone;
const minLaunchIntervalMs = numberArg(
  args.minLaunchIntervalMs,
  defaultMinLaunchIntervalMs,
);
const observationTimeoutMs = numberArg(args.timeoutMs, 60_000);
const outputJson = Boolean(args.json);

const observability = await importObservabilityPackage();
const labels = codexHome ? {} : await readLabels(authRoot);
const accountSlots = codexHome
  ? ["current"]
  : accounts?.length
    ? accounts
    : await listAccountSlots(authRoot);

const throttle = new observability.InMemoryAppServerLaunchThrottle({
  minIntervalMs: minLaunchIntervalMs,
});
const reader = new observability.CodexAppServerQuotaReader({
  clientFactory: new observability.CodexAppServerClientFactory({
    appServerLaunchThrottle: throttle,
  }),
});
const observer = new observability.CodexAccountObserver({
  appServerReader: reader,
  authReader: new observability.CodexAuthJsonReader(),
});
const checkedAt = new Date();
const rows = [];

for (const slot of accountSlots) {
  rows.push(
    await readSlot({
      slot,
      authRoot,
      codexHome,
      labels,
      timezone,
      observer,
      observability,
      observationTimeoutMs,
    }),
  );
}

const sortedRows = rows.toSorted(compareRows);

if (outputJson) {
  console.log(
    JSON.stringify(
      {
        checkedAt: formatAbsolute(checkedAt, timezone),
        ...(codexHome ? { codexHome } : { authRoot }),
        rows: sortedRows,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Checked at: ${formatAbsolute(checkedAt, timezone)} Kyiv`);
  console.log("");
  console.log(markdownTable(sortedRows));
  console.log("");
  console.log(weeklyFreeSummary(sortedRows));
}

async function readSlot(input) {
  const label = input.labels[input.slot] ?? {};
  const letter = slotLetter(input.slot);
  const fallbackEmail =
    label.email ??
    label.displayName ??
    (input.codexHome ? "current Codex account" : "-");
  const resetCount = formatResetCount(label.resetCount);
  const unpaid = formatUnpaid(label.unpaid);
  const account = {
    provider: input.observability.AgentProvider.Codex,
    slotId: input.slot,
    authHome: input.codexHome ?? join(input.authRoot, input.slot),
    authJsonPath: input.codexHome
      ? join(input.codexHome, "auth.json")
      : join(input.authRoot, input.slot, "auth.json"),
    ...(label.email ? { email: label.email } : {}),
    ...(label.displayName ? { displayName: label.displayName } : {}),
  };

  try {
    const now = new Date();
    const observation = await input.observer.observe({
      account,
      now,
      timeoutMs: input.observationTimeoutMs,
    });
    const main = input.observability.codexMainQuotaSummary(observation.quota);
    const decision = observation.decision;
    const fiveFree = freePercent(main.fiveHour);
    const sevenFree = freePercent(main.sevenDay);
    return {
      email: observation.auth.identity?.email ?? fallbackEmail,
      letter,
      resetCount,
      unpaid,
      authStatus: observation.auth.status,
      status: formatStatus({
        availability: decision.availability,
        reason: decision.reason,
        authStatus: observation.auth.status,
      }),
      rawStatus: decision.availability,
      reason: decision.reason ?? "-",
      available: decision.schedulerEligible,
      fiveHourFree: formatFree(fiveFree),
      fiveHourFreeNumber: fiveFree,
      fiveHourReset: formatRelative(main.fiveHour?.resetsAt, input.timezone),
      sevenDayFree: formatFree(sevenFree),
      sevenDayFreeNumber: sevenFree,
      sevenDayReset: formatRelative(main.sevenDay?.resetsAt, input.timezone),
      nextReset: formatRelative(
        decision.limitResetAt ?? main.nextResetAt,
        input.timezone,
      ),
    };
  } catch (error) {
    const relogin = isReloginError(error);
    const probeFailure = isQuotaProbeFailure(error);
    return {
      email: fallbackEmail,
      letter,
      resetCount,
      unpaid,
      authStatus: relogin ? "relogin_required" : "unknown",
      status: relogin
        ? "❌ relogin required"
        : probeFailure
          ? "⚠️ quota probe failed"
          : "⚠️ inspect required",
      rawStatus: relogin ? "relogin_required" : "unknown",
      reason: relogin ? "refresh_token_revoked" : safeErrorReason(error),
      available: false,
      fiveHourFree: "-",
      fiveHourFreeNumber: null,
      fiveHourReset: "-",
      sevenDayFree: "-",
      sevenDayFreeNumber: null,
      sevenDayReset: "-",
      nextReset: "-",
    };
  }
}

function compareRows(left, right) {
  return (
    Number(right.available) - Number(left.available) ||
    Number(hasWeeklyCapacity(right)) - Number(hasWeeklyCapacity(left)) ||
    numeric(right.fiveHourFreeNumber) - numeric(left.fiveHourFreeNumber) ||
    numeric(right.sevenDayFreeNumber) - numeric(left.sevenDayFreeNumber) ||
    left.email.localeCompare(right.email)
  );
}

function hasWeeklyCapacity(row) {
  return numeric(row.sevenDayFreeNumber) > 0;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function markdownTable(rows) {
  const lines = [
    "| Почта | Буква | Resets | Статус | 5h free | Reset 5h Kyiv | 7d free | Reset 7d Kyiv | Доступен | Unpaid |",
    "|---|---:|---:|---|---:|---|---:|---|---:|---|",
  ];
  for (const row of rows) {
    const cells = [
      row.email,
      row.letter,
      row.resetCount,
      row.status,
      formatFreeBar(row.fiveHourFreeNumber),
      row.fiveHourReset,
      formatFreeBar(row.sevenDayFreeNumber),
      row.sevenDayReset,
      row.available ? "да" : "нет",
      row.unpaid,
    ];
    lines.push(
      `| ${cells.map((cell) => formatCell(cell, row.available)).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

function weeklyFreeSummary(rows) {
  const known = rows.filter(
    (row) => typeof row.sevenDayFreeNumber === "number",
  );
  const totalFree = known.reduce((sum, row) => sum + row.sevenDayFreeNumber, 0);
  const knownCapacity = known.length * 100;
  const knownPercent =
    knownCapacity > 0 ? (totalFree / knownCapacity) * 100 : null;
  const equivalents = totalFree / 100;
  const lines = [
    `Known 7d free: ${formatFreeBar(knownPercent)} (${formatPercent(totalFree)} / ${formatPercent(knownCapacity)}, ${formatNumber(equivalents)} of ${known.length} measured accounts)`,
  ];
  if (known.length < rows.length) {
    const poolCapacity = rows.length * 100;
    const lowerBoundPercent =
      poolCapacity > 0 ? (totalFree / poolCapacity) * 100 : null;
    lines.push(
      `Pool lower bound: ${formatFreeBar(lowerBoundPercent)} (${known.length}/${rows.length} accounts measured; unknown/relogin accounts are not counted as real 0%)`,
    );
  }
  return lines.join("\n");
}

function formatCell(value, available) {
  const text = escapeMarkdownTable(String(value));
  return available ? `**${text}**` : text;
}

function escapeMarkdownTable(value) {
  return value.replaceAll("|", "\\|");
}

function formatStatus(input) {
  if (input.authStatus === "unavailable") return "❌ auth missing";
  if (input.authStatus === "unknown") return "⚠️ auth unknown";
  if (
    input.availability === "unknown" &&
    input.reason === "quota_observation_failed" &&
    input.authStatus === "authenticated"
  ) {
    return "⚠️ quota probe failed, auth ready";
  }
  if (input.availability === "available") return "✅ available";
  if (input.availability === "limited") return "⚠️ limited";
  if (input.availability === "relogin_required") return "❌ relogin required";
  if (input.availability === "auth_unknown") return "⚠️ auth unknown";
  if (input.availability === "unhealthy") return "⚠️ unhealthy";
  return "⚠️ inspect required";
}

async function importObservabilityPackage() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const distPath = resolve(
    scriptDir,
    "../../packages/agent-account-observability/dist/index.js",
  );
  try {
    return await import(pathToFileURL(distPath).href);
  } catch (error) {
    throw new Error(
      `failed to import built observability package. Run npm run build:packages first. ${errorText(error)}`,
    );
  }
}

async function listAccountSlots(authRoot) {
  const entries = await readdir(authRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^account-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readLabels(authRoot) {
  for (const fileName of [
    "account-labels.json",
    "account-metadata.json",
    "accounts.metadata.json",
  ]) {
    try {
      const parsed = JSON.parse(
        await readFile(join(authRoot, fileName), "utf8"),
      );
      return isRecord(parsed.accounts) ? parsed.accounts : parsed;
    } catch {}
  }
  return {};
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      parsed.help = true;
      continue;
    }
    if (item === "--json") {
      parsed.json = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for ${item}`);
    parsed[toCamel(item.slice(2))] = value;
    index += 1;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  npm run ops:codex-account-quota
  node scripts/ops/codex-account-quota-table.mjs \\
    [--auth-root ~/.cache/subscription-runtime/live-codex-auth] \\
    [--codex-home ~/.codex] \\
    [--accounts account-d,account-i] \\
    [--timezone Europe/Kiev] \\
    [--min-launch-interval-ms 10000] \\
    [--timeout-ms 60000] \\
    [--json]

Prints a safe operator table for Codex account main quota windows only:
base codex 5h free, base codex 7d free and reset times. It does not print
tokens or raw provider payloads.`);
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalExpandedPath(value) {
  const path = stringArg(value);
  return path ? expandHome(path) : undefined;
}

function numberArg(value, fallback) {
  const text = stringArg(value);
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid number: ${value}`);
  }
  return Math.trunc(parsed);
}

function parseOptionalList(value) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/")
    ? resolve(process.env.HOME ?? "", path.slice(2))
    : resolve(path);
}

function slotLetter(slot) {
  return /^account-(.+)$/.exec(slot)?.[1] ?? slot;
}

function freePercent(window) {
  const used = window?.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10));
}

function formatFree(value) {
  return typeof value === "number" ? `${value}%` : "-";
}

function formatResetCount(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return String(Number(trimmed));
  }
  return "-";
}

function formatUnpaid(value) {
  return typeof value === "string" && /^\d{2}\.\d{2}\.\d{4}$/.test(value.trim())
    ? value.trim()
    : "-";
}

function formatFreeBar(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${formatPercent(value)} ${progressBar(value)}`;
}

function progressBar(value) {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round(clamped / 20);
  return `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
}

function formatPercent(value) {
  return `${formatNumber(value)}%`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatRelative(value, timezone) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return "-";
  const date = dateParts(value, timezone);
  const today = dateParts(new Date(), timezone);
  if (
    date.year === today.year &&
    date.month === today.month &&
    date.day === today.day
  ) {
    return `сегодня ${date.hour}:${date.minute}`;
  }
  return `${date.year}-${date.month}-${date.day} ${date.hour}:${date.minute}`;
}

function formatAbsolute(value, timezone) {
  const date = dateParts(value, timezone);
  return `${date.year}-${date.month}-${date.day} ${date.hour}:${date.minute}`;
}

function dateParts(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: byType.year,
    month: byType.month,
    day: byType.day,
    hour: byType.hour,
    minute: byType.minute,
  };
}

function isReloginError(error) {
  return /token_invalidated|authentication token has been invalidated|refresh token was revoked|refresh_token_invalidated|token_revoked/i.test(
    errorText(error),
  );
}

function isQuotaProbeFailure(error) {
  return /codex_app_server_quota_read_failed|json_rpc_request_timeout|timeout|app-server/i.test(
    errorText(error),
  );
}

function safeErrorReason(error) {
  return errorText(error).replace(/\s+/g, " ").slice(0, 120);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
