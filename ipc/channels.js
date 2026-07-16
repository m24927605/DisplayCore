'use strict';

/**
 * IPC 角色。
 *
 * Renderer 彼此不直接通訊；Main 依角色授權每一個固定 channel。
 */
const IPC_ROLES = Object.freeze({
  CONTROL: 'control',
  DISPLAY: 'display',
});

/**
 * Presentation 只有一個 message；layout 僅描述排版方式，不解析文字語意。
 * fill-screen 供臨檢 555、解除臨檢 888 等滿屏畫面使用，但 IPC 不判斷代碼。
 */
const PRESENTATION_LAYOUTS = Object.freeze({
  SINGLE_LINE: 'single-line',
  FILL_SCREEN: 'fill-screen',
});

/**
 * 所有 channel 都使用版本命名空間，避免未來契約變更互相衝突。
 */
const IPC_CHANNELS = Object.freeze({
  CONTROL_GET_PRESENTATION: 'dc:v1:control:presentation:get',
  CONTROL_SHOW_MESSAGE: 'dc:v1:control:message:show',
  CONTROL_CLEAR_MESSAGE: 'dc:v1:control:message:clear',
  DISPLAY_GET_PRESENTATION: 'dc:v1:display:presentation:get',
  CONTROL_PRESENTATION_CHANGED: 'dc:v1:control:presentation:changed',
  DISPLAY_PRESENTATION_CHANGED: 'dc:v1:display:presentation:changed',
});

module.exports = {
  IPC_CHANNELS,
  IPC_ROLES,
  PRESENTATION_LAYOUTS,
};
