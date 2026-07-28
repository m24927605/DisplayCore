'use strict';

const MACOS_PLATFORM = 'darwin';

/**
 * 取得 Display Window 對應平台的置頂層級。
 *
 * macOS 的 `floating` 層級會低於系統選單列與部分一般視窗；signage 輸出
 * 因此使用 `pop-up-menu`。Windows 保留既有 `floating` 行為。
 *
 * @param {NodeJS.Platform|string} [platform]
 * @returns {'pop-up-menu'|'floating'}
 */
function getDisplayAlwaysOnTopLevel(platform = process.platform) {
  return platform === MACOS_PLATFORM ? 'pop-up-menu' : 'floating';
}

/**
 * 將 Display Window 定位到目標螢幕並進入該平台可靠的全螢幕模式。
 *
 * macOS 對不可聚焦的 signage 視窗可能靜默忽略原生 `setFullScreen`，因此
 * 改用 simple fullscreen，並在呼叫後立即驗證狀態。Windows 則維持既有
 * 原生全螢幕流程，以保留跨螢幕與混合 DPI 的既有行為。
 *
 * @param {Electron.BrowserWindow} displayWindow
 * @param {Electron.Rectangle} targetBounds
 * @param {{platform?: NodeJS.Platform|string}} [options]
 */
function applyDisplayFullscreenPlacement(
  displayWindow,
  targetBounds,
  { platform = process.platform } = {},
) {
  if (platform === MACOS_PLATFORM) {
    displayWindow.setSimpleFullScreen(false);
    displayWindow.setBounds(targetBounds, false);
    displayWindow.setSimpleFullScreen(true);

    if (!displayWindow.isSimpleFullScreen()) {
      throw new Error('macOS Display Window 無法進入簡易全螢幕。');
    }

    return;
  }

  displayWindow.setFullScreen(false);
  displayWindow.setBounds(targetBounds, false);
  displayWindow.setFullScreen(true);
}

module.exports = {
  applyDisplayFullscreenPlacement,
  getDisplayAlwaysOnTopLevel,
};
