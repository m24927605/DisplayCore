const SECOND_MILLISECONDS = 1_000;

function isValidClockSettings(settings) {
  if (
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).length !== 1 ||
    typeof settings.enabled !== 'boolean'
  ) {
    return false;
  }

  return true;
}

/** 以 Display 所在電腦的本機時區輸出固定 24 小時 HH:mm:ss。 */
export function formatDisplayDateTime(date) {
  if (
    !(date instanceof Date) ||
    Number.isNaN(date.getTime())
  ) {
    throw new TypeError('日期時間格式化參數不正確。');
  }

  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

/**
 * 建立對齊整秒的本機 Clock。
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

      render(Object.freeze({
        text: formatDisplayDateTime(date),
        dateTime: date.toISOString(),
      }));

      const elapsedInSecond = date.getTime() % SECOND_MILLISECONDS;
      const delay = Math.max(1, SECOND_MILLISECONDS - elapsedInSecond);
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
        typeof settings.enabled !== 'boolean' ||
        !isValidClockSettings(settings)
      ) {
        return false;
      }

      generation += 1;
      cancelTimer();
      enabled = false;

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
    },
  });
}
