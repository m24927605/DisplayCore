const MINUTE_MILLISECONDS = 60_000;

function isValidFormattingOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.locale !== 'string' ||
    options.locale.length === 0 ||
    typeof options.hour12 !== 'boolean'
  ) {
    return false;
  }

  try {
    return Intl.getCanonicalLocales(options.locale).length === 1;
  } catch {
    return false;
  }
}

function createFormatter({ locale, hour12 }) {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}

/** 以 Display 所在 Windows 的本機時區格式化日期時間。 */
export function formatDisplayDateTime(date, options) {
  if (
    !(date instanceof Date) ||
    Number.isNaN(date.getTime()) ||
    !isValidFormattingOptions(options)
  ) {
    throw new TypeError('日期時間格式化參數不正確。');
  }

  try {
    return createFormatter(options).format(date);
  } catch {
    throw new TypeError('日期時間格式化參數不正確。');
  }
}

/**
 * 建立對齊整分鐘的本機 Clock。
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
  let formatter = null;
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
    if (disposed || generation !== expectedGeneration || !formatter) {
      return false;
    }

    try {
      const date = now();

      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return false;
      }

      render(Object.freeze({
        text: formatter.format(date),
        dateTime: date.toISOString(),
      }));

      const elapsedInMinute = date.getTime() % MINUTE_MILLISECONDS;
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
        typeof settings.enabled !== 'boolean' ||
        !isValidFormattingOptions(settings)
      ) {
        return false;
      }

      generation += 1;
      cancelTimer();
      formatter = null;

      if (!settings.enabled) {
        try {
          render(null);
          return true;
        } catch {
          return false;
        }
      }

      try {
        formatter = createFormatter(settings);
      } catch {
        return false;
      }

      return renderAndSchedule(generation);
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      generation += 1;
      cancelTimer();
      formatter = null;
    },
  });
}

