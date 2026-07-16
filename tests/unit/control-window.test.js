'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

async function readControlFile(fileName) {
  return readFile(path.join(projectRoot, 'control', fileName), 'utf8');
}

function parseHexColor(hexColor) {
  return [1, 3, 5].map((start) =>
    Number.parseInt(hexColor.slice(start, start + 2), 16) / 255,
  );
}

function relativeLuminance(hexColor) {
  return parseHexColor(hexColor)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (luminance, channel, index) =>
        luminance + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}

function contrastRatio(firstColor, secondColor) {
  const luminances = [
    relativeLuminance(firstColor),
    relativeLuminance(secondColor),
  ].sort((first, second) => second - first);

  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test('Control HTML 將單則編輯、待播清單與播放設定分成明確區域', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /<form[^>]+id="message-form"/);
  assert.match(html, /<label[^>]+for="recipient-input"/);
  assert.match(html, /<input[^>]+id="recipient-input"/);
  assert.match(html, /<fieldset[^>]+id="action-fieldset"/);
  assert.match(html, /<legend[^>]*>[^<]*動作指令/);

  for (const action of ['go-to-lobby', 'lobby-code', 'custom']) {
    assert.match(
      html,
      new RegExp(`<input[^>]+name="action"[^>]+value="${action}"`),
    );
  }

  assert.match(html, /<label[^>]+for="custom-message-input"/);
  assert.match(html, /<textarea[^>]+id="custom-message-input"/);
  assert.match(html, /<output[^>]+id="message-preview"/);
  assert.match(html, /<button[^>]+id="add-message-button"[^>]+type="submit"/);

  assert.match(html, /<section[^>]+id="message-queue"/);
  assert.match(html, /id="queue-pages"/);
  assert.match(html, /id="queue-empty-state"[^>]+role="status"/);
  assert.match(html, /id="queue-message-count"/);
  assert.match(html, /id="queue-page-count"/);
  assert.match(html, /<button[^>]+id="clear-queue-button"[^>]+type="button"/);

  assert.match(html, /<form[^>]+id="playback-form"/);
  assert.match(html, /<label[^>]+for="page-duration-input"/);
  assert.match(
    html,
    /<input[^>]+id="page-duration-input"[^>]+type="number"[^>]+min="1"[^>]+max="3600"/,
  );
  assert.match(html, /<fieldset[^>]+id="repeat-mode-fieldset"/);

  for (const mode of ['finite', 'continuous']) {
    assert.match(
      html,
      new RegExp(`<input[^>]+name="repeat-mode"[^>]+value="${mode}"`),
    );
  }

  assert.match(html, /<label[^>]+for="round-count-input"/);
  assert.match(
    html,
    /<input[^>]+id="round-count-input"[^>]+type="number"[^>]+min="1"[^>]+max="999"/,
  );
  assert.match(html, /id="round-duration"/);
  assert.match(html, /id="total-duration"/);
  assert.match(html, /<button[^>]+id="start-program-button"[^>]+type="submit"/);
  assert.match(html, /<button[^>]+id="clear-display-button"[^>]+type="button"/);
});

test('Control 將目前 Main 狀態與尚未送出的預覽清楚分開', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /id="current-presentation"/);
  assert.match(html, /id="current-message"/);
  assert.match(html, /id="current-layout"/);
  assert.match(html, /id="current-revision"/);
  assert.match(html, /id="current-page-progress"/);
  assert.match(html, /id="current-round-progress"/);
  assert.match(html, /id="operation-status"[^>]+role="status"/);
  assert.match(html, /aria-live="polite"/);
});

