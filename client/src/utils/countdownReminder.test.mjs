import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COUNTDOWN_REMINDER_CONFIG,
  formatReminderCountdown,
  getNextReminderAt,
  normalizeCountdownReminderConfig,
} from './countdownReminder.ts';

const at = (iso) => new Date(iso);
const localStamp = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
};

test('normalizes invalid reminder config to safe defaults', () => {
  const config = normalizeCountdownReminderConfig({
    enabled: true,
    startTime: '25:99',
    endTime: '',
    intervalMinutes: -5,
    title: '',
    body: '  Stretch and drink water  ',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.startTime, DEFAULT_COUNTDOWN_REMINDER_CONFIG.startTime);
  assert.equal(config.endTime, DEFAULT_COUNTDOWN_REMINDER_CONFIG.endTime);
  assert.equal(config.intervalMinutes, DEFAULT_COUNTDOWN_REMINDER_CONFIG.intervalMinutes);
  assert.equal(config.title, DEFAULT_COUNTDOWN_REMINDER_CONFIG.title);
  assert.equal(config.body, 'Stretch and drink water');
});

test('schedules the first reminder at start time when current time is before the work window', () => {
  const next = getNextReminderAt(
    at('2026-07-15T08:30:00'),
    normalizeCountdownReminderConfig({ enabled: true, startTime: '09:00', endTime: '18:00', intervalMinutes: 60 })
  );

  assert.equal(localStamp(next), '2026-07-15-09-00');
});

test('schedules by interval inside the work window', () => {
  const next = getNextReminderAt(
    at('2026-07-15T10:10:00'),
    normalizeCountdownReminderConfig({ enabled: true, startTime: '09:00', endTime: '18:00', intervalMinutes: 45 })
  );

  assert.equal(localStamp(next), '2026-07-15-10-55');
});

test('rolls over to the next day when the next interval would pass the end time', () => {
  const next = getNextReminderAt(
    at('2026-07-15T17:45:00'),
    normalizeCountdownReminderConfig({ enabled: true, startTime: '09:00', endTime: '18:00', intervalMinutes: 30 })
  );

  assert.equal(localStamp(next), '2026-07-16-09-00');
});

test('does not schedule when disabled', () => {
  const next = getNextReminderAt(
    at('2026-07-15T10:10:00'),
    normalizeCountdownReminderConfig({ enabled: false })
  );

  assert.equal(next, null);
});

test('formats the remaining time until the scheduled reminder', () => {
  const now = at('2026-07-15T08:30:00');
  const next = at('2026-07-16T09:00:00');

  assert.equal(formatReminderCountdown(next, now.getTime()), '24:30:00');
  assert.equal(formatReminderCountdown(next, next.getTime() - 200), '00:00:01');
  assert.equal(formatReminderCountdown(next, next.getTime() + 200), '00:00:00');
});
