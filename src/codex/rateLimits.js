'use strict';

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

function getCodexBucket(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return response.rateLimitsByLimitId?.codex || response.rateLimits || null;
}

function listWindows(response) {
  const bucket = getCodexBucket(response);
  if (!bucket) {
    return [];
  }

  return [bucket.primary, bucket.secondary]
    .filter(Boolean)
    .map((window, index) => ({
      slot: index === 0 ? 'primary' : 'secondary',
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
    }));
}

function isReachedType(bucket) {
  return Boolean(bucket?.rateLimitReachedType);
}

function getBlockingWindows(response, threshold = 99.5) {
  return listWindows(response).filter((window) => (
    window.usedPercent !== null && window.usedPercent >= threshold
  ));
}

function isUsageClearlyBlocked(response) {
  const bucket = getCodexBucket(response);
  return isReachedType(bucket) || getBlockingWindows(response).length > 0;
}

function getNextResetMs(response, nowMs = Date.now()) {
  const bucket = getCodexBucket(response);
  const windows = listWindows(response).filter((window) => (
    window.resetsAt !== null && window.resetsAt * 1000 > nowMs - 60_000
  ));
  if (windows.length === 0) {
    return null;
  }

  const blocking = windows.filter((window) => (
    window.usedPercent !== null && window.usedPercent >= 99.5
  ));

  if (blocking.length > 0) {
    return Math.max(...blocking.map((window) => window.resetsAt * 1000));
  }

  if (isReachedType(bucket)) {
    return Math.min(...windows.map((window) => window.resetsAt * 1000));
  }

  const sorted = [...windows].sort((a, b) => {
    const durationA = a.windowDurationMins ?? Number.POSITIVE_INFINITY;
    const durationB = b.windowDurationMins ?? Number.POSITIVE_INFINITY;
    return durationA - durationB || a.resetsAt - b.resetsAt;
  });
  return sorted[0].resetsAt * 1000;
}

function describeWindow(window) {
  if (!window) return 'unknown window';
  const minutes = window.windowDurationMins;
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return minutes ? `${minutes}-minute` : window.slot;
}

function summarizeRateLimits(response) {
  const bucket = getCodexBucket(response);
  const windows = listWindows(response);
  return {
    planType: bucket?.planType || null,
    reachedType: bucket?.rateLimitReachedType || null,
    windows: windows.map((window) => ({
      ...window,
      label: describeWindow(window),
      remainingPercent: window.usedPercent === null ? null : Math.max(0, 100 - window.usedPercent),
    })),
  };
}

module.exports = {
  describeWindow,
  getBlockingWindows,
  getCodexBucket,
  getNextResetMs,
  isUsageClearlyBlocked,
  listWindows,
  summarizeRateLimits,
};
