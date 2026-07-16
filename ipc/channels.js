'use strict';

/** Renderer 角色；彼此不可直接通訊。 */
const IPC_ROLES = Object.freeze({
  CONTROL: 'control',
  DISPLAY: 'display',
});

/** Display 只依 layout 排版，不根據 message 內容推論業務語意。 */
const PRESENTATION_LAYOUTS = Object.freeze({
  SINGLE_LINE: 'single-line',
  FILL_SCREEN: 'fill-screen',
});

/** Main 對外發布的可見狀態。 */
const PRESENTATION_MODES = Object.freeze({
  BLANK: 'blank',
  PAGE: 'page',
  EMERGENCY: 'emergency',
});

/** 一般訊息清單的整輪播放模式。 */
const PLAYBACK_MODES = Object.freeze({
  CONTINUOUS: 'continuous',
  FINITE: 'finite',
});

/**
 * v2 是多訊息、分頁及整輪次數契約；不得與舊的單一 message v1 混用。
 */
const IPC_CHANNELS = Object.freeze({
  CONTROL_GET_PRESENTATION: 'dc:v2:control:presentation:get',
  CONTROL_START_PROGRAM: 'dc:v2:control:program:start',
  CONTROL_SHOW_EMERGENCY: 'dc:v2:control:emergency:show',
  CONTROL_CLEAR_PRESENTATION: 'dc:v2:control:presentation:clear',
  CONTROL_GET_SETTINGS: 'dc:v2:control:settings:get',
  CONTROL_SAVE_SETTINGS: 'dc:v2:control:settings:save',
  CONTROL_CHOOSE_LOGO: 'dc:v2:control:settings:logo:choose',
  CONTROL_GET_OUTPUT_STATUS: 'dc:v2:control:output-status:get',
  DISPLAY_GET_PRESENTATION: 'dc:v2:display:presentation:get',
  DISPLAY_GET_SETTINGS: 'dc:v2:display:settings:get',
  CONTROL_PRESENTATION_CHANGED: 'dc:v2:control:presentation:changed',
  CONTROL_OUTPUT_STATUS_CHANGED: 'dc:v2:control:output-status:changed',
  DISPLAY_PRESENTATION_CHANGED: 'dc:v2:display:presentation:changed',
  DISPLAY_SETTINGS_CHANGED: 'dc:v2:display:settings:changed',
});

module.exports = {
  IPC_CHANNELS,
  IPC_ROLES,
  PLAYBACK_MODES,
  PRESENTATION_LAYOUTS,
  PRESENTATION_MODES,
};
