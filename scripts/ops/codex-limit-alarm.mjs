#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlarmEffect,
  acknowledgeAlarm,
  applyPoolSummary,
  initialAlarmState,
  persistedAlarmState,
  summarizeQuotaRows,
} from "./codex-limit-alarm-state.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaults = Object.freeze({
  codexHome: "~/.codex",
  quotaScript: join(scriptDir, "codex-account-quota-table.mjs"),
  intervalMs: 10 * 60_000,
  minLaunchIntervalMs: 10_000,
  checkTimeoutMs: 7 * 60_000,
  observationTimeoutMs: 120_000,
  probeRetryDelayMs: 15_000,
  minimumAvailable: 1,
  alertThresholdPercent: 10,
  listenHost: "127.0.0.1",
  port: 47_831,
  timezone: "Europe/Kiev",
  sound: "/System/Library/Sounds/Sosumi.aiff",
});

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const config = {
  codexHome: stringArg(args.codexHome) ?? defaults.codexHome,
  quotaScript: stringArg(args.quotaScript) ?? defaults.quotaScript,
  intervalMs: numberArg(args.intervalMs, defaults.intervalMs, 60_000),
  minLaunchIntervalMs: numberArg(
    args.minLaunchIntervalMs,
    defaults.minLaunchIntervalMs,
    0,
  ),
  checkTimeoutMs: numberArg(
    args.checkTimeoutMs,
    defaults.checkTimeoutMs,
    30_000,
  ),
  observationTimeoutMs: numberArg(
    args.observationTimeoutMs,
    defaults.observationTimeoutMs,
    30_000,
  ),
  probeRetryDelayMs: numberArg(
    args.probeRetryDelayMs,
    defaults.probeRetryDelayMs,
    10_000,
  ),
  minimumAvailable: numberArg(
    args.minimumAvailable,
    defaults.minimumAvailable,
    1,
  ),
  alertThresholdPercent: numberArg(
    args.alertThresholdPercent,
    defaults.alertThresholdPercent,
    0,
  ),
  listenHost: stringArg(args.listenHost) ?? defaults.listenHost,
  port: numberArg(args.port, defaults.port, 1),
  timezone: stringArg(args.timezone) ?? defaults.timezone,
  sound: stringArg(args.sound) ?? defaults.sound,
};

const statePath = join(
  homedir(),
  "Library/Application Support/Codex Limit Alarm/state.json",
);
const controlToken = randomBytes(24).toString("hex");
const instanceId = randomBytes(8).toString("hex");
const sound = createRepeatingMacAlarm(config.sound);
let alarmState = initialAlarmState(await readPersistedState(statePath));
let checkTimer;
let checkPromise;
let shuttingDown = false;
let simulationActive = false;
let lastRealSnapshot;
let view = {
  phase: "starting",
  message: "Подготовка первой проверки",
  rows: [],
  summary: null,
  checkedAt: null,
  nextCheckAt: null,
  checkStartedAt: null,
  lastError: null,
  alarmState,
};

const server = createServer(handleRequest);
server.on("error", (error) => {
  console.error(`codex-limit-alarm server error: ${errorText(error)}`);
  process.exitCode = 1;
});
await listen(server, config.port, config.listenHost);

const dashboardUrl = `http://${config.listenHost}:${config.port}`;
console.log(`Codex limit alarm: ${dashboardUrl}`);
scheduleCheck(0);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function runCheck() {
  if (checkPromise || shuttingDown) return checkPromise;
  const startedAt = new Date();
  const nextDueAt = new Date(startedAt.getTime() + config.intervalMs);
  view = {
    ...view,
    phase: "checking",
    message: "Проверяю аккаунты",
    checkStartedAt: startedAt.toISOString(),
    nextCheckAt: nextDueAt.toISOString(),
    lastError: null,
  };

  checkPromise = (async () => {
    try {
      const snapshot = await readLocalQuota(config);
      if (isProbeFailureSnapshot(snapshot) && lastRealSnapshot) {
        if (!simulationActive) {
          view = {
            ...view,
            phase: "degraded",
            message: "Временный сбой проверки, показаны последние данные",
            lastError: "quota probe failed after retry",
          };
        }
      } else {
        lastRealSnapshot = snapshot;
        if (!simulationActive) await applySnapshot(snapshot);
      }
    } catch (error) {
      view = {
        ...view,
        phase: "error",
        message: "Не удалось проверить лимиты",
        lastError: safeError(error),
        alarmState,
      };
    } finally {
      checkPromise = undefined;
      scheduleCheck(Math.max(0, nextDueAt.getTime() - Date.now()));
    }
  })();
  return checkPromise;
}

