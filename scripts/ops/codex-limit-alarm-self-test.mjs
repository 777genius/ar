#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  AlarmEffect,
  acknowledgeAlarm,
  applyPoolSummary,
  initialAlarmState,
  persistedAlarmState,
  setAlarmEnabled,
  summarizeQuotaRows,
} from "./codex-limit-alarm-state.mjs";

const available = {
  available: true,
  rawStatus: "available",
  authStatus: "authenticated",
  sevenDayFreeNumber: 80,
};
const limited = {
  available: false,
  rawStatus: "limited",
  authStatus: "authenticated",
  sevenDayFreeNumber: 0,
};
const missing = {
  available: false,
  rawStatus: "unknown",
  authStatus: "unavailable",
  sevenDayFreeNumber: null,
};
const uncertain = {
  available: false,
  rawStatus: "unknown",
  authStatus: "unknown",
  sevenDayFreeNumber: null,
};
const relogin = {
  available: false,
  rawStatus: "relogin_required",
  authStatus: "relogin_required",
  sevenDayFreeNumber: null,
};
const lowWeekly = {
  ...available,
  sevenDayFreeNumber: 9,
};
const thresholdWeekly = {
  ...available,
  sevenDayFreeNumber: 10,
};
const lowFiveHour = {
  ...available,
  fiveHourFreeNumber: 9,
};

{
  const summary = summarizeQuotaRows([available, limited, missing]);
  assert.equal(summary.availableCount, 1);
  assert.equal(summary.exhausted, false);
  assert.equal(summary.measuredWeeklyFreePercent, 40);
  assert.equal(summary.poolWeeklyFreeLowerBound, 80 / 3);
}

{
  const summary = summarizeQuotaRows([limited, missing]);
  const disabledByDefault = applyPoolSummary(initialAlarmState(), summary);
  assert.equal(
    initialAlarmState().enabled,
    false,
    "alarm must be disabled by default on a fresh install",
  );
  assert.equal(disabledByDefault.effect, AlarmEffect.None, "must not sound while disabled");
  assert.equal(disabledByDefault.state.exhausted, true, "dashboard must still reflect real quota state");
  assert.equal(disabledByDefault.state.sounding, false);

  const armedWhileExhausted = setAlarmEnabled(disabledByDefault.state, true);
  assert.equal(
    armedWhileExhausted.effect,
    AlarmEffect.Start,
    "enabling while already exhausted must start sounding immediately",
  );
  assert.equal(armedWhileExhausted.state.sounding, true);

  const transition = applyPoolSummary(armedWhileExhausted.state, summary);
  assert.equal(summary.exhausted, true);
  assert.equal(transition.effect, AlarmEffect.None, "already sounding, no new effect");
  assert.equal(transition.state.sounding, true);

  const stable = applyPoolSummary(transition.state, summary);
  assert.equal(stable.effect, AlarmEffect.None);

  const acknowledged = acknowledgeAlarm(stable.state);
  assert.equal(acknowledged.effect, AlarmEffect.Stop);
  assert.equal(acknowledged.state.acknowledged, true);
  assert.equal(acknowledged.state.enabled, true, "acknowledge must not disarm the alarm");

  const stillExhausted = applyPoolSummary(acknowledged.state, summary);
  assert.equal(stillExhausted.effect, AlarmEffect.None);
  assert.equal(stillExhausted.state.sounding, false);

  const recovered = applyPoolSummary(
    stillExhausted.state,
    summarizeQuotaRows([available, limited]),
  );
  assert.equal(recovered.state.acknowledged, false);

  const exhaustedAgain = applyPoolSummary(
    recovered.state,
    summarizeQuotaRows([limited, missing]),
  );
  assert.equal(exhaustedAgain.effect, AlarmEffect.Start);

  const disabledWhileSounding = setAlarmEnabled(exhaustedAgain.state, false);
  assert.equal(disabledWhileSounding.effect, AlarmEffect.Stop, "disabling must silence an active alarm");
  assert.equal(disabledWhileSounding.state.sounding, false);
  assert.equal(disabledWhileSounding.state.enabled, false);

  const noopToggle = setAlarmEnabled(disabledWhileSounding.state, false);
  assert.equal(noopToggle.effect, AlarmEffect.None, "toggling to the same value is a no-op");
}

{
  const allUnknown = summarizeQuotaRows([uncertain, uncertain]);
  assert.equal(allUnknown.exhausted, false, "probe outage must not trigger alarm");
  const authFailure = summarizeQuotaRows([relogin]);
  assert.equal(authFailure.exhausted, false, "relogin must not trigger quota alarm");
}

{
  const lowWeeklySummary = summarizeQuotaRows([lowWeekly]);
  assert.equal(lowWeeklySummary.exhausted, true, "9% weekly free must trigger alarm");
  assert.equal(lowWeeklySummary.belowThresholdCount, 1);

  const exactThresholdSummary = summarizeQuotaRows([thresholdWeekly]);
  assert.equal(exactThresholdSummary.exhausted, false, "10% free must not trigger alarm");

  const lowFiveHourSummary = summarizeQuotaRows([lowFiveHour]);
  assert.equal(lowFiveHourSummary.exhausted, true, "9% five-hour free must trigger alarm");

  const healthyFallback = summarizeQuotaRows([lowWeekly, available]);
  assert.equal(
    healthyFallback.exhausted,
    false,
    "another healthy account must satisfy the configured minimum",
  );
}

{
  const restored = initialAlarmState({ enabled: true, exhausted: true, acknowledged: true });
  const transition = applyPoolSummary(restored, summarizeQuotaRows([limited]));
  assert.equal(transition.effect, AlarmEffect.None);
  assert.deepEqual(persistedAlarmState(transition.state), {
    enabled: true,
    exhausted: true,
    acknowledged: true,
  });
}

{
  const freshInstall = initialAlarmState({});
  assert.deepEqual(persistedAlarmState(freshInstall), {
    enabled: false,
    exhausted: false,
    acknowledged: false,
  });
}

console.log("codex-limit-alarm self-test: ok");
