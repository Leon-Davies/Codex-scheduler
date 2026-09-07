'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getNextResetMs,
  isUsageClearlyBlocked,
  listWindows,
  summarizeRateLimits,
} = require('../src/codex/rateLimits');

test('selects codex bucket and maps quota windows', () => {
  const response = {
    rateLimitsByLimitId: {
      codex: {
        planType: 'plus',
        primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: 2_000 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 9_000 },
      },
    },
  };

  assert.equal(listWindows(response).length, 2);
  const summary = summarizeRateLimits(response);
  assert.equal(summary.planType, 'plus');
  assert.equal(summary.windows[0].label, '5-hour');
  assert.equal(summary.windows[0].remainingPercent, 28);
  assert.equal(summary.windows[1].label, 'weekly');
});

test('waits until all exhausted windows have reset', () => {
  const response = {
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 9_000 },
    },
  };

  assert.equal(isUsageClearlyBlocked(response), true);
  assert.equal(getNextResetMs(response, 1_000_000), 9_000_000);
});

test('uses shortest window as next refresh when not currently blocked', () => {
  const response = {
    rateLimits: {
      primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 9_000 },
      secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 4_000 },
    },
  };

  assert.equal(getNextResetMs(response, 1_000_000), 4_000_000);
});