function scheduleCheck(delayMs) {
  if (shuttingDown) return;
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void runCheck(), delayMs);
  checkTimer.unref?.();
}

async function applyAlarmEffect(effect) {
  if (effect === AlarmEffect.Start) {
    sound.start();
    notifyMac(
      "Codex: осталось меньше 10%",
      "У текущего аккаунта заканчивается доступный лимит",
    );
  } else if (effect === AlarmEffect.Stop) {
    sound.stop();
  }
}

async function stopAlarm() {
  const transition = acknowledgeAlarm(alarmState);
  alarmState = transition.state;
  sound.stop();
  await persistState(statePath, alarmState);
  view = {
    ...view,
    message: alarmState.exhausted
      ? "Осталось меньше 10%, звук остановлен"
      : "Мониторинг активен",
    alarmState,
  };
}

async function applySnapshot(snapshot, options = {}) {
  const summary = summarizeQuotaRows(
    snapshot.rows,
    config.minimumAvailable,
    config.alertThresholdPercent,
  );
  const transition = applyPoolSummary(alarmState, summary);
  alarmState = transition.state;
  await applyAlarmEffect(transition.effect);
  await persistState(statePath, alarmState);
  view = {
    ...view,
    phase: alarmState.exhausted ? "exhausted" : "ready",
    message: options.simulated
      ? alarmState.acknowledged
        ? "Тест: осталось меньше 10%, звук остановлен"
        : "Тест: осталось меньше 10%"
      : alarmState.exhausted
        ? alarmState.acknowledged
          ? "Осталось меньше 10%, звук остановлен"
          : "Осталось меньше 10%"
        : "Мониторинг активен",
    rows: snapshot.rows,
    summary,
    checkedAt: snapshot.checkedAt ?? new Date().toISOString(),
    lastError: null,
    alarmState,
  };
}

async function simulateLimit() {
  simulationActive = true;
  const realRow = lastRealSnapshot?.rows?.[0] ?? view.rows?.[0] ?? {};
  await applySnapshot(
    {
      checkedAt: "simulation",
      rows: [
        {
          ...realRow,
          status: "⚠️ limited (simulation)",
          rawStatus: "limited",
          reason: "operator_simulation",
          available: false,
          fiveHourFree: "0%",
          fiveHourFreeNumber: 0,
          sevenDayFree: "0%",
          sevenDayFreeNumber: 0,
        },
      ],
    },
    { simulated: true },
  );
}

async function recoverSimulation() {
  simulationActive = false;
  if (lastRealSnapshot) {
    await applySnapshot(lastRealSnapshot);
    return;
  }
  const transition = applyPoolSummary(alarmState, {
    exhausted: false,
  });
  alarmState = transition.state;
  await applyAlarmEffect(transition.effect);
  await persistState(statePath, alarmState);
  view = { ...view, phase: "starting", message: "Ожидаю реальную проверку", alarmState };
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", dashboardUrl);
  if (request.method === "GET" && url.pathname === "/") {
    return sendHtml(response, dashboardHtml(controlToken, instanceId));
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    return sendJson(response, 200, publicState());
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    if (request.headers["x-control-token"] !== controlToken) {
      return sendJson(response, 403, { ok: false, error: "forbidden" });
    }
    if (url.pathname === "/api/check") {
      void runCheck();
      return sendJson(response, 202, { ok: true });
    }
    if (url.pathname === "/api/alarm/test") {
      sound.start();
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === "/api/alarm/simulate-limit") {
      await simulateLimit();
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === "/api/alarm/recover-simulation") {
      await recoverSimulation();
      return sendJson(response, 200, { ok: true });
    }
    if (url.pathname === "/api/alarm/stop") {
      await stopAlarm();
      return sendJson(response, 200, { ok: true });
    }
  }
  sendJson(response, 404, { ok: false, error: "not_found" });
}

