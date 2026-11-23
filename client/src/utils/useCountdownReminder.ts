import { onUnmounted, readonly, ref, watch } from 'vue';
import { socket } from './socket';
import { useAiConfig } from './useAiConfig';
import {
  getNextReminderAt,
  normalizeCountdownReminderConfig,
  type CountdownReminderConfig,
} from './countdownReminder';

type NotificationResult = {
  success?: boolean;
  error?: string;
};

const MAX_TIMEOUT_MS = 2_147_483_647;
const scheduledReminderAt = ref<Date | null>(null);
export const nextReminderAt = readonly(scheduledReminderAt);
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

const clearReminderTimer = () => {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
};

const showSystemNotification = (config: CountdownReminderConfig) => {
  socket.emit(
    'notification:show',
    {
      title: config.title,
      body: config.body,
    },
    (result: NotificationResult = {}) => {
      if (!result.success) {
        window.$toast?.warning?.(result.error || config.body, 5000);
      }
    }
  );
};

const scheduleNextReminder = (rawConfig: CountdownReminderConfig) => {
  clearReminderTimer();
  const config = normalizeCountdownReminderConfig(rawConfig);
  const next = getNextReminderAt(new Date(), config);
  scheduledReminderAt.value = next;

  if (!next) return;

  const delay = Math.max(0, next.getTime() - Date.now());
  reminderTimer = setTimeout(() => {
    if (delay > MAX_TIMEOUT_MS) {
      scheduleNextReminder(config);
      return;
    }

    showSystemNotification(config);
    scheduleNextReminder(config);
  }, Math.min(delay, MAX_TIMEOUT_MS));
};

export function useCountdownReminder() {
  const { countdownReminderConfig } = useAiConfig();

  if (!started) {
    started = true;
    watch(
      countdownReminderConfig,
      (config) => scheduleNextReminder(config),
      { deep: true, immediate: true }
    );
  }

  onUnmounted(() => {
    clearReminderTimer();
    scheduledReminderAt.value = null;
    started = false;
  });

  return {
    nextReminderAt,
  };
}
