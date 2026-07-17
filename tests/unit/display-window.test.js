'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

async function readDisplayFile(fileName) {
  return readFile(path.join(projectRoot, 'display', fileName), 'utf8');
}

test('Display HTML 只有唯讀顯示舞台、互斥視覺層與單一語意狀態來源', async () => {
  const html = await readDisplayFile('index.html');

  assert.match(html, /<main[^>]+id="display-stage"/);
  assert.match(html, /id="display-render-surface"/);
  assert.match(html, /id="display-announcement"[^>]+role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /id="normal-layer"[^>]+aria-hidden="true"/);
  assert.match(html, /id="standby-layer"[^>]+aria-hidden="true"/);
  assert.match(html, /id="standby-message"[^>]*>\s*歡迎光臨\s*</);
  assert.match(html, /id="display-chrome"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<img[^>]+id="display-logo"[^>]+alt=""[^>]+aria-hidden="true"/,
  );
  assert.match(html, /<time[^>]+id="display-clock"[^>]+aria-hidden="true"/);
  assert.match(html, /id="page-layer"[^>]+aria-hidden="true"/);
  assert.match(html, /id="fill-layer"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<script[^>]+type="module"[^>]+src="\.\/app\.mjs"[^>]*><\/script>/,
  );
  assert.doesNotMatch(html, />\s*DisplayCore\s*</);
  assert.doesNotMatch(
    html,
    /<(?:button|input|select|textarea|a|video|audio)\b/i,
  );
  assert.doesNotMatch(html, /\b(?:tabindex|contenteditable)\s*=/i);
  assert.match(html, /img-src 'self'/);
  assert.doesNotMatch(html, /img-src[^;]*(?:data:|file:|blob:|\*)/);
});

test('Display CSS 使用 viewport 比例、安全區、單行與滿屏 grid，不截斷文字', async () => {
  const css = await readDisplayFile('display.css');

  assert.match(css, /overflow:\s*hidden/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /user-select:\s*none/);
  assert.match(css, /cursor:\s*none/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /clamp\(/);
  assert.match(css, /(?:vw|vh|vmin|rem|%)/);
  assert.match(css, /\.page-layer\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.display-render-surface\s*{[^}]*container-type:\s*size/s);
  assert.match(css, /\.display-render-surface\s*{[^}]*transform:/s);
  assert.match(css, /(?:cqw|cqh|cqmin)/);
  assert.match(css, /\.normal-layer\s*{[^}]*position:\s*relative/s);
  assert.match(css, /\.display-logo\s*{[^}]*object-fit:\s*contain/s);
  assert.match(css, /\.display-clock\s*{[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(css, /\.display-clock\s*{[^}]*position:\s*absolute[^}]*inset-inline-end:/s);
  assert.match(css, /\.display-clock\s*{[^}]*inset-block-end:/s);
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.normal-layer\s*{[^}]*place-content:\s*center/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*position:\s*static[^}]*text-align:\s*center/s,
  );
  assert.match(
    css,
    /\.standby-message\s*{[^}]*calc\(14cqmin \* var\(--message-font-scale\)\)/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*calc\(7cqmin \* var\(--message-font-scale\)\)/s,
  );
  assert.match(css, /\.message-row\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.message-row\s*{[^}]*justify-content:\s*flex-start[^}]*text-align:\s*left/s);
  assert.match(css, /\.message-row\[data-alignment="center"\]/);
  assert.match(css, /\.fill-layer\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.fill-layer\s*{[^}]*position:\s*absolute[^}]*inset:\s*0/s);
  assert.match(css, /--display-font-family/);
  assert.match(css, /--message-line-spacing-scale/);
  assert.match(css, /--emergency-background/);
  assert.match(css, /--viewport-background/);
  assert.match(css, /body\s*{[^}]*background:\s*var\(--viewport-background\)/s);
  assert.match(css, /\.is-marquee\s+\.marquee-track\s*{[^}]*will-change:\s*transform/s);
  assert.match(css, /font-smoothing:\s*antialiased/);
  assert.doesNotMatch(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/);
  assert.doesNotMatch(css, /will-change:\s*all\b/);
});

test('Display app 僅使用最小權限 bridge 與 textContent，且不解析緊急代碼語意', async () => {
  const source = await readDisplayFile('app.mjs');

  assert.match(source, /window\.displayCoreDisplay/);
  assert.match(source, /createDisplayController/);
  assert.match(source, /createDisplaySettingsController/);
  assert.match(source, /createDisplayClock/);
  assert.match(source, /resolveRenderResolution/);
  assert.match(source, /createPageProgressReporter/);
  assert.match(source, /SAFE_DISPLAY_SETTINGS/);
  assert.match(source, /findLargestFittingFontSize/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /renderResolution/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /document\.fonts\.ready/);
  assert.match(source, /bridge\.getSettings\(\)/);
  assert.match(source, /bridge\.onSettingsChanged\(listener\)/);
  assert.match(source, /bridge\.reportPageProgress\(\.\.\.args\)/);
  assert.match(source, /bridge\.onRefitRequested\(handleRefitRequested\)/);
  assert.match(source, /sessionStorage\.getItem/);
  assert.match(source, /sessionStorage\.setItem/);
  assert.doesNotMatch(source, /prefers-reduced-motion/);
  assert.match(source, /\.setProperty\(\s*'--display-background'/);
  assert.match(source, /\.setProperty\(\s*'--display-font-family'/);
  assert.match(source, /row\.dataset\.alignment\s*=\s*alignment/);
  assert.match(source, /snapshot\.emergencyTone/);
  assert.match(source, /'--message-line-spacing-scale'/);
  assert.match(source, /'--message-font-scale'/);
  assert.match(source, /'--emergency-background'/);
  assert.match(source, /'--viewport-background'/);
  assert.match(
    source,
    /function updateAnnouncement\([^)]*\)\s*{[\s\S]*?setAttribute\('aria-live', priority\);[\s\S]*?\.textContent\s*=\s*message;/,
  );
  assert.match(source, /updateAnnouncement\([^;]+,\s*'polite'\);/s);
  assert.match(source, /updateAnnouncement\(message,\s*'assertive'\);/s);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b/);
  assert.doesNotMatch(source, /555|888/);
  assert.doesNotMatch(source, /showEmergency|startProgram|clearPresentation/);
});
