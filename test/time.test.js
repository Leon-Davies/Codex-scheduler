'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLocalScheduleTime } = require('../src/scheduler/time');

test('time-only input schedules today when still in the future', () => {
  const now = new Date(2026, 8, 4, 21, 0, 0, 0);
  const result = parseLocalScheduleTime('23:15', now);
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 8);
  assert.equal(result.getDate(), 4);
  assert.equal(result.getHours(), 23);
  assert.equal(result.getMinutes(), 15);
});

test('time-only input rolls to tomorrow when time has passed', () => {
  const now = new Date(2026, 8, 4, 23, 30, 0, 0);
  const result = parseLocalScheduleTime('03:15', now);
  assert.equal(result.getDate(), 5);
  assert.equal(result.getHours(), 3);
});

test('explicit local date/time is parsed strictly', () => {
  const result = parseLocalScheduleTime('2026-09-05 03:15');
  assert.equal(result.getFullYear(), 2026);
  assert.equal(result.getMonth(), 8);
  assert.equal(result.getDate(), 5);
  assert.equal(parseLocalScheduleTime('2026-02-31 03:15'), null);
  assert.equal(parseLocalScheduleTime('25:00'), null);
});

test('relative minute and hour inputs are supported', () => {
  const now = new Date(2026, 8, 5, 9, 30, 0, 0);
  assert.equal(parseLocalScheduleTime('in 20m', now).getTime(), now.getTime() + (20 * 60 * 1000));
  assert.equal(parseLocalScheduleTime('45 mins', now).getTime(), now.getTime() + (45 * 60 * 1000));
  assert.equal(parseLocalScheduleTime('in 2h', now).getTime(), now.getTime() + (2 * 60 * 60 * 1000));
  assert.equal(parseLocalScheduleTime('1.5 hours', now).getTime(), now.getTime() + (90 * 60 * 1000));
});

test('unsupported free-form dates are rejected', () => {
  const now = new Date(2026, 8, 5, 9, 30, 0, 0);
  assert.equal(parseLocalScheduleTime('tomorrow evening', now), null);
  assert.equal(parseLocalScheduleTime('in zero minutes', now), null);
});
