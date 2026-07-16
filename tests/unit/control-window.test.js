'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

async function readControlFile(fileName) {
  return readFile(path.join(projectRoot, 'control', fileName), 'utf8');
}

test('Control 採一鍵立即顯示流程，不再建立待播清單', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /id="operation-welcome-button"[^>]+data-operation-message="歡迎光臨"/);
  assert.match(html, /id="operation-quiet-button"[^>]+data-operation-message="請輕聲細語"/);
  assert.match(html, /<form[^>]+id="message-form"/);
  assert.match(html, /<input[^>]+id="recipient-input"/);
  assert.match(html, /<fieldset[^>]+id="action-fieldset"/);

  for (const action of ['go-to-lobby', 'lobby-code', 'custom']) {
    assert.match(
      html,
      new RegExp(`<input[^>]+name="action"[^>]+value="${action}"`),
    );
  }

  assert.match(html, /<textarea[^>]+id="custom-message-input"/);
  assert.match(html, /<output[^>]+id="message-preview"/);
  assert.match(html, /<button[^>]+id="display-message-button"[^>]+type="submit"/);
  assert.match(html, />\s*顯示\s*<\/button>/);

  for (const removedId of [
    'add-message-button',
    'message-queue',
    'queue-pages',
    'clear-queue-button',
    'start-program-button',
    'playback-form',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
  }
  assert.doesNotMatch(html, /加入清單|待播清單|顯示清單到電視/);
});

test('目前螢幕內容維持單一低密度頁面，每頁最多三則並可逐筆移除', async () => {
  const [html, appSource, css] = await Promise.all([
    readControlFile('index.html'),
    readControlFile('app.mjs'),
    readControlFile('control.css'),
  ]);

  assert.match(html, /<section[^>]+id="current-presentation"/);
  assert.match(html, /id="current-page-summary"/);
  assert.match(html, /id="current-page-summary"[^>]+tabindex="-1"/);
  assert.match(html, /id="current-message-list"/);
  assert.match(html, /id="current-empty-state"/);
  assert.match(html, /<button[^>]+id="clear-display-button"[^>]+type="button"/);
  assert.match(html, /每頁最多[^<]*3 則[^<]*自動分頁/);
  assert.match(html, /id="operation-status"[^>]+role="status"/);
  assert.match(html, /id="operation-error"[^>]+role="alert"/);
  assert.doesNotMatch(html, /current-revision|Main Process|第 6 步/);
  assert.match(html, /id="message-preview"[^>]+tabindex="0"/);
  assert.match(appSource, /text\.tabIndex\s*=\s*0/);
  assert.match(appSource, /item\.dataset\.messageIndex\s*=/);
  assert.match(appSource, /activeCurrentControl/);
  assert.doesNotMatch(
    appSource,
    /settingsDialog\.addEventListener\(\s*['"]close['"],\s*clearPlaybackErrors/,
    '延遲送達的 dialog close 事件不得清除下一個生命週期的新錯誤',
  );
  assert.match(
    css,
    /\.message-preview,\s*\.current-message-text\s*{[^}]*overflow-x:\s*auto[^}]*text-overflow:\s*clip/s,
  );
});

test('555 與 888 保留獨立按鈕及確認對話框', async () => {
  const html = await readControlFile('index.html');

  assert.ok(
    html.indexOf('id="inspection-555-button"') <
      html.indexOf('id="message-form"'),
  );
  assert.match(html, /id="inspection-555-button"[^>]+data-emergency-code="555"/);
  assert.match(html, /id="inspection-888-button"[^>]+data-emergency-code="888"/);
  assert.match(html, /<dialog[^>]+id="inspection-confirm-dialog"/);
  assert.match(html, /id="inspection-code-preview"/);
  assert.match(html, /id="inspection-confirm-button"/);
  assert.match(html, /id="inspection-cancel-button"[^>]+autofocus/);
});

test('HDMI 與實際輸出只讀顯示，完全沒有手動螢幕或全螢幕控制', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /id="hdmi-status-badge"[^>]+data-tone="detecting"/);
  assert.match(html, /id="hdmi-status-text"/);
  assert.match(html, /id="output-target"/);
  assert.match(html, /<button[^>]+id="open-settings-button"[^>]+type="button"/);

  for (const removedId of [
    'output-status-panel',
    'manage-output-settings-button',
    'display-settings-fieldset',
    'display-auto-input',
    'display-manual-input',
    'default-display-select',
    'display-fullscreen-input',
    'output-mode',
    'output-display-count',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
  }
  assert.doesNotMatch(html, /指定輸出螢幕|視窗模式|管理輸出設定/);
});

