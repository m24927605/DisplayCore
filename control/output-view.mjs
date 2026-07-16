const HDMI_STATUSES = new Set([
  'detecting',
  'connected',
  'not-connected',
  'unknown',
]);
const ROUTING_STATUSES = new Set([
  'error',
  'no-target',
  'manual-fallback',
  'unknown',
  'pending',
  'applied',
]);

const HDMI_PRESENTATION = Object.freeze({
  detecting: Object.freeze({ label: '正在偵測 HDMI…', tone: 'detecting' }),
  connected: Object.freeze({ label: 'HDMI 已連接', tone: 'connected' }),
  'not-connected': Object.freeze({ label: 'HDMI 未連接', tone: 'not-connected' }),
  unknown: Object.freeze({ label: 'HDMI 狀態未知', tone: 'unknown' }),
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDisplay(display) {
  return (
    isRecord(display) &&
    Number.isSafeInteger(display.id) &&
    typeof display.label === 'string' &&
    display.label.trim().length > 0
  );
}

function isRenderableStatus(snapshot, ux) {
  return (
    isRecord(snapshot) &&
    Array.isArray(snapshot.displays) &&
    snapshot.displays.every(isDisplay) &&
    (snapshot.effectiveDisplayId === null ||
      Number.isSafeInteger(snapshot.effectiveDisplayId)) &&
    isRecord(snapshot.placement) &&
    (snapshot.placement.displayId === null ||
      Number.isSafeInteger(snapshot.placement.displayId)) &&
    typeof snapshot.placement.fullscreen === 'boolean' &&
    isRecord(ux) &&
    isRecord(ux.hdmi) &&
    HDMI_STATUSES.has(ux.hdmi.status) &&
    isRecord(ux.routing) &&
    ROUTING_STATUSES.has(ux.routing.status)
  );
}

function findTargetDisplay(snapshot) {
  const targetId = snapshot.placement.displayId ?? snapshot.effectiveDisplayId;
  return snapshot.displays.find(({ id }) => id === targetId) ?? null;
}

function getTargetLabel(snapshot, routingStatus, targetDisplay) {
  if (routingStatus === 'no-target') {
    return '沒有可用螢幕';
  }

  if (routingStatus === 'unknown') {
    return '無法取得螢幕資訊';
  }

  if (targetDisplay) {
    return targetDisplay.label;
  }

  return routingStatus === 'pending'
    ? '正在確認輸出目標…'
    : '無法確認輸出目標';
}

function getRoutingPresentation(routingStatus, targetDisplay) {
  const targetLabel = targetDisplay?.label;

  switch (routingStatus) {
    case 'applied':
      return Object.freeze({
        text: targetLabel
          ? `顯示畫面已輸出至「${targetLabel}」。`
          : '顯示畫面的輸出位置已套用。',
        tone: 'applied',
      });
    case 'manual-fallback':
      return Object.freeze({
        text: targetLabel
          ? `原先指定的螢幕目前不可用，已暫時改用「${targetLabel}」。`
          : '原先指定的螢幕目前不可用，已暫時改用其他可用螢幕。',
        tone: 'warning',
      });
    case 'no-target':
      return Object.freeze({
        text: '目前找不到可用的顯示螢幕，請檢查螢幕連線。',
        tone: 'warning',
      });
    case 'error':
      return Object.freeze({
        text: '輸出位置套用失敗，請檢查螢幕連線或輸出設定。',
        tone: 'danger',
      });
    case 'unknown':
      return Object.freeze({
        text: '目前無法確認輸出位置，請稍後重試。',
        tone: 'neutral',
      });
    default:
      return Object.freeze({
        text: '正在套用輸出位置…',
        tone: 'pending',
      });
  }
}

/**
 * 建立只負責輸出狀態卡的 Renderer 視圖。
 *
 * 本模組不讀取 window、不呼叫 IPC，也不判斷實體接頭屬於哪一台螢幕。
 * HDMI 是全域連線結果；目前輸出目標則只使用 placement 與螢幕清單呈現，
 * 因此不會把 DisplayPort、USB-C 或其他外接螢幕誤標為 HDMI。
 */
export function createOutputView({ document }) {
  const elements = Object.freeze({
    panel: document.getElementById('output-status-panel'),
    hdmiBadge: document.getElementById('hdmi-status-badge'),
    hdmiText: document.getElementById('hdmi-status-text'),
    target: document.getElementById('output-target'),
    mode: document.getElementById('output-mode'),
    displayCount: document.getElementById('output-display-count'),
    notice: document.getElementById('output-status-notice'),
    error: document.getElementById('output-status-error'),
    manageButton: document.getElementById('manage-output-settings-button'),
  });

  if (Object.values(elements).some((element) => element === null)) {
    throw new TypeError('輸出狀態卡缺少必要的畫面元素。');
  }

  // 尚未收到第一份可信快照前，避免讓使用者操作尚未初始化的入口。
  elements.manageButton.disabled = true;

  return Object.freeze({
    /**
     * snapshot 是 Main 經 IPC 投影後的唯讀資料；ux 僅提供已衍生的狀態碼。
     * 所有動態文字一律使用 textContent，避免螢幕名稱被解析為 HTML。
     */
    renderOutputStatus(snapshot, ux) {
      if (!isRenderableStatus(snapshot, ux)) {
        return false;
      }

      const hdmiPresentation = HDMI_PRESENTATION[ux.hdmi.status];
      const targetDisplay = findTargetDisplay(snapshot);
      const routingPresentation = getRoutingPresentation(
        ux.routing.status,
        targetDisplay,
      );
      const busy =
        ux.hdmi.status === 'detecting' || ux.routing.status === 'pending';

      elements.hdmiText.textContent = hdmiPresentation.label;
      elements.hdmiBadge.dataset.tone = hdmiPresentation.tone;
      elements.target.textContent = getTargetLabel(
        snapshot,
        ux.routing.status,
        targetDisplay,
      );
      elements.mode.textContent = snapshot.placement.fullscreen
        ? '全螢幕'
        : '視窗模式';
      elements.displayCount.textContent = `${snapshot.displays.length} 台`;
      elements.notice.textContent = routingPresentation.text;
      elements.notice.dataset.tone = routingPresentation.tone;
      elements.notice.hidden = false;
      elements.error.textContent = '';
      elements.error.hidden = true;
      elements.panel.setAttribute('aria-busy', String(busy));
      elements.manageButton.disabled = false;
      return true;
    },

    renderOutputError(message) {
      elements.error.textContent =
        typeof message === 'string' && message.trim().length > 0
          ? message
          : '無法取得輸出狀態，請稍後重試。';
      elements.error.hidden = false;
      elements.notice.hidden = true;
      elements.panel.setAttribute('aria-busy', 'false');
    },
  });
}
