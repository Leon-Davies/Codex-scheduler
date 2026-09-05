'use strict';

function parseRelativeScheduleTime(value, now) {
  const match = String(value || '').trim().match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('h') ? 60 * 60 * 1000 : 60 * 1000;
  return new Date(now.getTime() + amount * multiplier);
}

function parseLocalScheduleTime(input, now = new Date()) {
  const value = String(input || '').trim();
  if (!value) {
    return null;
  }

  const relative = parseRelativeScheduleTime(value, now);
  if (relative) {
    return relative;
  }

  const timeOnly = /^(\d{1,2}):(\d{2})$/;
  const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/;

  let match = value.match(timeOnly);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      return null;
    }
    const scheduled = new Date(now);
    scheduled.setSeconds(0, 0);
    scheduled.setHours(hour, minute, 0, 0);
    if (scheduled.getTime() <= now.getTime()) {
      scheduled.setDate(scheduled.getDate() + 1);
    }
    return scheduled;
  }

  match = value.match(localDateTime);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      return null;
    }
    const scheduled = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (
      scheduled.getFullYear() !== year ||
      scheduled.getMonth() !== month - 1 ||
      scheduled.getDate() !== day ||
      scheduled.getHours() !== hour ||
      scheduled.getMinutes() !== minute
    ) {
      return null;
    }
    return scheduled;
  }

  return null;
}

function formatLocalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown time';
  }
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = {
  formatLocalDateTime,
  parseLocalScheduleTime,
  parseRelativeScheduleTime,
};