test('齒輪設定保留播放、Logo、外觀與顯示行為，播放設定不佔主畫面', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /<dialog[^>]+id="settings-dialog"/);
  assert.match(html, /<form[^>]+id="settings-form"[^>]+novalidate/);

  for (const fieldsetId of [
    'playback-settings-fieldset',
    'logo-settings-fieldset',
    'appearance-settings-fieldset',
    'behavior-settings-fieldset',
  ]) {
    assert.match(html, new RegExp(`<fieldset[^>]+id="${fieldsetId}"`));
  }

  assert.match(html, /id="page-duration-input"[^>]+min="1"[^>]+max="3600"/);
  assert.match(html, /id="page-duration-input"[^>]+aria-describedby="page-duration-error"/);
  assert.match(html, /name="repeat-mode"[^>]+value="finite"/);
  assert.match(html, /name="repeat-mode"[^>]+value="continuous"/);
  assert.match(html, /id="repeat-mode-fieldset"[^>]+aria-describedby="repeat-error"/);
  assert.match(html, /id="round-count-input"[^>]+min="1"[^>]+max="999"/);
  assert.match(html, /id="round-count-input"[^>]+aria-describedby="round-count-error"/);

  for (const inputId of [
    'logo-enabled-input',
    'logo-path-input',
    'background-color-input',
    'font-family-select',
    'font-color-input',
    'minimum-font-size-input',
    'date-time-enabled-input',
    'hour12-input',
    'marquee-enabled-input',
  ]) {
    assert.match(html, new RegExp(`id="${inputId}"`));
  }
});

test('Control 只載入本機 module，Renderer 僅使用最小權限 bridge', async () => {
  const [html, appSource] = await Promise.all([
    readControlFile('index.html'),
    readControlFile('app.mjs'),
  ]);

  assert.match(html, /<script[^>]+type="module"[^>]+src="\.\/app\.mjs"/);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(appSource, /window\.displayCoreControl/);
  assert.match(appSource, /\.textContent\s*=/);
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(appSource, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b/);
});

test('Control 樣式具響應式、可存取與精確動效細節', async () => {
  const css = await readControlFile('control.css');

  assert.match(css, /display:\s*grid/);
  assert.match(css, /display:\s*flex/);
  assert.match(css, /@media\s*\([^)]*max-width/);
  assert.match(css, /clamp\(/);
  assert.match(css, /min-block-size:\s*2\.75rem/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /text-wrap:\s*balance/);
  assert.match(css, /text-wrap:\s*pretty/);
  assert.match(css, /scale\(0\.96\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.control-layout\s*{[^}]*grid-template-columns:/s);
  assert.match(css, /\.current-message-text\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(
    css,
    /\.action-fieldset:disabled\s+\.action-option\s*{[^}]*cursor:\s*not-allowed[^}]*opacity:/s,
  );
  assert.match(css, /outline:\s*0\.1875rem solid #1d4ed8/);
  assert.match(css, /#settings-dialog\s*{[^}]*max-block-size:/s);
  assert.match(css, /\.settings-dialog-body\s*{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/);
  assert.doesNotMatch(css, /will-change:\s*all\b/);
});
