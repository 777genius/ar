export const AlarmEffect = Object.freeze({
  None: "none",
  Start: "start",
  Stop: "stop",
});

export function initialAlarmState(persisted = {}) {
  return {
    exhausted: Boolean(persisted.exhausted),
    acknowledged: Boolean(persisted.acknowledged),
    sounding: false,
  };
}

export function summarizeQuotaRows(
  rows,
  minimumAvailable = 1,
  alertThresholdPercent = 10,
) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const availableCount = normalizedRows.filter((row) => row?.available === true).length;
  const limitedCount = normalizedRows.filter(
    (row) => row?.rawStatus === "limited",
  ).length;
  const uncertainCount = normalizedRows.filter(isUncertainRow).length;
  const measuredRows = normalizedRows.filter(
    (row) => typeof row?.sevenDayFreeNumber === "number" &&
      Number.isFinite(row.sevenDayFreeNumber),
  );
  const totalWeeklyFree = measuredRows.reduce(
    (sum, row) => sum + clampPercent(row.sevenDayFreeNumber),
    0,
  );
  const measuredWeeklyFreePercent = measuredRows.length > 0
    ? totalWeeklyFree / measuredRows.length
    : null;
  const poolWeeklyFreeLowerBound = normalizedRows.length > 0
    ? totalWeeklyFree / normalizedRows.length
    : null;
  const normalizedThreshold = normalizePercent(alertThresholdPercent);
  const belowThresholdRows = normalizedRows.filter(
    (row) => isBelowThreshold(row, normalizedThreshold),
  );
  const alertReadyCount = normalizedRows.filter(
    (row) => row?.available === true && !isBelowThreshold(row, normalizedThreshold),
  ).length;

  return {
    totalCount: normalizedRows.length,
    availableCount,
    limitedCount,
    unavailableCount: normalizedRows.length - availableCount,
    uncertainCount,
    measuredCount: measuredRows.length,
    measuredWeeklyFreePercent,
    poolWeeklyFreeLowerBound,
    alertThresholdPercent: normalizedThreshold,
    belowThresholdCount: belowThresholdRows.length,
    exhausted:
      belowThresholdRows.length > 0 &&
      alertReadyCount < normalizeMinimumAvailable(minimumAvailable),
  };
}

export function applyPoolSummary(state, summary) {
  if (!summary.exhausted) {
    return {
      state: {
        exhausted: false,
        acknowledged: false,
        sounding: false,
      },
      effect: state.sounding ? AlarmEffect.Stop : AlarmEffect.None,
    };
  }

  if (state.acknowledged) {
    return {
      state: {
        exhausted: true,
        acknowledged: true,
        sounding: false,
      },
      effect: state.sounding ? AlarmEffect.Stop : AlarmEffect.None,
    };
  }

  return {
    state: {
      exhausted: true,
      acknowledged: false,
      sounding: true,
    },
    effect: state.sounding ? AlarmEffect.None : AlarmEffect.Start,
  };
}

export function acknowledgeAlarm(state) {
  return {
    state: {
      exhausted: state.exhausted,
      acknowledged: state.exhausted,
      sounding: false,
    },
    effect: state.sounding ? AlarmEffect.Stop : AlarmEffect.None,
  };
}

export function persistedAlarmState(state) {
  return {
    exhausted: state.exhausted,
    acknowledged: state.acknowledged,
  };
}

function isUncertainRow(row) {
  if (!row || row.available === true) return false;
  if (row.rawStatus && row.rawStatus !== "unknown") return false;
  if (row.authStatus === "relogin_required" || row.authStatus === "unavailable") {
    return false;
  }
  return true;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function isBelowThreshold(row, threshold) {
  if (!row || isUncertainRow(row)) return false;
  if (row.authStatus === "relogin_required" || row.authStatus === "unavailable") {
    return false;
  }
  if (row.rawStatus === "limited") return true;
  return [row.fiveHourFreeNumber, row.sevenDayFreeNumber].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value < threshold,
  );
}

function normalizePercent(value) {
  if (!Number.isFinite(value)) return 10;
  return clampPercent(value);
}

function normalizeMinimumAvailable(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}