function publicState() {
  return {
    ...view,
    alarmState,
    soundActive: sound.active,
    intervalMs: config.intervalMs,
    minimumAvailable: config.minimumAvailable,
    alertThresholdPercent: config.alertThresholdPercent,
    simulationActive,
    instanceId,
  };
}

async function readLocalQuota(options) {
  let lastSnapshot;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await runProcess(
      process.execPath,
      [
        options.quotaScript,
        "--codex-home",
        options.codexHome,
        "--timezone",
        options.timezone,
        "--min-launch-interval-ms",
        String(options.minLaunchIntervalMs),
        "--timeout-ms",
        String(options.observationTimeoutMs),
        "--json",
      ],
      options.checkTimeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(`local quota check failed: ${result.stderr || `exit ${result.code}`}`);
    }
    const parsed = JSON.parse(result.stdout);
    if (!parsed || !Array.isArray(parsed.rows)) {
      throw new Error("local quota check returned an invalid snapshot");
    }
    lastSnapshot = parsed;
    if (!isProbeFailureSnapshot(parsed) || attempt === 2) return parsed;
    await sleep(options.probeRetryDelayMs);
  }
  return lastSnapshot;
}

function isProbeFailureSnapshot(snapshot) {
  return (
    Array.isArray(snapshot?.rows) &&
    snapshot.rows.length > 0 &&
    snapshot.rows.every(
      (row) =>
        row?.rawStatus === "unknown" &&
        row?.authStatus === "authenticated" &&
        row?.reason === "quota_observation_failed",
    )
  );
}

