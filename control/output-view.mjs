const HDMI_PRESENTATION = Object.freeze({
  detecting: Object.freeze({ label: '正在偵測 HDMI…', tone: 'detecting' }),
  connected: Object.freeze({ label: 'HDMI 已連接', tone: 'connected' }),
  'not-connected': Object.freeze({ label: 'HDMI 未連接', tone: 'not-connected' }),
  unknown: Object.freeze({ label: 'HDMI 無法判定', tone: 'unknown' }),
});
const ROUTING_STATUSES = new Set([
  'error',
  'no-target',
  'manual-fallback',
  'unknown',
  'pending',
  'applied',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRenderable(snapshot, ux) {
  return (
    isRecord(snapshot) &&
    Array.isArray(snapshot.displays) &&
    snapshot.displays.every((display) =>
      isRecord(display) &&
      Number.isSafeInteger(display.id) &&
      typeof display.label === 'string' &&
      display.label.trim().length > 0) &&
    (snapshot.effectiveDisplayId === null ||
      Number.isSafeInteger(snapshot.effectiveDisplayId)) &&
    isRecord(snapshot.placement) &&
    (snapshot.placement.displayId === null ||
      Number.isSafeInteger(snapshot.placement.displayId)) &&
    isRecord(ux) &&
    isRecord(ux.hdmi) &&
    Object.hasOwn(HDMI_PRESENTATION, ux.hdmi.status) &&
    isRecord(ux.routing) &&
    ROUTING_STATUSES.has(ux.routing.status)
  );
}

/** Header 只讀輸出狀態，不提供螢幕選擇或全螢幕控制。 */
export function createOutputView({ document }) {
  const elements = Object.freeze({
    cluster: document.getElementById('output-status-cluster'),
    hdmiBadge: document.getElementById('hdmi-status-badge'),
    hdmiText: document.getElementById('hdmi-status-text'),
    target: document.getElementById('output-target'),
    notice: document.getElementById('output-status-notice'),
    error: document.getElementById('output-status-error'),
  });

  if (Object.values(elements).some((element) => element === null)) {
    throw new TypeError('唯讀輸出狀態缺少必要的畫面元素。');
  }

  return Object.freeze({
    renderOutputStatus(snapshot, ux) {
      if (!isRenderable(snapshot, ux)) {
        return false;
      }

      const hdmi = HDMI_PRESENTATION[ux.hdmi.status];
      const targetId = snapshot.placement.displayId ??
        snapshot.effectiveDisplayId;
      const target = snapshot.displays.find(({ id }) => id === targetId);
      const busy = ux.hdmi.status === 'detecting' ||
        ux.routing.status === 'pending';

      elements.hdmiText.textContent = hdmi.label;
      elements.hdmiBadge.dataset.tone = hdmi.tone;
      elements.target.textContent = ux.routing.status === 'error'
        ? `${target?.label ?? '螢幕'} · 輸出失敗`
        : target?.label ?? (
          ux.routing.status === 'no-target'
            ? '沒有可用螢幕'
            : '正在確認輸出位置…'
        );
      elements.notice.textContent = ux.routing.status === 'error'
        ? '畫面輸出失敗，請檢查螢幕連接。'
        : '';
      elements.notice.hidden = elements.notice.textContent.length === 0;
      elements.error.textContent = '';
      elements.error.hidden = true;
      elements.cluster.setAttribute('aria-busy', String(busy));
      return true;
    },

    renderOutputError(message) {
      elements.hdmiText.textContent = HDMI_PRESENTATION.unknown.label;
      elements.hdmiBadge.dataset.tone = HDMI_PRESENTATION.unknown.tone;
      elements.target.textContent = '無法取得輸出狀態';
      elements.error.textContent =
        typeof message === 'string' && message.trim().length > 0
          ? message
          : '無法取得輸出狀態，請稍後重試。';
      elements.error.hidden = false;
      elements.notice.hidden = true;
      elements.cluster.setAttribute('aria-busy', 'false');
    },
  });
}