test('555 與 888 使用獨立按鈕及原生確認對話框防止誤觸', async () => {
  const html = await readControlFile('index.html');

  assert.ok(
    html.indexOf('id="inspection-actions"') <
      html.indexOf('id="message-form"'),
    '最小視窗的閱讀與鍵盤順序必須先到達緊急操作',
  );

  assert.match(
    html,
    /<button[^>]+id="inspection-555-button"[^>]+data-emergency-code="555"[^>]+type="button"/,
  );
  assert.match(
    html,
    /<button[^>]+id="inspection-888-button"[^>]+data-emergency-code="888"[^>]+type="button"/,
  );
  assert.match(html, /<dialog[^>]+id="inspection-confirm-dialog"/);
  assert.match(html, /id="inspection-dialog-title"/);
  assert.match(html, /id="inspection-code-preview"/);
  assert.match(html, /id="inspection-dialog-error"[^>]+role="alert"/);
  assert.match(html, /id="inspection-confirm-button"/);
  assert.match(html, /id="inspection-cancel-button"[^>]+autofocus/);
});

test('第 8 步提供可即時套用的獨立系統設定對話框與完整可存取欄位', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /<section[^>]+id="settings-launch"/);
  assert.match(html, /<button[^>]+id="open-settings-button"[^>]+type="button"/);
  assert.match(html, /<dialog[^>]+id="settings-dialog"/);
  assert.match(html, /<form[^>]+id="settings-form"[^>]+novalidate/);

  for (const fieldsetId of [
    'logo-settings-fieldset',
    'appearance-settings-fieldset',
    'behavior-settings-fieldset',
    'display-settings-fieldset',
  ]) {
    assert.match(html, new RegExp(`<fieldset[^>]+id="${fieldsetId}"`));
  }

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
    assert.match(html, new RegExp(`<label[^>]+for="${inputId}"`));
    assert.match(html, new RegExp(`id="${inputId}"`));
  }

  assert.match(
    html,
    /id="minimum-font-size-input"[^>]+min="1"[^>]+max="12"[^>]+step="0\.25"/,
  );
  assert.match(html, /id="logo-path-input"[^>]+readonly/);
  assert.match(html, /id="settings-dirty-status"[^>]+role="status"/);
  assert.match(html, /id="settings-notice"[^>]+role="alert"/);
  assert.match(html, /id="settings-error"[^>]+role="alert"/);
  assert.match(html, /<button[^>]+id="choose-logo-button"[^>]+type="button"/);
  assert.match(html, /<button[^>]+id="remove-logo-button"[^>]+type="button"/);
  assert.match(html, /<button[^>]+id="load-defaults-button"[^>]+type="button"/);
  assert.match(html, /<button[^>]+id="settings-close-button"[^>]+type="button"/);
  assert.match(html, /<button[^>]+id="save-settings-button"[^>]+type="submit"/);
  assert.match(html, /儲存後[^<]*即時套用/);
  assert.doesNotMatch(html, /第 8 步[^<]*才會套用/);
});

test('第 9 步提供獨立 HDMI 狀態與實際輸出摘要', async () => {
  const html = await readControlFile('index.html');

  assert.match(html, /<section[^>]+id="output-status-panel"[^>]+aria-busy="true"/);
  assert.match(html, /id="hdmi-status-badge"[^>]+data-tone="detecting"/);
  assert.match(html, /id="hdmi-status-text"/);
  assert.match(html, /<dl[^>]+id="output-status-summary"/);

  for (const valueId of [
    'output-target',
    'output-mode',
    'output-display-count',
  ]) {
    assert.match(html, new RegExp(`<dd[^>]+id="${valueId}"`));
  }

  assert.match(
    html,
    /id="output-status-notice"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/,
  );
  assert.match(
    html,
    /id="output-status-error"[^>]+role="alert"[^>]+aria-live="assertive"/,
  );
  assert.match(
    html,
    /<button[^>]+id="manage-output-settings-button"[^>]+data-settings-section="display"[^>]+type="button"/,
  );
  assert.match(html, />\s*管理輸出設定\s*<\/button>/);
  assert.doesNotMatch(html, /future-system-features|future-list|尚未完成/);
  assert.doesNotMatch(html, /HDMI[^<]*第 9 步|輸出螢幕[^<]*第 9 步/);
});