function runProcess(command, commandArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`process timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr: stderr.trim() });
    });
  });
}

function createRepeatingMacAlarm(soundPath) {
  let active = false;
  const children = new Set();
  let retryTimer;

  function playNext() {
    if (!active) return;
    const child = playChild("/usr/bin/afplay", ["-v", "0.5", soundPath]);
    child.once("close", () => {
      if (active) retryTimer = setTimeout(playNext, 0);
    });
  }

  function playChild(command, args) {
    const child = spawn(command, args, { stdio: "ignore" });
    children.add(child);
    child.once("error", (error) => {
      console.error(`alarm sound failed: ${errorText(error)}`);
    });
    child.once("close", () => children.delete(child));
    return child;
  }

  return {
    get active() {
      return active;
    },
    start() {
      if (active) return;
      active = true;
      playNext();
    },
    stop() {
      active = false;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      for (const child of children) child.kill("SIGTERM");
      children.clear();
    },
  };
}

function notifyMac(title, message) {
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
  child.unref();
}

async function readPersistedState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function persistState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.new`;
  await writeFile(temporaryPath, `${JSON.stringify(persistedAlarmState(state))}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(checkTimer);
  sound.stop();
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

function listen(httpServer, port, host) {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(html);
}

function dashboardHtml(token, currentInstanceId) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Limit Alarm</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #171918; color: #f4f0df; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    header { border-bottom: 1px solid #3b403d; padding: 20px 24px; display: flex; gap: 20px; align-items: center; justify-content: space-between; }
    h1 { font-size: 21px; margin: 0; letter-spacing: 0; }
    .status { display: flex; align-items: center; gap: 9px; font-weight: 650; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #e1b950; flex: 0 0 auto; }
    .dot.ready { background: #63c98b; } .dot.exhausted, .dot.error { background: #ef6c63; }
    main { max-width: 1320px; margin: 0 auto; padding: 24px; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); border: 1px solid #3b403d; border-radius: 6px; overflow: hidden; }
    .metric { min-height: 92px; padding: 16px; border-right: 1px solid #3b403d; background: #202321; }
    .metric:last-child { border-right: 0; }
    .label { color: #aab0ab; font-size: 12px; }
    .value { margin-top: 8px; font-size: 25px; font-weight: 720; }
    .bar { height: 8px; margin-top: 10px; background: #454944; overflow: hidden; border-radius: 3px; }
    .bar > i { display: block; height: 100%; background: #e4c469; }
    .actions { display: flex; gap: 10px; margin: 18px 0; flex-wrap: wrap; }
    button { min-height: 40px; border: 1px solid #525954; border-radius: 6px; padding: 0 16px; background: #292d2a; color: #f4f0df; font: inherit; font-weight: 650; cursor: pointer; }
    button:hover { background: #333834; } button:disabled { opacity: .45; cursor: default; }
    button.stop { background: #a93f38; border-color: #cb5b53; min-width: 128px; }
    button.stop:hover { background: #bb4941; }
    .meta { color: #aab0ab; font-size: 13px; margin-left: auto; align-self: center; }
    .error-message { display: none; padding: 12px 14px; margin-bottom: 16px; border-left: 3px solid #ef6c63; background: #33201f; color: #ffc5c0; }
    .table-wrap { overflow-x: auto; border: 1px solid #3b403d; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; min-width: 940px; }
    th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid #343936; white-space: nowrap; }
    th { color: #aab0ab; font-size: 12px; font-weight: 650; background: #202321; }
    td { font-size: 13px; } tr:last-child td { border-bottom: 0; }
    tr.available td { font-weight: 650; color: #fff8dc; }
    .yes { color: #75d799; } .no { color: #f1837b; }
    .mini-bar { width: 84px; height: 8px; display: inline-block; vertical-align: middle; margin-right: 7px; background: #454944; border-radius: 3px; overflow: hidden; }
    .mini-bar i { display: block; height: 100%; background: #e4c469; }
    @media (max-width: 760px) { header { align-items: flex-start; flex-direction: column; } main { padding: 16px; } .summary { grid-template-columns: 1fr 1fr; } .metric:nth-child(2) { border-right: 0; } .metric:nth-child(-n+2) { border-bottom: 1px solid #3b403d; } .meta { width: 100%; margin-left: 0; } }
  </style>
</head>
<body>
  <header><h1>Codex Limit Alarm</h1><div class="status"><span id="dot" class="dot"></span><span id="status">Запуск</span></div></header>
  <main>
    <section class="summary">
      <div class="metric"><div class="label">Текущий аккаунт</div><div id="account" class="value">-</div></div>
      <div class="metric"><div class="label">5h free</div><div id="five" class="value">-</div><div class="bar"><i id="fiveBar" style="width:0%"></i></div></div>
      <div class="metric"><div class="label">7d free</div><div id="weekly" class="value">-</div><div class="bar"><i id="weeklyBar" style="width:0%"></i></div></div>
      <div class="metric"><div class="label">Следующая проверка</div><div id="next" class="value">-</div></div>
    </section>
    <div class="actions">
      <button id="check">Проверить сейчас</button>
      <button id="test">Тест звука</button>
      <button id="stop" class="stop">Стоп звук</button>
      <div id="checked" class="meta">Еще не проверено</div>
    </div>
    <div id="error" class="error-message"></div>
    <div class="table-wrap"><table><thead><tr><th>Почта</th><th>Буква</th><th>Статус</th><th>5h free</th><th>7d free</th><th>Reset 7d Kyiv</th><th>Доступен</th></tr></thead><tbody id="rows"></tbody></table></div>
  </main>
  <script>
    const token = ${JSON.stringify(token)};
    const instanceId = ${JSON.stringify(currentInstanceId)};
    const els = Object.fromEntries(["dot","status","account","five","fiveBar","weekly","weeklyBar","next","checked","error","rows","check","test","stop"].map(id => [id, document.getElementById(id)]));
    async function post(path) {
      const response = await fetch(path, { method: "POST", headers: { "X-Control-Token": token } });
      if (response.status === 403) { location.reload(); return; }
      if (!response.ok) throw new Error("command failed");
      await refresh();
    }
    els.check.onclick = () => void post("/api/check");
    els.test.onclick = () => void post("/api/alarm/test");
    els.stop.onclick = () => void post("/api/alarm/stop");
    const percent = value => typeof value === "number" ? Math.round(value * 10) / 10 + "%" : "-";
    const time = value => value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kiev", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "-";
    function freeCell(value) {
      const fragment = document.createDocumentFragment();
      if (typeof value !== "number") { fragment.append("-"); return fragment; }
      const bar = document.createElement("span"); bar.className = "mini-bar";
      const fill = document.createElement("i"); fill.style.width = Math.max(0, Math.min(100, value)) + "%";
      bar.append(fill); fragment.append(bar, percent(value)); return fragment;
    }
    function render(data) {
      els.dot.className = "dot " + data.phase;
      els.status.textContent = data.message;
      const current = data.rows?.[0];
      els.account.textContent = current?.email || "-";
      els.account.style.fontSize = current?.email?.length > 24 ? "16px" : "25px";
      const five = current?.fiveHourFreeNumber;
      els.five.textContent = percent(five);
      els.fiveBar.style.width = (typeof five === "number" ? five : 0) + "%";
      const weekly = current?.sevenDayFreeNumber;
      els.weekly.textContent = percent(weekly);
      els.weeklyBar.style.width = (typeof weekly === "number" ? weekly : 0) + "%";
      els.next.textContent = time(data.nextCheckAt);
      els.checked.textContent = data.checkedAt ? "Проверено: " + data.checkedAt + " Kyiv" : "Еще не проверено";
      els.error.style.display = data.lastError ? "block" : "none";
      els.error.textContent = data.lastError || "";
      els.stop.disabled = !data.soundActive;
      els.check.disabled = data.phase === "checking";
      els.rows.replaceChildren();
      for (const row of data.rows || []) {
        const tr = document.createElement("tr"); if (row.available) tr.className = "available";
        const values = [row.email, row.letter, row.status];
        for (const value of values) { const td = document.createElement("td"); td.textContent = value ?? "-"; tr.append(td); }
        const five = document.createElement("td"); five.append(freeCell(row.fiveHourFreeNumber)); tr.append(five);
        const seven = document.createElement("td"); seven.append(freeCell(row.sevenDayFreeNumber)); tr.append(seven);
        const reset = document.createElement("td"); reset.textContent = row.sevenDayReset ?? "-"; tr.append(reset);
        const available = document.createElement("td"); available.textContent = row.available ? "да" : "нет"; available.className = row.available ? "yes" : "no"; tr.append(available);
        els.rows.append(tr);
      }
    }
    let refreshInFlight = false;
    let renderedPayload = "";
    async function refresh() {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("status unavailable");
        const data = await response.json();
        if (data.instanceId !== instanceId) { location.reload(); return; }
        const payload = JSON.stringify(data);
        if (payload !== renderedPayload) { renderedPayload = payload; render(data); }
      } catch {
        els.dot.className = "dot error";
        els.status.textContent = "Нет связи с монитором";
      } finally {
        clearTimeout(timeout);
        refreshInFlight = false;
      }
    }
    async function poll() { await refresh(); setTimeout(poll, 2_000); }
    void poll();
  </script>
</body>
</html>`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      parsed.help = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${item}`);
    parsed[toCamel(item.slice(2))] = value;
    index += 1;
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: node scripts/ops/codex-limit-alarm.mjs [options]

Options:
  --codex-home ~/.codex
  --quota-script /path/to/codex-account-quota-table.mjs
  --interval-ms 600000
  --probe-retry-delay-ms 15000
  --observation-timeout-ms 120000
  --minimum-available 1
  --alert-threshold-percent 10
  --port 47831
  --sound /System/Library/Sounds/Sosumi.aiff`);
}

function stringArg(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(value, fallback, minimum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`invalid numeric argument: ${value}`);
  }
  return Math.trunc(parsed);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function appleScriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeError(error) {
  return errorText(error).replace(/\s+/g, " ").slice(0, 300);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
