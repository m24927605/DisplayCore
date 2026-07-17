const CLOCK_TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2})$/;
const SECONDS_PER_DAY = 86_400;
const HALF_DAY_SECONDS = 43_200;

function isSecondOfDay(value) {
  return Number.isSafeInteger(value) && value >= 0 && value < SECONDS_PER_DAY;
}

/** 將固定 24 小時 HH:mm:ss 解析為當日秒數；格式不完整時回傳 null。 */
export function parseClockTime(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = CLOCK_TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }

  return hours * 3_600 + minutes * 60 + seconds;
}

/** 將當日秒數格式化為固定 24 小時 HH:mm:ss。 */
export function formatClockTime(value) {
  if (!isSecondOfDay(value)) {
    return null;
  }

  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  const seconds = value % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * 以最短日內距離建立唯一偏移；相差正負 12 小時時固定採 +43200。
 */
export function calculateClockOffsetSeconds(targetSeconds, currentSeconds) {
  if (!isSecondOfDay(targetSeconds) || !isSecondOfDay(currentSeconds)) {
    return null;
  }

  let offset = targetSeconds - currentSeconds;
  if (offset > HALF_DAY_SECONDS) {
    offset -= SECONDS_PER_DAY;
  } else if (offset <= -HALF_DAY_SECONDS) {
    offset += SECONDS_PER_DAY;
  }

  return offset;
}