test('第 9 步設定對話框可編輯自動／指定螢幕與 Display 全螢幕', async () => {
  const html = await readControlFile('index.html');

  assert.match(
    html,
    /<input[^>]+id="display-auto-input"[^>]+name="display-selection-mode"[^>]+value="auto"/,
  );
  assert.match(
    html,
    /<input[^>]+id="display-manual-input"[^>]+name="display-selection-mode"[^>]+value="manual"/,
  );
  assert.match(html, /<select[^>]+id="default-display-select"/);
  assert.match(html, /id="default-display-error"[^>]+class="field-error"/);
  assert.match(
    html,
    /<input[^>]+id="display-fullscreen-input"[^>]+type="checkbox"/,
  );
  assert.match(html, /id="display-output-notice"[^>]+role="status"/);
  assert.match(html, /關閉後[^<]*80%[^<]*16:9/);
  assert.doesNotMatch(html, /HDMI 狀態、實體螢幕清單與全螢幕切換將在第 9 步/);
});

test('Control 只載入本機 module，且 Renderer 僅使用最小權限 bridge', async () => {
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

  const subscribePosition = appSource.indexOf('.onPresentationChanged(');
  const snapshotPosition = appSource.indexOf('.getPresentation(');
  assert.ok(subscribePosition >= 0);
  assert.ok(snapshotPosition > subscribePosition);
});

test('Control 樣式具響應式、可存取與精確動效細節', async () => {
  const css = await readControlFile('control.css');

  assert.match(css, /display:\s*grid/);
  assert.match(css, /display:\s*flex/);
  assert.match(css, /@media\s*\([^)]*max-width/);
  assert.match(css, /grid-template-areas:/);
  assert.match(css, /clamp\(/);
  assert.match(css, /min-block-size:\s*2\.75rem/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /text-wrap:\s*balance/);
  assert.match(css, /text-wrap:\s*pretty/);
  assert.match(css, /scale\(0\.96\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.operation-footer\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.message-preview\s*,\s*\.queue-message-text\s*,\s*\.current-message-row\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.current-message\.is-fill-screen\s*{[^}]*white-space:\s*pre-wrap/s);
  assert.match(css, /\.queue-pages\s*{[^}]*overflow(?:-y)?:\s*auto/s);
  assert.match(css, /\.playback-summary\s*{[^}]*display:\s*grid/s);
  assert.match(css, /#settings-dialog\s*{[^}]*max-block-size:/s);
  assert.match(css, /\.settings-dialog-body\s*{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.settings-control-grid\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.settings-switch\s*{[^}]*min-block-size:\s*2\.75rem/s);
  assert.match(css, /input\[type="color"\][^{]*{[^}]*min-block-size:\s*2\.75rem/s);
  assert.match(css, /select[^{]*{[^}]*min-block-size:\s*2\.75rem/s);
  assert.match(css, /\.output-status-summary\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.output-settings-button\s*{[^}]*min-block-size:\s*2\.75rem/s);
  assert.match(css, /\.display-choice\s*{[^}]*min-block-size:\s*2\.75rem/s);
  assert.match(
    css,
    /@media\s*\([^)]*max-width[^)]*\)[\s\S]*\.output-status-summary\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/);
  assert.doesNotMatch(css, /will-change:\s*all\b/);

  const subtleColor = css.match(/--subtle:\s*(#[\da-f]{6})/i)?.[1];
  assert.ok(subtleColor, '必須定義共用次要文字顏色');
  assert.ok(
    contrastRatio(subtleColor, '#ffffff') >= 4.5,
    `${subtleColor} 在白底必須符合 WCAG AA`,
  );
  assert.ok(
    contrastRatio(subtleColor, '#f6f8fb') >= 4.5,
    `${subtleColor} 在次要表面必須符合 WCAG AA`,
  );
});
