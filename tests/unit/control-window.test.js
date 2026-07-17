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
  const [html, appSource] = await Promise.all([
    readControlFile('index.html'),
    readControlFile('app.mjs'),
  ]);

  assert.doesNotMatch(html, /id="operation-welcome-button"|data-operation-message="歡迎光臨"/);
  assert.match(html, /id="operation-quiet-button"[^>]+data-operation-message="請輕聲細語"/);
  assert.match(
    appSource,
    /displayMessage\(\s*\{ message, alignment: 'center' \}/,
  );
  assert.match(html, /待機顯示：時間/);
  assert.doesNotMatch(html, /待機顯示：歡迎光臨與時間/);
  assert.match(appSource, /livePageSummary\.textContent = '待機畫面'/);
  assert.match(html, /<form[^>]+id="message-form"/);
  assert.match(html, /<input[^>]+id="recipient-input"/);
  assert.match(html, /<fieldset[^>]+id="action-fieldset"/);

  for (const action of [
    'go-to-lobby',
    'lobby-code',
    'contact-counter',
    'custom',
  ]) {
    assert.match(
      html,
      new RegExp(`<input[^>]+name="action"[^>]+value="${action}"`),
    );
  }
  assert.match(html, /value="contact-counter"[^>]*>\s*<span>聯絡櫃台<\/span>/);

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

test('右側分離唯讀即時狀態與可獨立分頁、逐筆刪除的顯示清單', async () => {
  const [html, appSource, css] = await Promise.all([
    readControlFile('index.html'),
    readControlFile('app.mjs'),
    readControlFile('control.css'),
  ]);

  assert.match(html, /<section[^>]+id="current-presentation"/);
  assert.match(html, /id="live-page-summary"/);
  assert.match(html, /id="live-message-list"/);
  assert.match(html, /id="display-list-summary"[^>]+tabindex="-1"/);
  assert.match(html, /id="display-message-list"/);
  assert.match(html, /id="display-list-prev"/);
  assert.match(html, /id="display-list-next"/);
  assert.ok(
    html.indexOf('id="display-list-title"') <
      html.indexOf('id="live-status-title"'),
    '可操作的顯示清單必須放在唯讀的電視目前顯示上方',
  );
  assert.match(html, /<button[^>]+id="clear-display-button"[^>]+type="button"/);
  assert.match(html, />\s*全部刪除\s*<\/button>/);
  assert.match(html, /播放第/);
  assert.match(html, /瀏覽第/);
  assert.match(html, /id="operation-status"[^>]+role="status"/);
  assert.match(html, /id="operation-error"[^>]+role="alert"/);
  assert.doesNotMatch(html, /current-revision|Main Process|第 6 步/);
  assert.match(html, /id="message-preview"[^>]+tabindex="0"/);
  assert.match(appSource, /text\.tabIndex\s*=\s*0/);
  assert.match(appSource, /item\.dataset\.messageIndex\s*=/);
  assert.match(appSource, /paginateMessageList/);
  assert.match(appSource, /lastListContentRevision/);
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

test('555 與 888 保留獨立按鈕、確認對話框與無限期顯示提示', async () => {
  const [html, appSource] = await Promise.all([
    readControlFile('index.html'),
    readControlFile('app.mjs'),
  ]);

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
  assert.match(appSource, /顯示 888、清除或送出新的訊息/);
  assert.match(appSource, /直到清除或送出新的訊息/);
  assert.match(appSource, /不受顯示時間限制/);
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

  assert.match(html, /請按「儲存設定」保存變更/);
  assert.match(html, /新設定套用於下一次「顯示」或移除操作/);
  assert.doesNotMatch(html, /調整後可直接關閉|不需儲存/);
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
    'logo-size-percent-input',
    'standby-background-mode-select',
    'standby-background-summary',
    'standby-slide-duration-input',
    'background-color-input',
    'font-family-select',
    'font-color-input',
    'minimum-font-size-input',
    'font-size-percent-input',
    'line-spacing-percent-input',
    'inspection-background-color-input',
    'release-background-color-input',
    'date-time-enabled-input',
    'clock-time-input',
    'clock-time-error',
    'render-resolution-select',
    'render-resolution-error',
    'marquee-enabled-input',
  ]) {
    assert.match(html, new RegExp(`id="${inputId}"`));
  }
  assert.match(html, /Logo 與待機背景/);
  const logoFieldset = html.match(
    /<fieldset[^>]+id="logo-settings-fieldset"[\s\S]*?<\/fieldset>/,
  )?.[0] ?? '';
  assert.match(logoFieldset, /<label[^>]+for="logo-size-percent-input"[^>]*>\s*Logo 大小（%）\s*<\/label>/);
  assert.match(
    logoFieldset,
    /<input[^>]+id="logo-size-percent-input"[^>]+type="number"[^>]+min="50"[^>]+max="1000"[^>]+step="5"[^>]+aria-describedby="logo-size-percent-help logo-size-percent-error"/,
  );
  assert.match(
    logoFieldset,
    /id="logo-size-percent-help"[^>]*>[^<]*一般訊息[^<]*待機[^<]*Logo[^<]*亮白輪廓[^<]*亮白底襯/,
  );
  assert.match(logoFieldset, /id="logo-size-percent-error"[^>]+class="field-error"[^>]+hidden/);
  assert.equal(
    (html.match(/id="logo-size-percent-input"/g) ?? []).length,
    1,
    'Logo 大小只保留一個緊湊數字欄位',
  );
  assert.match(html, /id="choose-standby-background-button"/);
  assert.match(html, /id="remove-standby-background-button"/);
  assert.match(html, /id="standby-background-mode-select"/);
  assert.match(html, /value="fixed"/);
  assert.match(html, /value="slideshow"/);
  assert.match(
    html,
    /id="standby-slide-duration-input"[^>]+min="1"[^>]+max="3600"/,
  );
  assert.match(html, /重新選擇[^<]*取代/);
  assert.doesNotMatch(html, /背景圖片清單|縮圖|調整順序/);
  assert.doesNotMatch(html, /id="standby-background-enabled-input"/);
  assert.doesNotMatch(html, /id="hour12-input"|12 小時制/);
  assert.match(html, /訊息播放時顯示時間/);
  assert.match(html, /待機畫面固定顯示時間/);
  assert.doesNotMatch(html, /待機歡迎畫面/);
  assert.match(html, /時間固定顯示為 24 小時 HH:mm:ss/);
  assert.match(html, /套用於一般訊息、待機時間，以及 555／888/);
  assert.match(html, /營運訊息縮字下限（rem）/);
  assert.match(html, /一般訊息過長時使用；關閉則水平壓縮/);
  assert.match(html, /只校正 DisplayCore 顯示，不修改 Windows 系統時間/);
  for (const resolution of [
    'auto',
    '1366x768',
    '1600x900',
    '1920x1080',
    '2560x1440',
    '3840x2160',
  ]) {
    assert.match(html, new RegExp(`value="${resolution}"`));
  }
  assert.match(html, /HDMI 實際輸出解析度仍由 Windows 顯示設定控制/);
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
