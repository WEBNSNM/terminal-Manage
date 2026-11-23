export type CountdownReminderConfig = {
  enabled: boolean;
  startTime: string;
  endTime: string;
  intervalMinutes: number;
  title: string;
  body: string;
};

export const DEFAULT_COUNTDOWN_REMINDER_CONFIG: CountdownReminderConfig = {
  enabled: false,
  startTime: '09:00',
  endTime: '18:00',
  intervalMinutes: 60,
  title: '倒计时结束',
  body: '该休息一下了',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 720;

const isValidTime = (value: unknown): value is string =>
  typeof value === 'string' && TIME_PATTERN.test(value);

const parseMinutesOfDay = (value: string) => {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const withTime = (base: Date, minutesOfDay: number) => {
  const next = new Date(base);
  next.setHours(Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0);
  return next;
};

const nextDayStart = (base: Date, startMinutes: number) => {
  const next = withTime(base, startMinutes);
  next.setDate(next.getDate() + 1);
  return next;
};

export const normalizeCountdownReminderConfig = (input: unknown): CountdownReminderConfig => {
  const value = input && typeof input === 'object' ? input as Partial<CountdownReminderConfig> : {};
  const interval = Number(value.intervalMinutes);
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';

  return {
    enabled: value.enabled === true,
    startTime: isValidTime(value.startTime) ? value.startTime : DEFAULT_COUNTDOWN_REMINDER_CONFIG.startTime,
    endTime: isValidTime(value.endTime) ? value.endTime : DEFAULT_COUNTDOWN_REMINDER_CONFIG.endTime,
    intervalMinutes: Number.isFinite(interval) && interval >= MIN_INTERVAL_MINUTES
      ? Math.min(MAX_INTERVAL_MINUTES, Math.round(interval))
      : DEFAULT_COUNTDOWN_REMINDER_CONFIG.intervalMinutes,
    title: title || DEFAULT_COUNTDOWN_REMINDER_CONFIG.title,
    body: body || DEFAULT_COUNTDOWN_REMINDER_CONFIG.body,
  };
};

export const getNextReminderAt = (
  now: Date,
  rawConfig: CountdownReminderConfig
): Date | null => {
  const config = normalizeCountdownReminderConfig(rawConfig);
  if (!config.enabled) return null;

  const startMinutes = parseMinutesOfDay(config.startTime);
  const endMinutes = parseMinutesOfDay(config.endTime);
  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) return null;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (currentMinutes < startMinutes) return withTime(now, startMinutes);
  if (currentMinutes >= endMinutes) return nextDayStart(now, startMinutes);

  const next = new Date(now.getTime() + config.intervalMinutes * 60 * 1000);
  const nextMinutes = next.getHours() * 60 + next.getMinutes();
  const crossedDay = next.getDate() !== now.getDate()
    || next.getMonth() !== now.getMonth()
    || next.getFullYear() !== now.getFullYear();

  if (crossedDay || nextMinutes > endMinutes) return nextDayStart(now, startMinutes);

  next.setSeconds(0, 0);
  return next;
};

export const formatReminderCountdown = (next: Date, now: number) => {
  const seconds = Math.max(0, Math.ceil((next.getTime() - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours, minutes, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
};
