const MINUTE_MILLISECONDS = 60_000;
const MINIMUM_CLOCK_OFFSET_SECONDS = -43_199;
const MAXIMUM_CLOCK_OFFSET_SECONDS = 43_200;
const SECONDS_PER_DAY = 86_400;

function isValidClockSettings(settings) {
  if (
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).length !== 2 ||
    typeof settings.enabled !== 'boolean' ||
    !Number.isSafeInteger(settings.offsetSeconds) ||
    settings.offsetSeconds < MINIMUM_CLOCK_OFFSET_SECONDS ||
    settings.offsetSeconds > MAXIMUM_CLOCK_OFFSET_SECONDS
  ) {
    return false;
  }

  return true;
}

/** 以 Display 所在電腦的本機時區輸出固定 24 小時 HH:mm。 */
export function formatDisplayDateTime(date, offsetSeconds = 0) {
  if (
    !(date instanceof Date) ||
    Number.isNaN(date.getTime()) ||
    !Number.isSafeInteger(offsetSeconds) ||
    offsetSeconds < MINIMUM_CLOCK_OFFSET_SECONDS ||
    offsetSeconds > MAXIMUM_CLOCK_OFFSET_SECONDS
  ) {
    throw new TypeError('日期時間格式化參數不正確。');
  }

  const localSeconds =
    date.getHours() * 3_600 + date.getMinutes() * 60 + date.getSeconds();
  const adjustedSeconds =
    (localSeconds + offsetSeconds + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const parts = [
    Math.floor(adjustedSeconds / 3_600),
    Math.floor((adjustedSeconds % 3_600) / 60),
  ];
  return parts
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

/**
 * 建立對齊校正後整分鐘的本機 Clock。
 *
 * 使用遞迴 timeout 而非 interval；電腦睡眠喚醒後會以新的現在時間重新校準，
 * 不累積計時漂移。停用或切換 emergency/blank 時可立即停止 timer。
 */
export function createDisplayClock({
  render,
  now = () => new Date(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
}) {
  if (
    typeof render !== 'function' ||
    typeof now !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function'
  ) {
    throw new TypeError('Clock 缺少必要相依物件。');
  }

  let timer = null;
  let enabled = false;
  let offsetSeconds = 0;
  let disposed = false;
  let generation = 0;

  function cancelTimer() {
    if (timer === null) {
      return;
    }

    try {
      clearTimer(timer);
    } catch {
      // 舊 timer 的 generation 已失效，即使無法取消也不會再更新畫面。
    }

    timer = null;
  }

  function renderAndSchedule(expectedGeneration) {
    if (disposed || generation !== expectedGeneration || !enabled) {
      return false;
    }

    try {
      const date = now();

      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return false;
      }

      const text = formatDisplayDateTime(date, offsetSeconds);
      render(Object.freeze({ text, dateTime: text }));

      const adjustedMilliseconds =
        date.getTime() + (offsetSeconds * 1_000);
      const elapsedInMinute = (
        (adjustedMilliseconds % MINUTE_MILLISECONDS) + MINUTE_MILLISECONDS
      ) % MINUTE_MILLISECONDS;
      const delay = Math.max(1, MINUTE_MILLISECONDS - elapsedInMinute);
      timer = setTimer(() => {
        timer = null;
        renderAndSchedule(expectedGeneration);
      }, delay);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    update(settings) {
      if (
        disposed ||
        settings === null ||
        typeof settings !== 'object' ||
        Array.isArray(settings) ||
        !isValidClockSettings(settings)
      ) {
        return false;
      }

      generation += 1;
      cancelTimer();
      enabled = false;
      offsetSeconds = settings.offsetSeconds;

      if (!settings.enabled) {
        try {
          render(null);
          return true;
        } catch {
          return false;
        }
      }

      enabled = true;

      return renderAndSchedule(generation);
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      generation += 1;
      cancelTimer();
      enabled = false;
      offsetSeconds = 0;
    },
  });
}
